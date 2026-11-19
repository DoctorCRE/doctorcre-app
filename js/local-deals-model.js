import { newestFirst } from './change-receipts.mjs';
import { noteText } from './pipeline-model.js';
import { overdueSince } from './deal-review-model.js';
import { radarToday } from './lease-radar-model.js';

export const isEngineDealDetail = detail => Array.isArray(detail?.email_follow_ups);

// Each entry has the engine caption and, where mapped today, the legacy caption.
const TYPE_TO_UI = new Map([
  ['lease', ['Lease']],
  ['purchase', ['Purchase', 'Purchase']],
  ['sale_leaseback', ['Sale-leaseback']],
  ['build_to_suit', ['Build-to-suit']],
  ['other', ['Other', 'Other']],
  ['start_up', ['Start-up']],
  ['startup', ['Start-up', 'Startup']],
  ['relocation', ['Relocation', 'Relocation']],
  ['expansion', ['Expansion', 'Expansion']],
  ['renewal', ['Renewal', 'Renewal']],
  ['additional_office', ['Additional office', '2nd Office']],
]);

export function dealTypeLabel(type) {
  return TYPE_TO_UI.get(type)?.[0];
}

export function legacyDealTypeLabel(type) {
  return TYPE_TO_UI.get(type)?.[1] ?? type;
}

export const PHASE_TRIGGERS = Object.freeze({
  pending: 'Prospective client', research: 'ETL signed', site_selection: 'Tour prepared or scheduled',
  negotiation: 'LOI submitted', legal: 'Draft lease prepared', due_diligence: 'Lease signed',
  closing: 'Due-diligence deadline passed', closed: 'Closed',
});
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
export function invoiceClose(deal) {
  const receipt = deal?.phase_change;
  return Number.isSafeInteger(deal?.seen) && receipt?.phase === 'closed' && receipt.automatic === true
    && receipt.event_id && receipt.prior_phase && /^\d{4}-\d{2}-\d{2}$/.test(receipt.evidence_date) ? receipt : null;
}
export function automaticMove(deal) {
  const event = deal.phase_change;
  if (!event?.automatic || !event.event_id || !event.prior_phase || !event.evidence_date) return null;
  const date = String(event.evidence_date).slice(0,10).split('-');
  if (date.length !== 3 || !Number.isFinite(Date.parse(event.evidence_date))) return null;
  if (invoiceClose(deal)) {
    return { eventId: event.event_id, text: `Closed automatically: Invoice received ${Number(date[1])}/${Number(date[2])}` };
  }
  const reason = concise(event.reason || 'phase changed', 50);
  // The board projection does not bind automatic=true to a Doc actor.
  const prefix = /invoice/i.test(reason) && (event.phase === 'closed' || deal.phase === 'Closed')
    ? 'Closed automatically' : 'Moved automatically';
  return { eventId: event.event_id, text: `${prefix}: ${reason} ${Number(date[1])}/${Number(date[2])}` };
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
  return { ...detail, entries,
    thread: newestFirst(detail.thread || [], threadInstant),
    activities: newestFirst(activities, a => a.occurred_at || a.recorded_at) };
}

export function ordinaryOpenSteps(actions = []) {
  return actions.filter(step => (step.status === undefined || step.status === 'open') &&
    !step.title && step.description?.trim());
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
