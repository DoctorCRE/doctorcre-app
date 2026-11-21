import { createRequestBudget } from './request-budget.mjs';
import { resolveDealroomBoot } from './boot-mode.js';
import { clearPrivateStorage, offlineTourSession, sessionEpoch, SESSION_EPOCH_KEY } from './offline-tour-session.js';

// Twice the 60 s poll, so a steady tab checks once per window. Denials still
// end the view at once, and every /mcp POST carries the verified CSRF token,
// which the server refuses once the cookie changes.
export const SESSION_TRUST_MS = 2 * 60_000;
const PARTNER_SIGN_IN_HEADER = 'x-doctorcre-partner-sign-in';

export function createSessionBoundary({ fetchImpl, invalidate, epoch = () => '', acceptSession = async () => true, anonymousDiagnostics = false, now = () => performance.now() }) {
  let binding = null, generation = 0, revoked = false, checking = null, trusted = null;
  let engineSessionSeen = false;
  const active = new Set();
  const failure = () => Object.assign(new Error('Sign in to continue'), { status: 401, code: 'authentication_required' });
  function revoke(reason = 'denied') {
    if (revoked) return;
    revoked = true; generation++;
    for (const controller of active) controller.abort();
    active.clear(); binding = null;
    invalidate(reason, engineSessionSeen);
  }
  function current(ticket, startedEpoch) {
    if (startedEpoch !== epoch()) revoke('session-changed');
    if (revoked || ticket !== generation) throw failure();
  }
  async function verify({ fresh = false, waitForBudget = false } = {}) {
    if (revoked) throw failure();
    if (!fresh && trusted && now() - trusted.at < SESSION_TRUST_MS) return trusted;
    if (!fresh && checking) return checking;
    const ticket = generation, startedEpoch = epoch(), startedAt = now();
    const pending = (async () => {
      const response = await fetchImpl('/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }, { waitForBudget });
      const signIn = response.headers.get(PARTNER_SIGN_IN_HEADER);
      engineSessionSeen ||= signIn === 'engine';
      if ([401,403].includes(response.status)) { if (!(anonymousDiagnostics && !binding)) revoke(); throw failure(); }
      if (!response.ok) throw new Error('Session verification unavailable');
      const session = await response.json();
      current(ticket, startedEpoch);
      if (typeof session?.actor?.slug !== 'string' || !session.actor.slug || typeof session.csrf_token !== 'string' || !session.csrf_token) throw new Error('Session verification unavailable');
      const next = JSON.stringify([session.actor.slug, session.csrf_token]);
      if (binding && next !== binding) { revoke('session-changed'); throw failure(); }
      if (!await acceptSession(session, engineSessionSeen)) { revoke('session-changed'); throw failure(); }
      current(ticket, startedEpoch);
      binding = next;
      trusted = { session, at: startedAt, signIn, epoch: startedEpoch };
      return trusted;
    })().finally(() => { if (checking === pending) checking = null; });
    checking = pending;
    return pending;
  }
  return {
    revoke,
    async verify(options) { return (await verify(options)).session; },
    get revoked() { return revoked; },
    get verified() { return Boolean(trusted); },
    get engineSignIn() { return !revoked && trusted?.signIn === 'engine'; },
    async fetch(path, init = {}, { boundRead = false, waitForBudget = false } = {}) {
      // Writes read the session to scope themselves; that read is a fresh, bound check.
      if (path === '/auth/session') {
        const { session, signIn } = await verify({ fresh: true, waitForBudget });
        return Response.json(session, signIn ? { headers: { [PARTNER_SIGN_IN_HEADER]: signIn } } : undefined);
      }
      // Bound reads are for URLs whose records belong to the already verified partner.
      if (boundRead && (!trusted || (init.method ?? 'GET') !== 'GET')) throw failure();
      const ticket = generation, startedEpoch = boundRead ? trusted.epoch : epoch();
      current(ticket, startedEpoch);
      const { session } = boundRead ? trusted : await verify({ waitForBudget });
      current(ticket, startedEpoch);
      const controller = new AbortController(); active.add(controller);
      const cancel = () => controller.abort();
      init.signal?.addEventListener('abort', cancel, { once: true });
      if (init.signal?.aborted) cancel();
      try {
        const headers = new Headers(init.headers);
        if (!['GET','HEAD'].includes((init.method || 'GET').toUpperCase())) {
          if (headers.has('x-carr-csrf') && headers.get('x-carr-csrf') !== session.csrf_token) { revoke('session-changed'); throw failure(); }
          headers.set('x-carr-csrf', session.csrf_token);
        }
        const response = await fetchImpl(path, { ...init, headers, cache: 'no-store', redirect: 'error', signal: controller.signal }, { waitForBudget });
        // Even an older read's denial revokes the entire view.
        if ([401,403].includes(response.status)) { revoke(); throw failure(); }
        const bytes = await response.arrayBuffer();
        let refused = false;
        try {
          const envelope = JSON.parse(new TextDecoder().decode(bytes));
          const payload = envelope?.result?.isError ? JSON.parse(envelope.result.content?.find(item => item.type === 'text')?.text || '{}') : envelope;
          refused = ['unauthorized','not_authenticated','forbidden','permission_denied','authentication_required','authorization_refused','session_expired'].includes(String(payload?.error || '').toLowerCase());
        } catch { /* Payload validation belongs to the existing domain adapter. */ }
        if (refused) { revoke(); throw failure(); }
        current(ticket, startedEpoch);
        return new Response([204,205,304].includes(response.status) ? null : bytes, {status:response.status,statusText:response.statusText,headers:response.headers});
      } finally { active.delete(controller); init.signal?.removeEventListener('abort', cancel); }
    },
  };
}

function mountSessionPause(win) {
  const { document } = win;
  const paused = document.createElement('aside'), refresh = document.createElement('button');
  const message = document.createTextNode('');
  const fenced = new Set();
  let budgetNotice;
  paused.setAttribute('role', 'status');
  paused.style.cssText = 'position:fixed;visibility:visible;inset:1rem 1rem auto;z-index:2147483647;padding:1rem;border:1px solid;background:Canvas;color:CanvasText';
  refresh.type = 'button'; refresh.textContent = 'Refresh page'; refresh.onclick = () => win.location.reload();
  refresh.hidden = true;
  paused.append(message, ' ', refresh);
  function render() {
    message.textContent = budgetNotice ?? (refresh.hidden ? '' : 'Updates paused. Showing last loaded data.');
    if (!message.textContent) paused.remove();
    else if (!paused.isConnected) document.body.prepend(paused);
  }
  return {
    budget(notice) { budgetNotice = notice; render(); },
    setUnavailable(unavailable) {
      refresh.hidden = !unavailable;
      if (unavailable) {
        for (const node of document.body.children) if (node !== paused && !node.inert) fenced.add(node);
      }
      for (const node of fenced) node.inert = unavailable;
      if (!unavailable) fenced.clear();
      render();
    },
  };
}

let browserBoundary, browserRequests, browserPause;
function browserFetch(path, init, budgetOptions) {
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return globalThis.fetch(path, init);
  return (browserRequests ??= createRequestBudget({
    fetchImpl: (...args) => window.fetch(...args),
    onPauseChange: notice => (browserPause ??= mountSessionPause(window)).budget(notice),
  })).fetch(path, init, budgetOptions);
}
export function privateSession() {
  if (browserBoundary) return browserBoundary;
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return null;
  const win = window, root = win.document.documentElement;
  const { pathname } = win.location;
  const returnQuery = /^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(pathname) ? `?return_to=${encodeURIComponent(pathname)}` : '';
  const sessionEndedUrl = '/public-shell/session-ended.html' + returnQuery;
  const initialEpoch = sessionEpoch(win);
  let anonymousDiagnostics = false;
  try { anonymousDiagnostics = win.location.pathname === '/status' && !win.localStorage.getItem('doctorcre-session-binding-v1'); } catch {}
  browserBoundary = createSessionBoundary({ anonymousDiagnostics, epoch: () => sessionEpoch(win),
    fetchImpl: browserFetch,
    async acceptSession(session, engineSession) {
      const bytes = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([session.actor.slug,session.csrf_token])));
      const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('');
      try {
        const previous = win.localStorage.getItem('doctorcre-session-binding-v1');
        if (previous && previous !== digest) {
          if (engineSession) browserBoundary.revoke('reload-after-sign-in');
          return false;
        }
        // Unbound data from older app versions must never be adopted by the
        // first principal to bootstrap this browser.
        if (!previous) await clearPrivateStorage(win);
        win.localStorage.setItem('doctorcre-session-binding-v1',digest);
      } catch { /* Storage-denied browsers cannot restore private offline state. */ }
      return true;
    },
    invalidate(reason, engineSession) {
      // Clear before async cleanup/navigation so private text and controls
      // disappear immediately, including detached dialogs and account labels.
      win.dispatchEvent(new win.Event('doctorcre-session-invalidated'));
      const retiredDocument = win.document;
      const cleanup = offlineTourSession(win).revoke({ expectedEpoch: engineSession ? initialEpoch : undefined });
      const reload = reason === 'reload-after-sign-in';
      const view = win.document.createElement('main');
      const title = win.document.createElement('h1');
      title.textContent = reload ? 'Opening your workspace' : reason === 'signed-out' ? 'Signed out' : 'Session ended';
      const link = win.document.createElement('a'); link.href = '/auth/login' + returnQuery; link.textContent = 'Sign in again';
      win.document.title = reload ? title.textContent : 'Session ended';
      view.append(title);
      if (!reload) view.append(link);
      win.document.body.replaceChildren(view);
      // The new document releases controller closures, pending commands,
      // editor drafts, Doc context, media objects, and actor labels together.
      void cleanup.finally(() => {
        if (win.document !== retiredDocument) return;
        if (reload) win.location.reload();
        else win.location.replace(sessionEndedUrl);
      });
    },
  });
  const { verify, fetch } = browserBoundary;
  let starting, restart;
  browserBoundary.verify = options => starting ?? verify(options);
  browserBoundary.fetch = (...args) => starting ? starting.then(() => fetch(...args)) : fetch(...args);
  function start() {
    if (browserBoundary.revoked) { win.location.replace(sessionEndedUrl); return; }
    if (sessionEpoch(win) !== initialEpoch) { browserBoundary.revoke('session-changed'); return; }
    if (starting) { restart = true; return; }
    const cached = browserBoundary.verified;
    if (cached) root.style.visibility = 'hidden';
    starting = (async () => {
      let session;
      // eslint-disable-next-line no-restricted-syntax -- A single queued startup shares the document request budget with the active startup.
      do {
        restart = false;
        session = await verify({ fresh: true, waitForBudget: true }).catch(() => null);
      } while (restart && !browserBoundary.revoked);
      starting = null;
      root.style.visibility = '';
      if (cached && !browserBoundary.revoked) (browserPause ??= mountSessionPause(win)).setUnavailable(!session);
      if (!session) throw new Error('Session verification unavailable');
      win.dispatchEvent(new win.CustomEvent('doctorcre-session-ready', { detail: { cached } }));
      return session;
    })();
    void starting.catch(() => {});
  }
  win.addEventListener('storage', event => { if (event.key === SESSION_EPOCH_KEY && sessionEpoch(win) !== initialEpoch) browserBoundary.revoke('session-changed'); });
  // eslint-disable-next-line no-restricted-syntax -- A single active startup verifies through the document request budget.
  win.addEventListener('pageshow', event => { if (event.persisted) start(); });
  start();
  return browserBoundary;
}

export async function sessionFetch(path, init) {
  // Release identity is public diagnostic metadata, including on signed-out
  // /status. It carries no actor or record data and needs no private lifetime.
  if (typeof window !== 'undefined' && window.location?.href && new URL(path,window.location.href).pathname === '/app-release') return browserFetch(path,init);
  const boundary = privateSession();
  try { return await (boundary?.fetch ?? browserFetch)(path,init); }
  catch (error) {
    // Retired page controllers cannot repaint or issue a retry while the
    // replacement document is loading. Caller deadlines still cancel reads.
    if (boundary?.revoked) return new Promise(() => {});
    throw error;
  }
}

export async function fetchPartnerIdentity(init, fetchImpl = sessionFetch) {
  const response = await fetchImpl('/auth/session', init);
  if (!response.ok || response.headers.get(PARTNER_SIGN_IN_HEADER) === 'engine') return response;
  void response.body?.cancel().catch(() => {});
  init.signal?.throwIfAborted();
  return fetchImpl('/api/system-work/session', init);
}
