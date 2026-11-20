import { workCard } from './work-card.js';
import { overdueLabel } from './deal-review-model.js';
import { dealName, noteText } from './pipeline-model.js';
import { calendarDay } from './deal-timeline.js';
import { daysBetween } from './calendar-model.js';
import { fieldLabel } from './change-receipts.mjs';
import { ACTOR_LABEL } from './client.js';
import { renderDealVendors } from './deal-vendors.js';
import { automaticMove, invoiceClose, isPhaseMoveReceipt } from './local-deals-model.js';
import { sourceTime } from './email-source-line.js';
import { formatCalendarDate } from './visual-system.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const openDealItems = deal => (Array.isArray(deal.items) ? deal.items : []).filter(item => item.status === 'open');
const dealItemHref = (deal, item) => `/deals?deal=${encodeURIComponent(deal)}&item=${encodeURIComponent(item)}`;
function shortDealName(deal) {
  return deal.short_name || deal.name || 'Deal';
}
const monthDay = value => {
  const day = String(value || '').slice(0, 10), date = new Date(`${day}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
};
/** The one overdue treatment on board cards and list rows: a tappable age that opens the deal. */
export const renderOverdueFlag = (id, name, label) => label ? `<button type="button" class="attention-flag" data-open="${esc(id)}" aria-label="${esc(label)}, open ${esc(name)}">${esc(label)}</button>` : '';
export function renderDealAlert(deal, { today = '' } = {}) {
  return workCard({ className: 'home-flag deal-alert',
    title: `<a data-home-key="deal:${esc(deal.id)}" href="/deals?deal=${encodeURIComponent(deal.id)}">${esc(shortDealName(deal))}</a>`,
    meta: esc(({ joe: 'Joe', dell: 'Dell' })[deal.owner] || deal.owner || 'Unassigned'),
    status: overdueLabel(deal.overdue_since, today) || '', body: renderDealItems(deal, { today }) });
}

export function dealItemRows(deal, { today = '', board = false } = {}) {
  const nextItem = board ? dealNextStep(deal).item : null;
  return openDealItems(deal).filter(item => item !== nextItem).map(item => ({
    item, href: dealItemHref(deal.id, item.id), date: monthDay(item.due_on) || item.due_on,
    overdue: Boolean(item.due_on && item.due_on < today),
  }));
}

export function renderDealItems(deal, { today = '', buttons = false, empty = true, board = false, itemOwners } = {}) {
  const rows = dealItemRows(deal, { today, board });
  if (!rows.length) return empty ? '<p class="deal-items-empty">No action items recorded</p>' : '';
  return `<p class="deal-items-label">Still needed:</p><ol class="deal-items">${rows.map(({ item, href, date, overdue }) => {
    const title = buttons ? renderDealItemButton(deal.id, item)
      : `<a data-home-key="deal:${esc(deal.id)}:${esc(item.id)}" href="${esc(href)}">${esc(item.title)}</a>`;
    const time = (day, text) => `<time class="deal-item-due" datetime="${esc(day)}">${esc(text)}</time>`;
    const owner = itemOwners?.get(item.id);
    const due = itemOwners && dealDueDate(item.due_on);
    const details = itemOwners
      ? ` · ${esc(ACTOR_LABEL[owner] || owner || 'Owner not recorded')} · ${due ? time(due.day, due.date) : 'No due date'}`
      : date ? time(item.due_on, date) : '';
    return `<li data-overdue="${overdue}">${title}${details}</li>`;
  }).join('')}</ol>`;
}

function shortDate(value, today) {
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (!today || day >= today) options.weekday = 'short';
  return date.toLocaleDateString('en-US', options).replace(',', '');
}

export function dealDueDate(value, today) {
  const day = calendarDay(value);
  if (!day) return null;
  const daysLate = today && day < today ? daysBetween(day, today) : 0;
  return { day, date: formatCalendarDate(day), late: daysLate ? `${daysLate} day${daysLate === 1 ? '' : 's'} late` : '' };
}

export function dealNextStep(deal, actions = deal.open_actions || [], items = deal.items || []) {
  const open = actions.filter(action => (action.status === undefined || action.status === 'open') && action.title == null)
    .sort((a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.id.localeCompare(b.id));
  const hasText = action => typeof action.description === 'string' && action.description.trim();
  // The board projects at most three rows before the display skips blanks.
  const action = open.slice(0, 3).find(hasText);
  const otherActions = open.filter(row => row !== action && hasText(row));
  const openItems = items.filter(item => item.status === 'open');
  if (action) {
    const text = action.description.trim();
    return { text, dueOn: calendarDay(action.due_on), action, item: openItems.find(item => item.title.trim() === text), otherActions };
  }
  const savedStep = noteText(deal.next_step).trim();
  const savedDate = calendarDay(deal.next_date);
  // Filing a call can keep the saved wording in the item's promised work.
  const item = savedStep ? openItems.find(item => calendarDay(item.due_on) === savedDate
    && (item.title.trim() === savedStep || item.bullets?.some(bullet => bullet.kind === 'promised' && noteText(bullet.text).trim() === savedStep))) : undefined;
  return { text: item?.title, dueOn: calendarDay(item?.due_on), action, item, otherActions };
}

export function renderDealItemButton(dealId, item, text = item.title, className = '') {
  return `<button type="button"${className ? ` class="${className}"` : ''} data-deal-item="${esc(item.id)}" data-item-deal="${esc(dealId)}">${esc(text)}</button>`;
}

export function dealNextCaption(deal, { today = '', viewer = '', board = false, actorName = name => name } = {}) {
  const { text, dueOn: when, action, item } = dealNextStep(deal);
  if (!text) return null;
  const overdue = Boolean(when && when < today);
  const date = overdue && action ? '' : shortDate(when, today);
  const owner = !board && action?.owner && viewer && action.owner !== viewer ? ` · ${actorName(action.owner)}` : '';
  return { text, when, date, overdue, owner, item };
}

export function dealLastCaption(last) {
  const text = noteText(last?.summary);
  const date = shortDate(last?.occurred_at, '');
  return text && date ? { text, date, when: last.occurred_at } : null;
}

export function renderDealSummary(deal, options = {}) {
  const next = dealNextCaption(deal, options);
  const last = renderLastDealStep(deal.last_step);
  if (!next) return '<span class="deal-summary-line">No next step set</span>' + last;
  const { text, when, date, overdue, owner, item } = next;
  const label = options.board && item ? renderDealItemButton(deal.id, item, text, 'deal-summary-text') : `<span class="deal-summary-text">${esc(text)}</span>`;
  return `<span class="deal-summary-line"><span class="deal-summary-label">Next: </span>${label}<span class="deal-summary-facts">${date ? ` · <time data-overdue="${overdue}" datetime="${esc(when)}">${esc(date)}</time>` : ''}${esc(owner)}</span></span>` + last;
}

function renderLastDealStep(step) {
  const last = dealLastCaption(step);
  return last ? `<span class="deal-summary-line deal-summary-last"><span class="deal-summary-label">Last: </span><span class="deal-summary-text">${esc(last.text)}</span><span class="deal-summary-facts"> · <time datetime="${esc(last.when)}">${esc(last.date)}</time></span></span>` : '';
}

export function renderDealItemDetail(item, { today = '' } = {}) {
  const overdue = item.status === 'open' && item.due_on && item.due_on < today;
  const sections = [['promised', 'What was promised'], ['call', 'From the call'], ['suggestion', 'Suggested next steps'], ['status', 'Status']];
  return `<div class="deal-item-date" data-overdue="${Boolean(overdue)}">${overdue ? 'Overdue' : 'Due'} ${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(monthDay(item.due_on) || item.due_on)}</time>` : 'date not recorded'}</div>${sections.map(([kind, label]) => {
    const bullets = (item.bullets || []).filter(bullet => bullet.kind === kind);
    return bullets.length ? `<section><h3>${label}</h3><ul>${bullets.map(bullet => `<li>${bullet.date ? `<time datetime="${esc(bullet.date)}">${esc(bullet.date)}</time> · ` : ''}${esc(bullet.text)}</li>`).join('')}</ul></section>` : '';
  }).join('')}<form data-item-instruction><label for="dealItemInstruction">Tell Dr. CRE</label><textarea id="dealItemInstruction" name="text" aria-label="Tell Dr. CRE" rows="3" maxlength="240" required></textarea><button type="submit" class="btn btn-primary" disabled>Save instruction</button><p>Not submitted. This control cannot send a request to Dr. CRE.</p></form><button type="button" class="btn" data-complete-item${item.status === 'done' ? ' disabled' : ''}>${item.status === 'done' ? 'Done' : 'Mark done'}</button><p role="status" data-item-status></p>`;
}

export function autoHtml(deal) {
  const move = automaticMove(deal);
  if (!move) return '';
  const day = calendarDay(move.day);
  return day ? `<div class="auto-move"><span>${esc(move.label)}</span> <time datetime="${day}">${formatCalendarDate(day)}</time></div>` : '';
}
export function lossReasonLabel(reason) {
  return reason === 'not recorded before this system' ? 'Not recorded before this system' : reason || 'Not recorded';
}

export function dealTypeFacts(deal, dealTypeLabel) {
  return [
    { label: fieldLabel('kind'), value: dealTypeLabel(deal.kind) || 'Not recorded' },
    { label: fieldLabel('reason'), value: dealTypeLabel(deal.reason) || 'Not recorded',
      note: deal.renewal_lease_unrecorded ? 'Lease not recorded' : '' },
  ];
}
export function renderDealFacts(facts) {
  return facts.map(({label, value, note}) => `<div><dt>${esc(label)}</dt><dd>${note
    ? `<span>${esc(value)}</span><br><small>${esc(note)}</small>`
    : esc(value)}</dd></div>`).join('');
}
export function renderInvoiceClose(deal, canUndo = false, feedback = null) {
  const day = calendarDay(invoiceClose(deal)?.evidence_date);
  if (!day) return '';
  const message = feedback && (!feedback.eventId || feedback.eventId === deal.phase_change.event_id) ? feedback.message : null;
  return `<div class="auto-move"><span>Closed automatically: Invoice received</span> <time datetime="${day}">${formatCalendarDate(day)}</time>${canUndo && deal.phase_change?.undoable !== false ? ` <button class="btn" type="button" data-undo-invoice="${esc(deal.id)}" data-event-id="${esc(deal.phase_change.event_id)}" data-base-version="${deal.seen}">Undo invoice close</button>` : ''}</div>${message ? `<p class="auto-move">${esc(message)}</p>` : ''}`;
}

export function renderEndedDealList(view, {
  rows, dealTypeLabel, lost = false, fromEngine = true, unavailable = false,
  unavailableMessage = 'Closed history is unavailable. Refresh to try again.', canUndo = false, feedback = () => null,
}) {
  const search = view.querySelector('#closedSearch').value.trim().toLowerCase();
  const cards = rows.map(deal => {
    const formatted = formatCalendarDate(fromEngine ? calendarDay(deal.closed_on) || '' : deal.closed_on || '');
    const closeDate = fromEngine ? formatted || 'Close date not recorded' : formatted || deal.closed_on || 'Not recorded';
    const facts = [
      { label: 'Client', value: deal.client_name || (!fromEngine && deal.client_ref) || 'Not recorded' },
      ...(fromEngine ? dealTypeFacts(deal, dealTypeLabel) : [{ label: 'Type', value: deal.type || 'Not recorded' }]),
      { label: 'Close date', value: closeDate },
    ];
    if (lost && deal.lost_reason) {
      facts.push({ label: fromEngine ? 'Reason for loss' : 'Reason', value: lossReasonLabel(deal.lost_reason) });
    }
    facts.push({ label: 'Owner', value: ACTOR_LABEL[deal.owner] || deal.owner || 'Unassigned' });
    return { deal, title: dealName(deal.name), facts };
  }).filter(({title, facts}) => !fromEngine || !search ||
    [title, ...facts.flatMap(({value, note}) => [value, note])].some(value => value?.toLowerCase().includes(search)));

  const label = lost ? 'lost' : 'closed';
  view.querySelector('#closedCount').textContent = unavailable ? unavailableMessage
    : `${cards.length} ${label} deal${cards.length === 1 ? '' : 's'}`;
  const empty = unavailable ? '' : `<p>No ${label} deals${search || !fromEngine ? ' match this search' : ''}.</p>`;
  view.querySelector('#closedDealsList').innerHTML = cards.map(({deal, title, facts}) => {
    const receipt = !fromEngine ? autoHtml(deal) : lost ? '' : renderInvoiceClose(deal, canUndo, feedback(deal.id))
      || renderPhaseReceipt(deal, automaticPhaseReceipt(deal, feedback(deal.id), { showEngineMoves: true, canUndo }), '');
    return `<article class="closed-deal" data-id="${esc(deal.id)}">
      <h3><button type="button" class="card-open" data-open-deal="${esc(deal.id)}">${esc(title)}</button></h3>
      <dl>${renderDealFacts(facts)}</dl>${renderDealVendors(deal.vendors)}${receipt}</article>`;
  }).join('') || empty;
}

export function automaticPhaseReceipt(deal, entry, { showEngineMoves = false, canUndo = true } = {}) {
  const event = deal.phase_change;
  const day = calendarDay(event?.evidence_date);
  const datedMove = event?.automatic === true && event.event_id && day;
  const feedback = canUndo && (!entry?.eventId || entry.eventId === event?.event_id) ? entry : null;
  const undoableMove = canUndo && event?.undoable !== false && isPhaseMoveReceipt(event) && datedMove;
  const returnsToEndedDeals = undoableMove && (['closed', 'invoiced', 'dead'].includes(event.prior_phase)
    || feedback?.code === 'undo_returns_to_ended_deals');
  const message = returnsToEndedDeals ? 'Undo would return this deal to Closed deals or Lost deals.' : feedback?.message;
  const action = undoableMove && !returnsToEndedDeals && Number.isSafeInteger(deal.seen) && deal.seen >= 0
    ? { eventId: event.event_id, version: deal.seen, busy: Boolean(feedback?.busy) } : null;
  const callTime = event?.source === 'call_capture' ? sourceTime(event.call?.happened_at, undefined, '') : '';
  const move = datedMove && (showEngineMoves || undoableMove) ? { day, date: formatCalendarDate(day), callTime, action, label: event.source === 'invoice' ? 'Closed automatically: Invoice received'
    : isPhaseMoveReceipt(event) && event.phase?.toLowerCase() === 'closed' ? 'Closed automatically' : 'Moved automatically' } : null;
  return { move, message };
}

export function renderPhaseReceipt(deal, { move, message }, legacy) {
  const undo = move?.action;
  const button = undo ? `<button class="btn btn-quiet" type="button" data-undo-phase="${esc(deal.id)}" data-event-id="${esc(undo.eventId)}" data-base-version="${undo.version}" data-detail-focus="phase-undo"${undo.busy ? ' aria-disabled="true"' : ''}>Undo</button>` : '';
  const mark = move ? `<div class="auto-move"><span>${move.label}</span> <time datetime="${move.day}">${esc(move.date)}</time>${move.callTime ? `<div>Call on ${esc(move.callTime)}</div>` : ''}${button}</div>` : legacy;
  return mark + (message ? `<p class="auto-move">${esc(message)}</p>` : '');
}
