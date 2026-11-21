import { workCard } from './work-card.js';
import { sessionFetch } from './private-session.js';
import { BUSINESS_TIME_ZONE } from './business-date.js';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const text = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => text(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** The well-formed meeting reviews in a brief calendar section, newest first. */
export function meetingReviews(calendar) {
  const rows = Array.isArray(calendar?.follow_up_reviews) ? calendar.follow_up_reviews : [];
  return rows.filter(row => row?.state === 'needs_review' && row.confirmed !== true && row.dismissed !== true && typeof row.key === 'string' && /^[a-f0-9]{16}$/.test(row.key)
    && text(row.title) && instant(row.start) !== null && instant(row.end) !== null && instant(row.end) > instant(row.start))
    .map(row => ({ key: row.key, title: row.title.trim(), start: row.start, end: row.end }))
    .sort((a, b) => instant(b.end) - instant(a.end) || a.key.localeCompare(b.key));
}

const when = review => {
  const options = { timeZone: BUSINESS_TIME_ZONE, hour: 'numeric', minute: '2-digit' };
  const day = new Date(review.start).toLocaleDateString(undefined, { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric' });
  return `${day}, ${new Date(review.start).toLocaleTimeString(undefined, options)} to ${new Date(review.end).toLocaleTimeString(undefined, { ...options, timeZoneName: 'short' })}`;
};

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Both answers share the engine receipt key so the first one wins across tabs.
async function engineReviewKey(actor, key) {
  const identity = new TextEncoder().encode(JSON.stringify(['home-meeting-review', actor, key]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', identity), 0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
}

const receiptConflict = Symbol('receipt conflict');
const unknownAnswer = () => Object.assign(new Error('Meeting answer could not be verified'), { code: 'unknown_outcome' });
const isDismissal = (receipt, key) => receipt?.key === key && instant(receipt.dismissed_at) !== null;

async function postReviewAnswer(path, args) {
  const response = await sessionFetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(10_000),
  });
  const receipt = await response.json();
  if (response.status === 409 && receipt?.error === 'key_reuse') return receiptConflict;
  if (!response.ok) throw Object.assign(new Error('Meeting answer refused'), { status: response.status, payload: receipt });
  return receipt;
}

async function saveEngineReview({ args, key, action, deal }) {
  const dismiss = action === 'dismiss';
  const dismissalPath = `/api/engine/calendar/reviews/${key}/dismissal`;
  const receipt = await postReviewAnswer(dismiss ? dismissalPath : '/api/engine/activities', args);
  if (receipt === receiptConflict) {
    // The shared receipt is committed, and a dismissal can be reconstructed from its key.
    const stored = dismiss ? receipt : await postReviewAnswer(dismissalPath, { idempotency_key: args.idempotency_key });
    if (stored === receiptConflict) return { ok: true, notice: 'Meeting already logged.' };
    if (stored?.replayed === true && isDismissal(stored, key)) return { ok: true, notice: 'Meeting already dismissed.' };
    throw unknownAnswer();
  }
  if (dismiss ? !isDismissal(receipt, key) : !uuid(receipt?.activity_id) || typeof receipt.existing !== 'boolean')
    throw unknownAnswer();
  const notice = dismiss ? (receipt.replayed ? 'Meeting already dismissed.' : 'Meeting dismissed.')
    : receipt.existing || receipt.replayed ? 'Meeting already logged.' : `Meeting logged on ${deal.name}.`;
  return { ok: true, notice };
}

export function mountHomeMeetingReviews({ document, client, host, engine = false }) {
  let view = {}, actor = null, handled = new Set(), generation = 0, disposed = false, notice = '', commands, openKey = null;
  const decisions = new Map(), choices = new Map();
  const deals = () => {
    const rows = (view.deals || []).filter(deal => text(deal?.id) && text(deal?.name) && (!engine || uuid(deal.id)));
    return [...rows.filter(deal => deal.owner === actor), ...rows.filter(deal => deal.owner !== actor)];
  };
  const visible = () => {
    if (view.signedOut || !text(actor)) return [];
    const reviews = meetingReviews(view.calendar);
    const unique = engine ? new Map(reviews.map(review => [review.key, review])).values() : reviews;
    return Array.from(unique).filter(review => !handled.has(review.key) || decisions.get(review.key)?.state === 'uncertain');
  };
  const render = () => {
    if (disposed) return;
    const focused = host.contains(document.activeElement) ? document.activeElement?.dataset.homeKey : null;
    const reviews = visible(), options = deals();
    host.hidden = !reviews.length && !notice;
    if (host.hidden) { host.replaceChildren(); return; }
    const rows = reviews.map(review => {
      const decision = decisions.get(review.key);
      const busy = decision?.state === 'submitting', uncertain = decision?.state === 'uncertain';
      const dismissing = decision?.action === 'dismiss' && (busy || uncertain);
      const chosen = decision?.deal?.id || choices.get(review.key) || '';
      const select = options.length
        ? `<label>Deal <select data-review-deal="${E(review.key)}" data-home-key="review:${E(review.key)}:deal"${busy || uncertain ? ' disabled' : ''}><option value="">Choose a deal</option>${options.map(deal => `<option value="${E(deal.id)}"${deal.id === chosen ? ' selected' : ''}>${E(deal.name)}</option>`).join('')}</select></label>`
        : view.deals === null ? '<span>Couldn’t load deals. Retry Today to choose a deal.</span>'
          : '<span>No open deals to log this meeting on.</span>';
      const expanded = openKey === review.key;
      const answerControls = `${select}<button type="button" class="home-outline" data-review-log="${E(review.key)}" data-home-key="review:${E(review.key)}:log"${busy || dismissing || !chosen ? ' disabled' : ''}>${decision?.action === 'log' && uncertain ? 'Check meeting log' : decision?.action === 'log' && busy ? 'Logging…' : 'It happened'}</button><button type="button" class="home-outline" data-review-dismiss="${E(review.key)}" data-home-key="review:${E(review.key)}:dismiss"${busy || uncertain && !dismissing ? ' disabled' : ''}>${dismissing && uncertain ? 'Check dismissal' : dismissing && busy ? 'Saving…' : 'Dismiss'}</button>`;
      return workCard({ className: 'home-call-task home-meeting-review', attributes: `data-review="${E(review.key)}"`,
        title: E(engine ? `${review.title} was scheduled — confirm it happened` : review.title), meta: `${engine ? 'Scheduled for ' : ''}<time datetime="${E(review.start)}">${E(when(review))}</time>`, status: uncertain ? 'Unconfirmed' : '',
        body: `${decision?.error ? `<p class="home-call-task-error" role="alert">${E(decision.error)}</p>` : ''}`,
        actions: engine
          ? `<button type="button" class="home-outline" data-review-open="${E(review.key)}" data-home-key="review:${E(review.key)}:open" aria-expanded="${expanded}" aria-controls="meeting-review-${E(review.key)}">Review meeting</button><div class="home-meeting-decision" id="meeting-review-${E(review.key)}"${expanded ? '' : ' hidden'}>${answerControls}</div>`
          : answerControls });
    }).join('');
    const heading = engine ? '<h3>Did these meetings happen?</h3>' : '<header class="home-panel-head"><h2>Did these meetings happen?</h2><span class="home-period">Last 24 hours</span></header><p class="home-empty">From your Outlook calendar. Pick the deal and log the meeting, or dismiss it.</p>';
    host.innerHTML = `${heading}${notice ? `<p class="home-call-task-notice" role="status">${E(notice)}</p>` : ''}${rows}`;
    if (focused) ([...host.querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === focused) || document.getElementById('homePrimaryAction'))?.focus();
  };
  const answer = async (review, action = 'log') => {
    const prior = decisions.get(review.key);
    const operation = `meeting-review:${review.key}`;
    const uncertain = prior?.state === 'uncertain';
    const retained = uncertain ? commands?.pending(operation) : null;
    const deal = uncertain ? prior.deal : deals().find(row => row.id === choices.get(review.key));
    if (prior?.state === 'submitting' || (uncertain && (!retained || prior.action !== action)) || (action === 'log' && !deal)) return;
    const ticket = generation, binding = actor;
    decisions.set(review.key, { state: 'submitting', deal, action }); notice = ''; render();
    try {
      if (!commands) {
        const { createRetainedCommands } = await import('./retained-commands.mjs');
        commands ||= createRetainedCommands({ scope: () => actor });
      }
      let request = retained;
      if (!request) {
        const happenedAt = new Date(review.start).toISOString();
        const summary = `Meeting: ${review.title}`;
        request = engine
          ? { idempotency_key: await engineReviewKey(binding, review.key), ...(action === 'log' && {
            kind: 'meeting', calendar_review_key: review.key, happened_at: happenedAt, about: [{ deal_id: deal.id }], summary,
          }) }
          : action === 'dismiss'
            ? { board_id: 'calendar-agenda', question_id: review.key, base_version: 1, answer_text: 'Dismiss' }
            : { ref: deal.id, kind: 'meeting', summary, occurred_at: happenedAt, calendar_event_key: review.key };
      }
      if (disposed || ticket !== generation || actor !== binding) return;
      const receipt = await commands.send(operation, request, async args => {
        if (engine) return saveEngineReview({ args, key: review.key, action, deal });
        const receipt = action === 'dismiss' ? await client.answerBoardQuestion(args) : await client.logActivity(args);
        if (receipt?.ok !== true || (action === 'dismiss'
          ? receipt.answer?.question_id !== review.key || receipt.answer?.answer_text !== 'Dismiss'
          : !text(receipt.activity_id)))
          throw Object.assign(new Error('Meeting answer could not be verified'), { code: 'unknown_outcome' });
        return receipt;
      }, action);
      if (disposed || ticket !== generation || actor !== binding) return;
      decisions.delete(review.key); handled.add(review.key);
      if (openKey === review.key) openKey = null;
      notice = engine ? receipt.notice : action === 'dismiss' ? '' : `Meeting logged on ${deal.name}.`;
    } catch (error) {
      if (disposed || ticket !== generation || actor !== binding) return;
      if (error.pendingRequest) decisions.set(review.key, { state: 'uncertain', deal, action, error: action === 'dismiss' ? 'Dismissal not confirmed yet. Check dismissal before choosing again.' : 'Not confirmed yet. Check the meeting log before choosing again.' });
      else decisions.set(review.key, { state: 'failed', action, error: action === 'dismiss' ? 'The meeting was not dismissed. Try again.' : 'The meeting was not logged. Try again or choose another deal.' });
    }
    render();
  };
  const onClick = event => {
    const requested = event.target.closest('[data-review-open]')?.dataset.reviewOpen;
    if (requested) {
      openKey = openKey === requested ? null : requested;
      render();
      return;
    }
    const logButton = event.target.closest('[data-review-log]'), dismiss = event.target.closest('[data-review-dismiss]');
    const key = logButton?.dataset.reviewLog || dismiss?.dataset.reviewDismiss;
    const review = key && visible().find(row => row.key === key);
    if (!review || (logButton || dismiss).disabled) return;
    if (logButton) { void answer(review); return; }
    void answer(review, 'dismiss');
  };
  const onChange = event => {
    const select = event.target.closest('[data-review-deal]');
    if (!select) return;
    choices.set(select.dataset.reviewDeal, select.value);
    if (decisions.get(select.dataset.reviewDeal)?.state === 'failed') decisions.delete(select.dataset.reviewDeal);
    render();
  };
  const retire = () => { generation++; decisions.clear(); choices.clear(); notice = ''; actor = null; handled = new Set(); commands = null; openKey = null; host.replaceChildren(); host.hidden = true; };
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  return {
    update(next) {
      if (disposed) return;
      if (next.signedOut || actor && text(next.actor) && actor !== next.actor) retire();
      if (!actor && text(next.actor) && !next.signedOut) { actor = next.actor; }
      view = next;
      render();
    },
    dispose() { retire(); disposed = true; host.removeEventListener('click', onClick); host.removeEventListener('change', onChange); },
  };
}
