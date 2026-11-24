// Visible about five seconds in all: the hold, then the fade.
const SUCCESS_HOLD_MS = 4_200;
const FADE_MS = 800;

let active = null;

function timer(callback, delay, state) {
  // eslint-disable-next-line no-restricted-syntax -- Each toast schedules a max of two callbacks: 4200ms hold then 800ms fade, or one 5000ms undo expiry; replacement calls clearTimeout for all handles.
  const handle = setTimeout(callback, delay);
  handle?.unref?.();
  state.timers.push(handle);
  return handle;
}

function clear(state) {
  for (const handle of state?.timers || []) clearTimeout(handle);
  if (state) state.timers.length = 0;
}

function remove(state) {
  clear(state);
  state?.observer?.disconnect();
  state?.node.remove();
  if (active === state) active = null;
}

function place(state, doc) {
  const modals = [...doc.querySelectorAll('dialog[open]')].filter(dialog => dialog.matches(':modal'));
  const focused = modals.find(dialog => dialog.contains(doc.activeElement));
  const host = focused || modals.at(-1) || doc.body;
  if (state.node.parentElement !== host) host.append(state.node);
  // A popover escapes the detail panel's transformed, scrolling containing block.
  // It stays a modal descendant so its actions remain in the modal focus scope.
  if (state.node.showPopover && !state.node.matches(':popover-open')) state.node.showPopover();
}

/** `eventId` offers the change-receipt Undo; `onUndo` offers an Undo the caller performs. */
export function showToast(message, { eventId = null, onUndo = null, error = false, preserveUndo = false } = {}) {
  const doc = globalThis.document;
  if (!doc?.body) return null;
  if (preserveUndo && !eventId && !error && active?.undo && !active.undo.disabled) return active.node;
  if (active) remove(active);
  doc.querySelectorAll('.toast').forEach((node) => node.remove());

  const state = { node: doc.createElement('div'), timers: [] };
  const node = state.node;
  active = state;
  node.id = 'toast';
  node.dataset.transient = '';
  node.className = 'toast show';
  node.setAttribute('role', error ? 'alert' : 'status');
  node.setAttribute('aria-atomic', 'true');
  const text = doc.createElement('span');
  text.textContent = String(message ?? '');
  node.append(text);

  let undo = null;
  const receiptUndo = eventId !== null && eventId !== undefined && String(eventId);
  if (receiptUndo || onUndo) {
    undo = doc.createElement('button');
    undo.type = 'button';
    undo.className = 'receipt-undo';
    undo.textContent = 'Undo';
    if (receiptUndo) undo.dataset.undo = String(eventId);
    else undo.addEventListener('click', () => { remove(state); onUndo(); }, { once: true });
    node.append(undo);
    state.undo = undo;
  }

  if (error) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'receipt-undo';
    close.dataset.toastClose = '';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = 'Close';
    close.addEventListener('click', () => remove(state), { once: true });
    node.append(close);
  }

  if (node.showPopover) node.setAttribute('popover', 'manual');
  place(state, doc);
  state.observer = new doc.defaultView.MutationObserver(() => place(state, doc));
  // childList: a dialog removed while still open would otherwise take the toast with it.
  state.observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  if (!error) {
    timer(() => {
      if (active !== state) return;
      node.classList.add('is-leaving');
      timer(() => remove(state), FADE_MS, state);
    }, SUCCESS_HOLD_MS, state);
  } else if (undo) timer(() => { if (active === state) undo.disabled = true; }, SUCCESS_HOLD_MS + FADE_MS, state);
  return node;
}
