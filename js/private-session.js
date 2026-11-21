import { createRequestBudget } from './request-budget.mjs';
import { mountVisibilityPoll } from './visibility-poll.mjs';
// A browser lifetime belongs to one verified server session. Re-bootstrap in a
// new document after revocation; never reuse old controllers for a new actor.
import { resolveDealroomBoot } from './boot-mode.js';
import { clearPrivateStorage, offlineTourSession, sessionEpoch, SESSION_EPOCH_KEY } from './offline-tour-session.js';

// Twice the 60 s poll, so a steady tab checks once per window. Denials still
// end the view at once, and every /mcp POST carries the verified CSRF token,
// which the server refuses once the cookie changes.
export const SESSION_TRUST_MS = 2 * 60_000;

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
  async function verify({ fresh = false } = {}) {
    if (revoked) throw failure();
    if (!fresh && trusted && now() - trusted.at < SESSION_TRUST_MS) return trusted.session;
    if (!fresh && checking) return checking;
    const ticket = generation, startedEpoch = epoch(), startedAt = now();
    const pending = (async () => {
      const response = await fetchImpl('/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      const engineSignIn = response.headers.get('x-doctorcre-partner-sign-in') === 'engine';
      engineSessionSeen ||= engineSignIn;
      if ([401,403].includes(response.status)) { if (!(anonymousDiagnostics && !binding)) revoke(); throw failure(); }
      if (!response.ok) throw new Error('Session verification unavailable');
      const session = await response.json();
      current(ticket, startedEpoch);
      if (typeof session?.actor?.slug !== 'string' || !session.actor.slug || typeof session.csrf_token !== 'string' || !session.csrf_token) throw new Error('Session verification unavailable');
      const next = JSON.stringify([session.actor.slug, session.csrf_token]);
      if (binding && next !== binding) { revoke('session-changed'); throw failure(); }
      if (!await acceptSession(session, engineSessionSeen)) { revoke('session-changed'); throw failure(); }
      current(ticket, startedEpoch);
      binding = next; trusted = { session, at: startedAt, engineSignIn, epoch: startedEpoch };
      return session;
    })().finally(() => { if (checking === pending) checking = null; });
    checking = pending;
    return pending;
  }
  return {
    revoke, verify,
    get revoked() { return revoked; },
    get engineSignIn() { return !revoked && trusted?.engineSignIn === true; },
    async fetch(path, init = {}, { boundRead = false } = {}) {
      // Writes read the session to scope themselves; that read is a fresh, bound check.
      if (path === '/auth/session') return Response.json(await verify({ fresh: true }));
      // Bound reads are for URLs whose records belong to the already verified partner.
      if (boundRead && (!trusted || (init.method ?? 'GET') !== 'GET')) throw failure();
      const ticket = generation, startedEpoch = boundRead ? trusted.epoch : epoch();
      current(ticket, startedEpoch);
      const session = boundRead ? trusted.session : await verify();
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
        const response = await fetchImpl(path, { ...init, headers, cache: 'no-store', redirect: 'error', signal: controller.signal });
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
  const fenced = new Map();
  let budgetNotice = null, restoreUnavailable = false;
  paused.setAttribute('role', 'status');
  paused.style.cssText = 'position:fixed;inset:1rem 1rem auto;z-index:2147483647;padding:1rem;border:1px solid;background:Canvas;color:CanvasText';
  refresh.type = 'button'; refresh.textContent = 'Refresh page'; refresh.onclick = () => win.location.reload();
  paused.append(message, refresh);
  function render() {
    paused.toggleAttribute('data-session-restore-paused', restoreUnavailable);
    refresh.hidden = !restoreUnavailable;
    if (restoreUnavailable) {
      Array.from(document.body.children).forEach(node => {
        if (node === paused) return;
        if (!fenced.has(node)) fenced.set(node, node.inert);
        node.inert = true;
      });
    } else {
      fenced.forEach((inert, node) => { node.inert = inert; });
      fenced.clear();
    }
    if (budgetNotice || restoreUnavailable) {
      message.textContent = (budgetNotice ?? 'Updates paused. Showing last loaded data.') + (restoreUnavailable ? ' ' : '');
      if (!paused.isConnected) document.body.prepend(paused);
    } else paused.remove();
  }
  return {
    budget(notice) { budgetNotice = notice; render(); },
    restore(unavailable) { restoreUnavailable = unavailable; render(); },
  };
}

let browserBoundary, browserRequests, browserPause;
function browserFetch(path, init) {
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return globalThis.fetch(path, init);
  const pause = browserPause ??= mountSessionPause(window);
  browserRequests ||= createRequestBudget({
    document: window.document,
    fetchImpl: (...args) => window.fetch(...args),
    onPauseChange: pause.budget,
  });
  return browserRequests.fetch(path, init);
}
export function privateSession() {
  if (browserBoundary) return browserBoundary;
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return null;
  const win = window;
  const pause = browserPause ??= mountSessionPause(win);
  const returnTo = /^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(win.location.pathname) ? win.location.pathname : null;
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
      browserRequests?.dispose();
      win.dispatchEvent(new win.Event('doctorcre-session-invalidated'));
      const retiredDocument = win.document;
      const cleanup = offlineTourSession(win).revoke({ expectedEpoch: engineSession ? initialEpoch : undefined });
      const reload = reason === 'reload-after-sign-in';
      const view = win.document.createElement('main');
      const title = win.document.createElement('h1');
      title.textContent = reload ? 'Opening your workspace' : reason === 'signed-out' ? 'Signed out' : 'Session ended';
      const loginHref = returnTo ? `/auth/login?return_to=${encodeURIComponent(returnTo)}` : '/auth/login';
      const link = win.document.createElement('a'); link.href = loginHref; link.textContent = 'Sign in again';
      win.document.title = reload ? title.textContent : 'Session ended';
      view.append(title);
      if (!reload) view.append(link);
      win.document.body.replaceChildren(view);
      // The new document releases controller closures, pending commands,
      // editor drafts, Doc context, media objects, and actor labels together.
      void cleanup.finally(() => {
        if (win.document !== retiredDocument) return;
        if (reload) win.location.reload();
        else win.location.replace(returnTo ? `/public-shell/session-ended.html?return_to=${encodeURIComponent(returnTo)}` : '/public-shell/session-ended.html');
      });
    },
  });
  let restoreGeneration = 0;
  const finishRestore = (generation, unavailable) => {
    if (generation !== restoreGeneration) return;
    if (!browserBoundary.revoked) pause.restore(unavailable);
    win.document.documentElement.style.visibility = '';
  };
  const restore = mountVisibilityPoll({ document: win.document, window: win, periodic: false, poll: async () => {
    const generation = restoreGeneration;
    try {
      const session = await browserBoundary.verify({ fresh: true });
      finishRestore(generation, false);
      return session;
    } catch (error) {
      // A persisted pageshow has its own fallback when the budget blocks verification.
      if (error?.code !== 'request_budget_exhausted') finishRestore(generation, true);
      throw error;
    }
  } });
  win.addEventListener('storage', event => { if (event.key === SESSION_EPOCH_KEY && sessionEpoch(win) !== initialEpoch) browserBoundary.revoke('session-changed'); });
  // eslint-disable-next-line no-restricted-syntax -- Restored pages verify once per persisted pageshow before unlocking controls; the document request budget limits the verifier.
  win.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (browserBoundary.revoked) { win.location.replace(returnTo ? `/public-shell/session-ended.html?return_to=${encodeURIComponent(returnTo)}` : '/public-shell/session-ended.html'); return; }
    if (sessionEpoch(win) !== initialEpoch) { browserBoundary.revoke('session-changed'); return; }
    const generation = ++restoreGeneration;
    win.document.documentElement.style.visibility = 'hidden';
    // Revalidation waits for an older poll, then reads for this restore.
    void restore.revalidate().then(session => finishRestore(generation, !session));
  });
  return browserBoundary;
}

export async function sessionFetch(path, init) {
  // Release identity is public diagnostic metadata, including on signed-out
  // /status. It carries no actor or record data and needs no private lifetime.
  if (typeof window !== 'undefined' && window.location?.href && new URL(path,window.location.href).pathname === '/app-release') return browserFetch(path,init);
  const boundary = privateSession();
  if (!boundary) return browserFetch(path,init);
  try { return await boundary.fetch(path,init); }
  catch (error) {
    // Retired page controllers cannot repaint or issue a retry while the
    // replacement document is loading. Caller deadlines still cancel reads.
    if (boundary.revoked) return new Promise(() => {});
    throw error;
  }
}
