import { workCard } from './work-card.js';
import { overdueLabel } from './deal-review-model.js';
import { noteText } from './pipeline-model.js';
import { calendarDay } from './deal-timeline.js';

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

export function renderDealItems(deal, { today = '', buttons = false, empty = true, board = false } = {}) {
  const nextItem = board ? dealNextStep(deal).item : null;
  const items = openDealItems(deal).filter(item => item !== nextItem);
  return items.length ? `<p class="deal-items-label">Still needed:</p><ol class="deal-items">${items.map(item => `<li data-overdue="${Boolean(item.due_on && item.due_on < today)}">${buttons ? renderDealItemButton(deal.id, item) : `<a data-home-key="deal:${esc(deal.id)}:${esc(item.id)}" href="${esc(dealItemHref(deal.id, item.id))}">${esc(item.title)}</a>`}${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(monthDay(item.due_on) || item.due_on)}</time>` : ''}</li>`).join('')}</ol>` : empty ? '<p class="deal-items-empty">No action items recorded</p>' : '';
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

export function renderDealSummary(deal, { today = '', viewer = '', board = false, actorName = name => name } = {}) {
  const { text, dueOn, action, item } = dealNextStep(deal);
  const lines = [];
  if (text) {
    const overdue = Boolean(dueOn && dueOn < today);
    const date = overdue && action ? '' : shortDate(dueOn, today);
    const owner = !board && action?.owner && viewer && action.owner !== viewer ? ` · ${actorName(action.owner)}` : '';
    const label = board && item ? renderDealItemButton(deal.id, item, text, 'deal-summary-text') : `<span class="deal-summary-text">${esc(text)}</span>`;
    lines.push(`<span class="deal-summary-line"><span class="deal-summary-label">Next: </span>${label}<span class="deal-summary-facts">${date ? ` · <time data-overdue="${overdue}" datetime="${esc(dueOn)}">${esc(date)}</time>` : ''}${esc(owner)}</span></span>`);
  } else {
    lines.push('<span class="deal-summary-line">No next step set</span>');
  }
  return lines.join('') + renderLastDealStep(deal.last_step);
}

function renderLastDealStep(last) {
  const lastText = noteText(last?.summary);
  const lastDate = shortDate(last?.occurred_at, '');
  if (lastText && lastDate) {
    return `<span class="deal-summary-line deal-summary-last"><span class="deal-summary-label">Last: </span><span class="deal-summary-text">${esc(lastText)}</span><span class="deal-summary-facts"> · <time datetime="${esc(last.occurred_at)}">${esc(lastDate)}</time></span></span>`;
  }
  return '';
}

export function renderDealItemDetail(item, { today = '' } = {}) {
  const overdue = item.status === 'open' && item.due_on && item.due_on < today;
  const sections = [['promised', 'What was promised'], ['call', 'From the call'], ['suggestion', 'Suggested next steps'], ['status', 'Status']];
  return `<div class="deal-item-date" data-overdue="${Boolean(overdue)}">${overdue ? 'Overdue' : 'Due'} ${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(monthDay(item.due_on) || item.due_on)}</time>` : 'date not recorded'}</div>${sections.map(([kind, label]) => {
    const bullets = (item.bullets || []).filter(bullet => bullet.kind === kind);
    return bullets.length ? `<section><h3>${label}</h3><ul>${bullets.map(bullet => `<li>${bullet.date ? `<time datetime="${esc(bullet.date)}">${esc(bullet.date)}</time> · ` : ''}${esc(bullet.text)}</li>`).join('')}</ul></section>` : '';
  }).join('')}<form data-item-instruction><label for="dealItemInstruction">Tell Dr. CRE</label><textarea id="dealItemInstruction" name="text" aria-label="Tell Dr. CRE" rows="3" maxlength="240" required></textarea><button type="submit" class="btn btn-primary" disabled>Save instruction</button><p>Not submitted. This control cannot send a request to Dr. CRE.</p></form><button type="button" class="btn" data-complete-item${item.status === 'done' ? ' disabled' : ''}>${item.status === 'done' ? 'Done' : 'Mark done'}</button><p role="status" data-item-status></p>`;
}
