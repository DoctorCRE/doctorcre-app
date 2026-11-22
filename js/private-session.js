import { createRequestBudget } from './request-budget.mjs';
import { invoiceReturnPath, resolveDealroomBoot, sessionReturnPath } from './boot-mode.js';
import { clearPrivateStorage, offlineTourSession, sessionEpoch, SESSION_EPOCH_KEY, TOUR_SIGN_IN_EPOCH_KEY } from './offline-tour-session.js';

// Twice the 60 s poll, so a steady tab checks once per window. Denials still
// end the view at once, and every /mcp POST carries the verified CSRF token,
// which the server refuses once the cookie changes.
export const SESSION_TRUST_MS = 2 * 60_000;
const PARTNER_SIGN_IN_HEADER = 'x-doctorcre-partner-sign-in';
const PRIVATE_DRAFT_PREFIX = 'doctorcre:draft:';

export function privateTextDraft(win, actor, ...scope) {
  const key = actor ? PRIVATE_DRAFT_PREFIX + JSON.stringify([actor, ...scope]) : null;
  return {
    read() {
      try { return key ? win.sessionStorage.getItem(key) ?? '' : ''; }
      catch { return ''; }
    },
    write(text, { evictOnFailure = false } = {}) {
      if (!key) return;
      try {
        if (text) win.sessionStorage.setItem(key, text);
        else win.sessionStorage.removeItem(key);
      } catch {
        if (!evictOnFailure) return;
        try { win.sessionStorage.removeItem(key); }
        catch { /* Storage may be blocked even for deletion. */ }
      }
    },
  };
}

export function clearPrivateTextDrafts(win, actor) {
  if (!actor) return;
  const actorKey = PRIVATE_DRAFT_PREFIX + JSON.stringify([actor]);
  const prefix = actorKey.slice(0, -1) + ',';
  try {
    const storage = win.sessionStorage;
    for (const key of Object.keys(storage)) {
      if (key === actorKey || key.startsWith(prefix)) storage.removeItem(key);
    }
  } catch { /* Private storage may be blocked. */ }
}

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

let browserBoundary, browserRequests, browserPause;
function showBudgetPause(document, notice) {
  if (!notice) {
    browserPause?.remove();
    return;
  }
  if (!browserPause) {
    browserPause = document.createElement('aside');
    browserPause.setAttribute('role', 'status');
    browserPause.style.cssText = 'position:fixed;visibility:visible;inset:1rem 1rem auto;z-index:2147483647;padding:1rem;border:1px solid;background:Canvas;color:CanvasText';
  }
  browserPause.textContent = notice;
  if (!browserPause.isConnected) document.body.prepend(browserPause);
}

function browserFetch(path, init, budgetOptions) {
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return globalThis.fetch(path, init);
  return (browserRequests ??= createRequestBudget({
    fetchImpl: (...args) => window.fetch(...args),
    onPauseChange: notice => showBudgetPause(window.document, notice),
  })).fetch(path, init, budgetOptions);
}
export function privateSession() {
  if (browserBoundary) return browserBoundary;
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return null;
  const win = window;
  const { pathname } = win.location;
  const initialEpoch = sessionEpoch(win);
  let anonymousDiagnostics = false;
  try { anonymousDiagnostics = win.location.pathname === '/status' && !win.localStorage.getItem('doctorcre-session-binding-v1'); } catch {}
  let draftSession = null;
  browserBoundary = Object.assign(createSessionBoundary({ anonymousDiagnostics, epoch: () => sessionEpoch(win),
    async fetchImpl(path, init, budgetOptions) {
      const response = await browserFetch(path, init, budgetOptions);
      if (pathname === '/tours/day.html' && path === '/auth/session' && response.headers.get(PARTNER_SIGN_IN_HEADER) === 'engine') {
        // The Tours entry is outside the old worker's scope.
        win.location.replace('/tours' + win.location.search);
        void response.body?.cancel().catch(() => {});
        throw new Error('Tour day moved');
      }
      return response;
    },
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
        draftSession = { actor: session.actor.slug, digest };
      } catch { /* Storage-denied browsers cannot restore private offline state. */ }
      return true;
    },
    invalidate(reason) {
      const url = new URL(win.location.href);
      const returnTo = url.pathname === '/invoices' ? invoiceReturnPath(url.searchParams) : sessionReturnPath(url.pathname);
      const returnQuery = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
      // Clear before async cleanup/navigation so private text and controls
      // disappear immediately, including detached dialogs and account labels.
      win.dispatchEvent(new win.Event('doctorcre-session-invalidated'));
      const retiredDocument = win.document;
      const cleanup = offlineTourSession(win).revoke({ expectedEpoch: initialEpoch });
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
        else win.location.replace('/public-shell/session-ended.html' + returnQuery);
      });
    },
  }), {
    textDraft(...scope) {
      const active = !browserBoundary.revoked && initialEpoch !== null && sessionEpoch(win) === initialEpoch;
      return privateTextDraft(win, active ? draftSession?.actor : null, draftSession?.digest, initialEpoch, ...scope);
    },
  });
  win.addEventListener('storage', event => {
    if (event.key !== SESSION_EPOCH_KEY && event.key !== TOUR_SIGN_IN_EPOCH_KEY) return;
    if (sessionEpoch(win) === initialEpoch) return;
    browserBoundary.revoke('session-changed');
  });
  // eslint-disable-next-line no-restricted-syntax -- A cached Back return navigates once and leaves session reads to normal boot.
  win.addEventListener('pageshow', event => { if (event.persisted) win.location.reload(); });
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
