export const TAB_REQUEST_LIMIT = 600;

const refillMs = 1_000;
const capacity = TAB_REQUEST_LIMIT * refillMs;
const pauseMessage = 'Updates paused. Trying again shortly.';

// eslint-disable-next-line no-restricted-syntax -- Cap the document burst at 600 attempts and refill one request per second.
export function createRequestBudget({ fetchImpl, onPauseChange = () => {} }) {
  let credit = capacity;
  let refilledAt = Date.now();
  let paused = false;

  async function fetch(path, init, { waitForBudget = false } = {}) {
    const signal = init?.signal;
    // eslint-disable-next-line no-restricted-syntax -- Only deadline-bound callers wait, one timeout per request until a token refills.
    while (true) {
      signal?.throwIfAborted();
      const now = Math.max(refilledAt, Date.now());
      credit = Math.min(capacity, credit + now - refilledAt);
      refilledAt = now;
      if (credit >= refillMs) {
        credit -= refillMs;
        break;
      }
      if (!paused) {
        paused = true;
        onPauseChange(pauseMessage);
      }
      if (!waitForBudget || !signal) throw Object.assign(new Error(pauseMessage), { code: 'request_budget_exhausted' });
      // eslint-disable-next-line no-restricted-syntax -- Wait at most one second per timeout and check the caller's abort signal before sending.
      await new Promise(resolve => setTimeout(resolve, refillMs - credit));
    }

    const response = await fetchImpl(path, { ...init, redirect: 'error' });
    if (paused && (response.ok || response.status === 304) && ['GET', 'HEAD'].includes(init?.method?.toUpperCase() ?? 'GET')) {
      paused = false;
      onPauseChange(null);
    }
    return response;
  }
  return { fetch };
}
