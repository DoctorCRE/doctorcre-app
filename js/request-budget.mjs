import { listenForHumanInput } from './visibility-poll.mjs';

export const TAB_REQUEST_LIMIT = 600;
export const INITIAL_ASSET_REQUEST_LIMIT = 400;
export const QUIET_TAB_REQUEST_LIMIT = TAB_REQUEST_LIMIT + INITIAL_ASSET_REQUEST_LIMIT;

const VISIBILITY_RENEWAL_INTERVAL_MS = 2 * 60_000;
const pauseMessage = 'Automatic reads paused. Interact with this page to continue.';

// eslint-disable-next-line no-restricted-syntax -- The cap is 600 HTTP attempts per document between renewals.
export function createRequestBudget({ fetchImpl, document, onPauseChange = () => {} }) {
  let used = 0;
  let lastRenewal = Date.now();
  let paused = false;
  let visible = document?.visibilityState === 'visible';
  const renew = () => {
    used = 0;
    lastRenewal = Date.now();
    if (paused) {
      paused = false;
      onPauseChange(null);
    }
  };
  const stopInput = listenForHumanInput(document, renew);
  const visibility = () => {
    const wasVisible = visible;
    visible = document.visibilityState === 'visible';
    if (visible && !wasVisible && used >= TAB_REQUEST_LIMIT
        && Date.now() - lastRenewal >= VISIBILITY_RENEWAL_INTERVAL_MS) {
      renew();
    }
  };
  // eslint-disable-next-line no-restricted-syntax -- Visibility can renew a spent budget at most once every two minutes and performs zero reads.
  document?.addEventListener('visibilitychange', visibility, true);
  return {
    get used() { return used; },
    async fetch(path, init) {
      if (used >= TAB_REQUEST_LIMIT) {
        if (!paused) {
          paused = true;
          onPauseChange(pauseMessage);
        }
        throw Object.assign(new Error(pauseMessage), { code: 'request_budget_exhausted' });
      }
      used++;
      return fetchImpl(path, { ...init, redirect: 'error' });
    },
    dispose() {
      stopInput();
      document?.removeEventListener('visibilitychange', visibility, true);
    },
  };
}
