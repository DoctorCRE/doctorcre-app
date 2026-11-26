import { toDay } from './calendar-model.js';

export function validDealBoard(board) {
  return board && typeof board === 'object' && !Array.isArray(board) && Array.isArray(board.deals)
    && board.deals.every(deal => deal && typeof deal === 'object' && !Array.isArray(deal)
      && typeof deal.id === 'string' && deal.id.trim().length > 0
      && ['name', 'owner', 'phase', 'operating_state', 'workspace_kind', 'account_client_id'].every(key => deal[key] == null || typeof deal[key] === 'string')
      && (deal.in_market == null || typeof deal.in_market === 'boolean'));
}

/** The engine's sentence for why a deal needs attention, or null. A partner's stored flag is never attention. */
export function attentionReason(deal) {
  const reason = deal.attention?.reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

export function scopedDeals(board, scope) {
  if (!validDealBoard(board) || (scope === 'mine' && !board.actor)) return null;
  return board.deals.filter(deal => !isClosedDeal(deal)
    && (deal.operating_state || 'active') === 'active'
    && (scope !== 'mine' || deal.owner === board.actor));
}

export function localDeals(rows, owner = 'all') {
  return (rows || []).filter(d => d.workspace_kind !== 'national_account' && !d.account_client_id
    && !(d.client_status === 'prospect' && d.prospect_engagement_status !== 'active')
    && !isClosedDeal(d) && (owner === 'all' || d.owner === owner));
}
export function isClosedDeal(deal) {
  return ['closed', 'invoiced', 'dead'].includes(String(deal.phase).toLowerCase())
    || Boolean(deal.outcome || deal.closed_on || deal.invoiced_on);
}
/** The oldest due day before `today` among the deal's open actions, or null. */
export function overdueSince(deal, today) {
  if (isClosedDeal(deal) || (deal.operating_state || 'active') !== 'active') return null;
  const dues = Array.isArray(deal.items)
    ? deal.items.filter(item => item.status === 'open').map(item => toDay(item.due_on))
    : typeof deal.next_step === 'string' && deal.next_step.trim() ? [toDay(deal.next_date)] : [];
  return dues.filter(due => due && due < today).sort()[0] || null;
}
/** "N days overdue" between two calendar days, or '' when `since` is not before `today`. */
export function overdueLabel(since, today) {
  const days = since && today ? Math.round((Date.parse(today) - Date.parse(since)) / 864e5) : 0;
  return days > 0 ? `${days} day${days === 1 ? '' : 's'} overdue` : '';
}
export function requireReviewReceipt(receipt) {
  if (receipt?.ok !== true || typeof receipt.session_id !== 'string' || !receipt.session_id.trim())
    throw Object.assign(new Error('Agenda receipt is incomplete. Check outcome to recover the original session.'), { code: 'unknown_outcome' });
  return receipt;
}
