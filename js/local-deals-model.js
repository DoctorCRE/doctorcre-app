import { newestFirst } from './change-receipts.mjs';
import { noteText } from './pipeline-model.js';
import { overdueSince } from './deal-review-model.js';
import { radarToday } from './lease-radar-model.js';

export const isEngineDealDetail = detail => Array.isArray(detail?.email_follow_ups);

export const PARKING_REASONS = new Map([
  ['client_paused', 'Client paused'],
  ['prospect_never_active', 'Prospect never active'],
  ['other', 'Other'],
]);

export const PHASE_TRIGGERS = Object.freeze({
  pending: 'Prospective client', research: 'ETL signed', site_selection: 'Tour prepared or scheduled',
  negotiation: 'LOI submitted', legal: 'Draft lease prepared', due_diligence: 'Lease signed',
  closing: 'Due-diligence deadline passed', closed: 'Closed',
});
export function nationalMarketLabel(market) {
  const recorded = market?.trim();
  return !recorded || /^market unspecified(?: in source)?$/i.test(recorded) ? 'No market recorded' : market;
}

export function lostDeals(rows, owner = 'all', query = '') { return historyDeals(rows, owner, query, true); }
export function closedDeals(rows, owner = 'all', query = '') { return historyDeals(rows, owner, query, false); }
function historyDeals(rows, owner = 'all', query = '', lost = false) {
  const search = query.trim().toLowerCase();
  return (rows || []).filter(d => (lost ? d.outcome === 'lost' : Boolean(d.outcome === 'won' || !d.outcome && (d.closed_on || d.invoiced_on))) && d.workspace_kind !== 'national_account' && !d.account_client_id
    && (owner === 'all' || d.owner === owner)
    && (!search || [d.name, d.client_name, d.client_ref, d.type, d.closed_on].some(v => String(v || '').toLowerCase().includes(search))))
    .sort((a,b) => String(b.closed_on || '').localeCompare(String(a.closed_on || '')) || String(a.name).localeCompare(String(b.name)));
}
export function urgencyOrder(rows, now = Date.now()) {
  const today = radarToday(new Date(now));
  return [...rows].sort((a,b) => (overdueSince(a, today) || '9999-12-31').localeCompare(overdueSince(b, today) || '9999-12-31')
    || (Date.parse(a.next_date || '') || Infinity) - (Date.parse(b.next_date || '') || Infinity)
    || String(a.name).localeCompare(String(b.name)));
}
export function concise(value, limit = 100) {
  const text = noteText(value).replace(/\s+/g,' ').trim();
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + '…';
}
export const isPhaseMoveReceipt = receipt => receipt?.source === 'copied' || receipt?.source === 'call_capture';

export function invoiceClose(deal) {
  const receipt = deal?.phase_change;
  return Number.isSafeInteger(deal?.seen) && receipt?.phase === 'closed' && receipt.automatic === true
    && !isPhaseMoveReceipt(receipt) && receipt.event_id && receipt.prior_phase
    && /^\d{4}-\d{2}-\d{2}$/.test(receipt.evidence_date) ? receipt : null;
}
export function automaticMove(deal) {
  const event = deal.phase_change;
  if (!event?.automatic || !event.event_id || !event.prior_phase || !event.evidence_date) return null;
  const day = String(event.evidence_date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(event.evidence_date))) return null;
  if (invoiceClose(deal)) return { day, label: 'Closed automatically: Invoice received' };
  const reason = concise(event.reason || 'phase changed', 50);
  const prefix = /invoice/i.test(reason) && (event.phase === 'closed' || deal.phase === 'Closed')
    ? 'Closed automatically' : 'Moved automatically';
  return { day, label: `${prefix}: ${reason}` };
}
export function noteEntries(detail) {
  const activities = (detail.activities || []).map(a => ({
    id: a.id, kind: a.kind || 'Entry', actor: a.actor, when: a.occurred_at || a.recorded_at,
    summary: concise(a.summary || a.detail, 150),
    original: typeof a.detail === 'string' ? a.detail : noteText(a.detail),
  }));
  const notes = (detail.thread || []).map(n => ({
    id: n.id, kind: n.kind === 'archived_step' ? 'Prior next step' : n.kind === 'note' ? 'Note' : n.kind || 'Entry', actor: n.actor, when: n.at || n.created_at || n.recorded_at,
    summary: concise(n.text,150), original: noteText(n.text),
  }));
  return [...activities, ...notes].filter(n => n.summary);
}
const threadInstant = n => n.at || n.created_at || n.recorded_at;
/**
 * The only place a deal's dated lists are ordered. Every list a renderer reads
 * comes out newest first, and `entries` is the merged update stream (notes,
 * activities, documents, held next steps) so no renderer sorts or merges again.
 */
export function prepareDealDetail(detail) {
  const allActivities = detail.activities || [];
  const activities = isEngineDealDetail(detail)
    ? allActivities.filter(activity => activity.kind !== 'email' && activity.kind !== 'meeting')
    : allActivities;
  const documents = (detail.documents || []).map(doc => ({ id: `document-${doc.id}`, source: 'document', kind: 'Document',
    when: doc.prepared_at, summary: concise(doc.note || 'Document prepared', 150), original: noteText(doc.note) }));
  const holds = (detail.next_actions || []).filter(task => task.status === 'open' && task.hold_until).map(task => ({
    id: `action:${task.id}`, source: 'hold', holdUntil: task.hold_until, actor: task.owner, when: task.updated_at,
    summary: task.description, original: task.description }));
  const entries = newestFirst([...noteEntries({ activities, thread: detail.thread }), ...documents, ...holds], n => n.when);
  const steps = new Map(detail.next_actions?.map(step => [step.id, step]));
  const items = (detail.items || detail.deal?.items)?.map(item => {
    const step = steps.get(item.id);
    const instruction = step?.display_instruction ?? step?.description;
    return step ? { ...item, title: step.display_title ?? item.title, instruction } : item;
  });
  return { ...detail, entries, items,
    thread: newestFirst(detail.thread || [], threadInstant),
    activities: newestFirst(activities, a => a.occurred_at || a.recorded_at) };
}

export function ordinaryOpenSteps(actions = []) {
  return actions.filter(step => (step.status === undefined || step.status === 'open') &&
    !step.title && typeof step.description === 'string' && step.description.trim());
}

export function partnerDealStep(detail, actor) {
  return ordinaryOpenSteps(detail.next_actions).find(step => step.owner === actor) ?? null;
}

export function dealStepVersion(step) {
  if (step === null) return null;
  if (step?.id && Number.isSafeInteger(step.change_id)) {
    return { next_step_id: step.id, change_id: step.change_id };
  }
  return undefined;
}
