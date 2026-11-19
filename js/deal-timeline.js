import { createMcpRequests } from './mcp-requests.mjs';
import { createCurrentRead } from './current-read.mjs';

import { businessDay } from './business-date.js';
import { COLUMNS, columnBySlug, columnByValue, noteText } from './pipeline-model.js';
import { compareInstants, escapeText, fieldLabel, readableValue } from './change-receipts.mjs';
import { sourceTime } from './email-source-line.js';
import { concise } from './local-deals-model.js';
import { ACTOR_LABEL, authorLabel } from './client.js';

const DAY = 86400000;
const esc = escapeText;
// Wire kinds, never prose matching or dates inferred from lease duration.
const DATE_KINDS = Object.freeze([
  { kind:'loi_expiry', label:'LOI', kinds:['loi_expiry','loi','loi_due'], deadline:true },
  { kind:'due_diligence', label:'Due diligence', kinds:['due_diligence','due_diligence_deadline','dd_deadline'], deadline:true },
  { kind:'lease_commencement', label:'Lease commencement', kinds:['lease_commencement','commencement'] },
  { kind:'lease_expiration', label:'Lease expiration', kinds:['lease_expiration'], deadline:true },
  { kind:'rent_start', label:'Rent start', kinds:['rent_start','rent_commencement'] },
  { kind:'option_window', label:'Options', kinds:['option_window','option_notice','option_exercise'], deadline:true },
]);
export function calendarDay(value) {
  if (typeof value !== 'string') return null;
  const day = value.slice(0,10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return null;
  const stamp = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === day ? day : null;
}
const today = now => businessDay(new Date(now));
export function dateCaption(day) {
  return day ? new Date(day+'T12:00:00Z').toLocaleDateString([], {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}) : '—';
}
export function countdown(date, now = Date.now()) {
  if (!calendarDay(date.day)) return { state:'unknown', text:'—' };
  if (date.status === 'cleared') return {state:'complete',text:'Cleared'};
  if (date.status === 'passed') return {state:'past',text:'Passed'};
  const days = Math.round((Date.parse(date.day)-Date.parse(today(now)))/DAY);
  if (!days) return {state:'today',text:date.deadline ? 'Due today' : 'Today'};
  if (days > 0) return {state:days <= 7 && date.deadline ? 'soon':'upcoming',text:`${days} day${days === 1 ? '' : 's'}`};
  return {state:date.deadline ? 'overdue':'past',text:date.deadline ? `${-days} day${days === -1 ? '' : 's'} overdue` : `${-days} day${days === -1 ? '' : 's'} ago`};
}
export function dealTimeline(detail, now = Date.now(), dateDecisions = false) {
  const entryByPhase = new Map();
  for (const [phase, value] of Object.entries(detail.deal.phase_started_on || {})) {
    const column = columnBySlug(phase) || columnByValue(phase);
    const day = calendarDay(value);
    if (column && day) entryByPhase.set(column.slug, day);
  }
  const phases = COLUMNS.map(c => ({...c,day:entryByPhase.get(c.slug) || null,current:detail.deal.phase === c.value}));
  const lease = detail.lease?.status === 'current' ? detail.lease : null;
  const recordedDates = [...(detail.critical_dates || [])];
  if (lease) {
    if (calendarDay(lease.commencement_on)) recordedDates.unshift({id:`lease-${lease.id}-commencement`,kind:'lease_commencement',due_on:lease.commencement_on,note:lease.evidence_ref,source:lease.source});
    if (calendarDay(lease.expiration_on)) recordedDates.push({id:`lease-${lease.id}-expiration`,kind:'lease_expiration',due_on:lease.expiration_on,note:lease.evidence_ref,source:lease.source});
  }
  const rows = recordedDates.map((row,i) => {
    const kind = dateDecisions && row.kind === 'lease_end' ? 'lease_expiration' : row.kind;
    const definition = DATE_KINDS.find(d => d.kinds.includes(kind));
    const value = row.due_on ?? row.date;
    const original = noteText(row.note);
    const namedOther = row.kind === 'other' && original;
    return {dateState:calendarDay(value) ? 'dated' : value == null || value === '' ? 'missing' : 'invalid',id:row.id || `date-${i}`,kind:definition?.kind || row.kind,label:namedOther || definition?.label || row.kind?.replace(/[_-]+/g,' ') || row.label || 'Date',
      day:calendarDay(value),original:namedOther ? '' : original,
      evidence:row.source || '',status:row.status,deadline:Boolean(definition?.deadline)};
  });
  // Co-located dates share a card, preserving every original and status.
  const grouped = new Map();
  const undated = rows.filter(row => !row.day);
  for (const row of rows.filter(row => row.day)) {
    const key = dateDecisions && isSavedDate(row) ? row.id
      : JSON.stringify([row.kind, row.day, row.status || '', row.kind === 'other' ? row.label : null]);
    const existing = grouped.get(key);
    const references = [row.original,row.evidence].filter(Boolean);
    if (existing) existing.references.push(...references);
    else grouped.set(key,{...row,references});
  }
  const dates = [...grouped.values()].map(({references,...row}) => ({...row,
    original:[...new Set(references)].join('\n\n')})).sort((a,b) => a.day.localeCompare(b.day));
  const missing = DATE_KINDS.filter(d => !rows.some(row => row.kind === d.kind));
  const entries = (detail.entries || []).filter(e => e.source !== 'hold').map(e => ({...e, day:calendarDay(e.when), type:e.kind}));
  return {phases,dates,undated,missing,entries,today:today(now)};
}

const isSavedDate = row => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(row.id);
const DATE_STATES = new Map([['proposed','Proposed'], ['open','Confirmed'], ['cleared','Done'], ['done','Done'], ['dropped','Dropped'], ['passed','Passed']]);
function dateDecisionsHtml(date) {
  if (!isSavedDate(date)) return '';
  const state = DATE_STATES.get(date.status);
  const open = date.status === 'open';
  const proposed = date.status === 'proposed';
  return `${state ? `<small>${state}</small>` : ''}${open || proposed ? `
    <form data-date-decision="${esc(date.id)}">
      ${proposed ? '<button type="submit" class="btn" value="confirm" formnovalidate>Confirm</button>' : ''}
      <label>Reason <input name="reason" required maxlength="1000"></label>
      ${open ? '<button type="submit" class="btn" value="done">Mark done</button>' : ''}
      <button type="submit" class="btn" value="dropped">Drop</button>
      ${open ? '<button type="submit" class="btn" value="passed">Mark passed</button>' : ''}
    </form>` : ''}`;
}

export function renderCriticalDates(detail, now = Date.now(), dateDecisions = false) {
  const view = dealTimeline(detail,now,dateDecisions);
  return `<section class="critical-dates" data-detail-read="dates" aria-label="Critical dates">${view.dates.map(d => {
    const count = countdown(d,now);
    const settled = dateDecisions && DATE_STATES.has(d.status) && d.status !== 'open';
    return `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="${settled ? esc(d.status) : count.state}"><span>${esc(d.label)}</span>${settled ? '' : `<strong data-countdown="${esc(d.day)}" data-deadline="${Boolean(d.deadline)}" data-date-status="${esc(d.status || '')}">${esc(count.text)}</strong>`}<time datetime="${esc(d.day)}">${esc(dateCaption(d.day))}</time>${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary><p class="note-original">${esc(d.original || d.evidence)}</p></details>` : ''}${dateDecisions ? dateDecisionsHtml(d) : ''}</article>`;
  }).join('')}${view.undated.map(d => `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="unknown" data-date-status="${esc(d.status || '')}"><span>${esc(d.label)}</span><strong>${d.dateState === 'missing' ? 'Date not recorded' : 'Date unavailable'}</strong>${d.status ? `<small>Status: ${esc(d.status)}</small>` : ''}${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary>${d.original ? `<p class="note-original">${esc(d.original)}</p>` : ''}${d.evidence ? `<p class="date-source">Source: ${esc(d.evidence)}</p>` : ''}</details>` : ''}</article>`).join('')}${view.missing.map(d => `<article class="critical-date"><span>${esc(d.label)}</span><strong>Not recorded</strong></article>`).join('')}</section>`;
}

const timelineActor = actor => Object.hasOwn(ACTOR_LABEL, actor) ? ACTOR_LABEL[actor] : actor ? 'Automatically' : '';
const activityLabels = { call: 'Call', email: 'Email', meeting: 'Meeting' };

function changeText({ field, new_value }) {
  if (field === 'phase') {
    const phase = new_value === 'dead' ? 'Lost' : columnBySlug(new_value)?.label || readableValue(field, new_value);
    return `Moved to ${phase}`;
  }
  const label = field === 'won_value' ? 'Closed value' : fieldLabel(field);
  const value = typeof new_value === 'string' && new_value.length === 10 && calendarDay(new_value)
    ? dateCaption(new_value) : readableValue(field, new_value, { actorLabel: timelineActor });
  return label ? `${label} · ${value}` : 'Deal changed';
}

export function engineTimelineEntries(detail) {
  const notes = detail.thread || [];
  const noteIds = new Set(notes.map(note => note.id));
  /** @type {{ type: string, when: string, actor: string, text: string }[]} */
  const entries = [
    ...notes.map(note => ({ type: 'Note', when: note.created_at, actor: note.actor, text: noteText(note.text) })),
    ...(detail.activities || []).map(activity => ({
      type: activityLabels[activity.kind] || 'Activity', when: activity.occurred_at,
      actor: activity.actor, text: noteText(activity.summary),
    })),
    ...(detail.documents || []).map(file => ({
      type: 'Document', when: file.prepared_at, actor: file.actor, text: file.name,
    })),
    ...(detail.next_actions || []).map(step => ({
      type: step.title ? 'Deal item' : 'Next step', when: step.updated_at || step.due_on, actor: step.actor,
      text: [step.title || step.description, step.updated_at && calendarDay(step.due_on) && `Due ${dateCaption(step.due_on)}`].filter(Boolean).join(' · '),
    })),
    ...(detail.critical_dates || []).map(date => ({
      type: 'Critical date', when: date.updated_at, actor: date.actor,
      text: [...new Set([date.label, calendarDay(date.due_on) && `Due ${dateCaption(date.due_on)}`, date.note].filter(Boolean))].join(' · '),
    })),
    ...(detail.history || []).filter(event => !noteIds.has(event.activity_id)).map(event => ({
      type: event.field === 'note' ? 'Note' : event.field === 'phase' ? 'Phase move' : 'Change',
      when: event.recorded_at, actor: event.actor,
      text: event.field === 'note' ? noteText(event.new_value) : changeText(event),
    })),
  ];
  return entries.flatMap(({ type, when, actor, text }) => {
    if (!calendarDay(when)) return [];
    const dateOnly = when.length === 10;
    const instant = new Date(when);
    if (!Number.isFinite(instant.getTime())) return [];
    return [{
      type, when, actor: timelineActor(actor), text,
      day: dateOnly ? when : businessDay(instant),
      caption: dateOnly ? dateCaption(when) : sourceTime(when),
    }];
  }).sort((a, b) => b.day.localeCompare(a.day) || compareInstants(a.when, b.when));
}

export function renderDealTimeline(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="deal-timeline" data-detail-read="timeline" aria-label="Deal phases and timeline"><h3>Phase timeline</h3><ol class="phase-rail">${view.phases.map(p => `<li${p.current ? ' aria-current="step"' : ''}><span>${esc(p.label)}</span>${p.day ? `<time datetime="${esc(p.day)}">${esc(dateCaption(p.day))}</time>` : ''}</li>`).join('')}</ol></section>`;
}
export function renderDealUpdates(detail, now = Date.now()) {
  const entries = (detail.entries || []).filter(e => e.source !== 'document' && (e.source !== 'hold' || calendarDay(e.holdUntil) > today(now)))
    .map(e => e.source === 'hold' ? {...e, kind:`Held until ${dateCaption(calendarDay(e.holdUntil))}`} : e);
  if (!entries.length) return '';
  const activityIds = new Set((detail.activities || []).map(a => a.id).filter(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)));
  const overview = concise(entries[0]?.summary, 72);
  const latestDate = new Date(entries[0].when || NaN);
  const latestDay = Number.isFinite(latestDate.getTime()) ? latestDate.toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}) : 'Date not recorded';
  return `<section class="deal-updates" data-detail-read="updates" aria-label="Deal updates"><h3>Updates</h3>${entries.length ? `<details class="updates-history"><summary data-detail-focus="update-history"><span>${entries.length} update${entries.length === 1 ? '' : 's'} · ${esc(latestDay)} · ${esc(overview)}</span></summary>${(detail.activities || []).length >= 50 ? '<p class="updates-scope">Includes the latest 50 activities; older activities may be omitted.</p>' : ''}${entries.map(e => `<article class="deal-note" data-id="${esc(e.id)}" data-kind="${esc(e.kind)}"><div class="timeline-entry-top"><b>${esc(authorLabel(e.actor))}</b><time datetime="${esc(e.when || '')}">${esc(sourceTime(e.when, undefined, 'Date not recorded'))}</time></div><small>${esc(e.kind)}</small><p>${esc(e.summary)}</p>${activityIds.has(e.id) ? `<button type="button" class="btn" data-attribution-id="${esc(e.id)}" aria-expanded="false">Show deal attribution</button>` : ''}${e.original && e.original !== e.summary ? `<details><summary data-detail-focus="entry-original:${esc(e.id)}">Read full update</summary><p class="note-original">${esc(e.original)}</p></details>` : ''}</article>`).join('')}</details>` : '<p>No updates recorded.</p>'}</section>`;
}
export function updateCountdowns(root, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-countdown]')) {
    const value = countdown({day:node.dataset.countdown,deadline:node.dataset.deadline === 'true',status:node.dataset.dateStatus},now);
    node.textContent = value.text; node.closest('.critical-date').dataset.state = value.state;
  }
}

export function createActivityAttributionRead(options = {}) {
  const request = createMcpRequests(options);
  return async (activityId, signal) => {
    const result = await request('read-activity-deal-attribution', { activity_id: activityId }, { signal });
    if (result.kind === 'authorization') throw Object.assign(new Error('Sign in to read attribution'), { status: result.status });
    if (result.kind !== 'payload' || result.isError) throw new Error('Activity attribution unavailable');
    return result.payload;
  };
}
export function mountActivityAttribution(root, { read = createActivityAttributionRead(), load = () => import('./ui-activity-attribution.generated.js'), onDenied = () => {} } = {}) {
  const current = createCurrentRead();
  let selected = null, view = null, host = null, busy = false, disposed = false;
  function clear(returnFocus = true) {
    current.invalidate(); busy = false;
    view?.dispose(); view = null; host?.remove(); host = null;
    const trigger = selected; selected = null;
    root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = false; button.setAttribute('aria-expanded','false'); });
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }
  async function show(trigger) {
    if (busy || disposed || !root.isConnected) return;
    clear(false); selected = trigger; busy = true;
    trigger.setAttribute('aria-expanded','true');
    root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = button !== trigger; });
    host = document.createElement('div'); root.append(host);
    host.setAttribute('role','status'); host.textContent = 'Loading deal attribution…';
    const container = host;
    await current.run(async operation => {
      const module = await operation.read(load());
      view = module.mountActivityAttributionView(container, () => clear(), () => void show(trigger));
      view.update({kind:'loading'});
      const response = await operation.read(read(trigger.dataset.attributionId, operation.signal));
      return module.parseActivityDealAttribution(response, trigger.dataset.attributionId);
    }, {
      success(value) { view.update({kind:'result',value}); },
      failure(error) {
        if ([401,403].includes(error?.status)) { retire(); onDenied(error); return; }
        if (view) view.update({kind:'failure'});
        else {
          container.textContent = 'Deal attribution could not be loaded. ';
          const retry = document.createElement('button'); retry.type='button'; retry.className='btn'; retry.textContent='Retry attribution';
          retry.onclick=()=>void show(trigger); container.append(retry);
        }
      },
    });
    if (selected === trigger && host === container) {
      busy = false;
      root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = false; });
    }
  }
  const click = event => { const trigger = event.target.closest?.('[data-attribution-id]'); if (trigger && root.contains(trigger)) void show(trigger); };
  const keydown = event => { if (event.key === 'Escape' && selected) { event.preventDefault(); event.stopPropagation(); clear(); } };
  root.addEventListener('click',click); window.addEventListener('keydown',keydown,true);
  const retire = () => { disposed = true; clear(false); current.dispose(); root.removeEventListener('click',click); window.removeEventListener('keydown',keydown,true); window.removeEventListener('doctorcre-session-invalidated',retire); };
  window.addEventListener('doctorcre-session-invalidated',retire);
  return {dispose:retire};
}
