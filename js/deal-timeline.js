import { createMcpRequests } from './mcp-requests.mjs';
import { createCurrentRead } from './current-read.mjs';
import { sessionFetch } from './private-session.js';

import { businessDay } from './business-date.js';
import { COLUMNS, columnBySlug, columnByValue, noteText, PHASE_DATE_KIND } from './pipeline-model.js';
import { compareInstants, escapeText, fieldLabel, readableValue } from './change-receipts.mjs';
import { sourceTime } from './email-source-line.js';
import { concise, isEngineDealDetail, PARKING_REASONS } from './local-deals-model.js';
import { ACTOR_LABEL, authorLabel, dealTypeLabel, knownAuthor } from './client.js';

const DAY = 86400000;
const esc = escapeText;
// Wire kinds, never prose matching or dates inferred from lease duration.
const DATE_KINDS = [
  { kind: 'loi_expiry', label: 'LOI expiry', aliases: ['loi', 'loi_due'], saveKind: 'loi_expiry', deadline: true },
  { kind: 'due_diligence', label: 'Due diligence', aliases: ['due_diligence_deadline', 'dd_deadline'], saveKind: 'due_diligence', deadline: true },
  { kind: 'lease_commencement', label: 'Lease commencement', aliases: ['commencement'] },
  { kind: 'lease_expiration', label: 'Lease expiration', saveKind: 'lease_end', deadline: true },
  { kind: 'rent_start', label: 'Rent start', aliases: ['rent_commencement'], saveKind: 'rent_start' },
  { kind: 'option_window', label: 'Option notice', aliases: ['option_exercise'], saveKind: 'option_notice', deadline: true },
  { kind: PHASE_DATE_KIND, label: 'Phase effective date', saveKind: PHASE_DATE_KIND },
  { kind: 'other', label: 'Other', saveKind: 'other' },
];

export const CRITICAL_DATE_OPTIONS = DATE_KINDS.flatMap(({ saveKind, label }) => saveKind ? [[saveKind, label]] : []);
const dateKind = kind => kind && DATE_KINDS.find(d => d.kind === kind || d.saveKind === kind || d.aliases?.includes(kind));

function criticalDateLabel(kind, definition = dateKind(kind)) {
  const words = kind?.replace(/[_-]+/g, ' ') || '';
  return definition?.label || words.charAt(0).toUpperCase() + words.slice(1);
}

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
  if (days > 0) return {state:days <= 7 && date.deadline ? 'soon':'upcoming',text:`in ${spanText(days)}`};
  return {state:date.deadline ? 'overdue':'past',text:`${spanText(-days)} ${date.deadline ? 'late' : 'ago'}`};
}
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const spanText = days => days > 60 ? plural(Math.round(days / 30.4), 'month') : plural(days, 'day');
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
    const definition = dateKind(row.kind);
    const value = row.due_on ?? row.date;
    const original = noteText(row.note);
    const namedOther = row.kind === 'other' && !isEngineDealDetail(detail) && original;
    const kindLabel = criticalDateLabel(row.kind, definition);
    return {dateState:calendarDay(value) ? 'dated' : value == null || value === '' ? 'missing' : 'invalid',id:row.id || `date-${i}`,kind:definition?.kind || row.kind,label:namedOther || kindLabel || row.label || 'Date',
      day:calendarDay(value),original:namedOther ? '' : original,
      evidence:row.source || '',status:row.status,deadline:Boolean(definition?.deadline)};
  });
  // Co-located dates share a card, preserving every original and status.
  const grouped = new Map();
  const undated = rows.filter(row => !row.day);
  for (const row of rows.filter(row => row.day)) {
    const key = dateDecisions && isSavedDate(row) ? row.id
      : JSON.stringify([row.kind, row.day, row.status || '', row.kind === 'other' ? row.original || row.label : null]);
    const existing = grouped.get(key);
    const references = [row.original,row.evidence].filter(Boolean);
    if (existing) existing.references.push(...references);
    else grouped.set(key,{...row,references});
  }
  const dates = [...grouped.values()].map(({references,...row}) => ({...row,
    original:[...new Set(references)].join('\n\n')})).sort((a,b) => a.day.localeCompare(b.day));
  const entries = (detail.entries || []).filter(e => e.source !== 'hold').map(e => ({...e, day:calendarDay(e.when), type:e.kind}));
  return {phases,dates,undated,entries,today:today(now)};
}

const isSavedDate = row => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(row.id);
// Settled dates no longer matter for what is coming; Activity keeps their history.
const SETTLED = new Set(['cleared', 'done', 'dropped', 'passed']);
const unsettled = d => !SETTLED.has(d.status);
const DATE_STATES = new Map([['proposed','Proposed'], ['open','Confirmed'], ['cleared','Done'], ['done','Done'], ['dropped','Dropped'], ['passed','Passed']]);
const DATE_RESOLUTIONS = new Map([['done', 'Mark done'], ['dropped', 'Drop'], ['passed', 'Mark passed']]);
const dateAsk = resolution => `<button type="button" class="btn" data-date-ask="${resolution}">${DATE_RESOLUTIONS.get(resolution)}</button>`;
const dateFormId = id => `critical-date-form-${id}`;
function dateDecisionsHtml(date) {
  const open = date.status === 'open';
  const proposed = date.status === 'proposed';
  return open || proposed ? `
    <form id="${esc(dateFormId(date.id))}" data-date-decision="${esc(date.id)}">
      <div class="date-reason" hidden>
        <label>Reason <input name="reason" required maxlength="1000" data-detail-focus="date-reason:${esc(date.id)}"></label>
        <button type="submit" class="btn"></button>
        <button type="button" class="btn btn-quiet" data-date-ask="">Cancel</button>
      </div>
      <div class="date-actions">
        ${proposed ? '<button type="submit" class="btn" value="confirm" formnovalidate>Confirm</button>' : dateAsk('done')}
        ${dateAsk('dropped')}
        ${open ? dateAsk('passed') : ''}
      </div>
    </form>` : '';
}
// A resolution needs a reason, asked in place; an empty choice goes back to the actions.
export function askDateReason(form, resolution) {
  const label = DATE_RESOLUTIONS.get(resolution);
  const panel = form.querySelector('.date-reason');
  form.querySelector('.date-actions').hidden = Boolean(label);
  panel.hidden = !label;
  if (!label) return;
  const submit = panel.querySelector('[type="submit"]');
  submit.value = resolution;
  submit.textContent = label;
}

function tileDay(day, now) {
  const sameYear = day.slice(0, 4) === today(now).slice(0, 4);
  return new Date(`${day}T12:00:00Z`).toLocaleDateString([], sameYear
    ? { weekday:'short', month:'short', day:'numeric', timeZone:'UTC' }
    : { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
}
// The name is the tile's one button; its hit area stretches over the whole tile.
function dateTile(d, body, { proposed = false, panel }) {
  const panelId = `critical-date-${d.id}`;
  return `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="${body.state}">
    <h3><button type="button" class="date-open" popovertarget="${esc(panelId)}" data-detail-focus="date-open:${esc(d.id)}">${esc(d.label)}</button>${proposed ? '<span class="date-proposed">proposed</span>' : ''}</h3>
    ${body.html}
    <div popover id="${esc(panelId)}" class="date-panel" role="dialog" aria-label="${esc(d.label)}">${panel}</div></article>`;
}
// A dated row's original already folds in its source; an undated row keeps them apart.
function datePanel(d, status, decided) {
  return `<h3>${esc(d.label)}</h3>
    <p>${d.day ? `<time datetime="${esc(d.day)}">${esc(dateCaption(d.day))}</time>` : 'Date not recorded'}${status ? ` · ${esc(status)}` : ''}</p>
    ${d.original ? `<p class="note-original">${esc(d.original)}</p>` : ''}${!d.day && d.evidence ? `<p class="date-source">Source: ${esc(d.evidence)}</p>` : ''}
    ${decided ? dateDecisionsHtml(d) : ''}`;
}
function datedTile(d, now, dateDecisions) {
  const decided = dateDecisions && isSavedDate(d);
  const proposed = decided && d.status === 'proposed';
  const count = countdown(d, now);
  const day = `<time datetime="${esc(d.day)}">${esc(tileDay(d.day, now))}</time>`;
  const until = `<strong data-countdown="${esc(d.day)}" data-deadline="${Boolean(d.deadline)}" data-date-status="${esc(d.status || '')}">${esc(count.text)}</strong>`;
  const confirm = proposed ? `<button type="submit" class="btn date-confirm" form="${esc(dateFormId(d.id))}" value="confirm" formnovalidate>Confirm</button>` : '';
  return dateTile(d, { state: count.state, html: `<p>${day}<span>${until}${confirm}</span></p>` },
    { proposed, panel: datePanel(d, decided && DATE_STATES.get(d.status), decided) });
}
function undatedTile(d) {
  const text = d.dateState === 'missing' ? 'Date not recorded' : 'Date unavailable';
  return dateTile(d, { state: 'unknown', html: `<p><strong>${text}</strong>${d.status ? `<small>Status: ${esc(d.status)}</small>` : ''}</p>` },
    { panel: datePanel(d, d.status, false) });
}

// One row, soonest first; the add tile closes it, or one line says there are none.
export function renderCriticalDates(detail, now = Date.now(), dateDecisions = false, canAdd = false) {
  const view = dealTimeline(detail, now, dateDecisions);
  const tiles = [
    ...view.dates.filter(unsettled).map(d => datedTile(d, now, dateDecisions)),
    ...view.undated.filter(unsettled).map(undatedTile),
  ];
  const body = tiles.length
    ? `${tiles.join('')}${canAdd ? '<button type="button" class="critical-date-add" popovertarget="addDatePanel" aria-label="Add date">+</button>' : ''}`
    : `<p class="critical-dates-empty">No critical dates${canAdd ? '<button type="button" class="btn" popovertarget="addDatePanel">+ Add date</button>' : ''}</p>`;
  return `<section class="critical-dates" data-detail-read="dates" aria-label="Critical dates">${body}</section>`;
}

const timelineActor = actor => knownAuthor(actor) ?? (actor ? 'Automatically' : '');
const activityLabels = { call: 'Call', email: 'Email', meeting: 'Meeting' };
const STEP_STATES = new Map([['done', 'Done'], ['cancelled', 'Cancelled'], ['expired', 'Expired']]);
const closedMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', trailingZeroDisplay: 'stripIfInteger' });

function changeText({ verb, field, new_value }, planTours) {
  if (planTours && verb === 'cancel-tour') return 'Tour cancelled';
  if (field === 'phase') {
    const phase = new_value === 'dead' ? 'Lost' : columnBySlug(new_value)?.label || readableValue(field, new_value);
    return `Moved to ${phase}`;
  }
  if (field === 'operating_state') {
    if (new_value?.state === 'parked') {
      const reason = PARKING_REASONS.get(new_value.reason);
      const note = typeof new_value.note === 'string' ? new_value.note : '';
      return ['Parked', reason, note].filter(Boolean).join(' · ');
    }
    const state = typeof new_value === 'string' ? new_value : readableValue(field, new_value);
    return /^(active|active work)$/i.test(state) ? 'Active again' : state;
  }
  if (field === 'attention' && typeof new_value === 'boolean') {
    return new_value ? 'Needs attention' : 'Needs attention cleared';
  }
  const label = field === 'won_value' ? 'Closed value' : fieldLabel(field);
  let value = readableValue(field, new_value, { actorLabel: timelineActor });
  if (field === 'won_value' && Number.isFinite(new_value)) value = closedMoney.format(new_value);
  if (typeof new_value === 'string' && new_value.length === 10 && calendarDay(new_value)) value = dateCaption(new_value);
  return label ? `${label} · ${value}` : 'Deal changed';
}

export function engineTimelineEntries(detail, { planTours = false } = {}) {
  const notes = detail.thread || [];
  const noteIds = new Set(notes.map(note => note.id));
  /** @type {{ type: string, when: string, actor: string, text: string }[]} */
  const entries = [
    ...notes.map(note => ({ type: 'Note', when: note.created_at, actor: note.actor, text: noteText(note.text) })),
    ...(detail.activities || []).map(activity => ({
      type: activityLabels[activity.kind] || 'Activity', when: activity.occurred_at,
      actor: activity.actor, text: noteText(activity.summary).trim() || noteText(activity.detail),
    })),
    ...(detail.documents || []).map(file => ({
      type: 'Document', when: file.prepared_at, actor: file.actor, text: file.name,
    })),
    ...(detail.next_actions || []).map(step => ({
      type: step.title ? 'Checklist item' : 'Next step', when: step.updated_at || step.due_on, actor: step.actor,
      text: [
        step.title || step.description,
        STEP_STATES.get(step.status),
        step.updated_at && calendarDay(step.due_on) && `Due ${dateCaption(step.due_on)}`,
      ].filter(Boolean).join(' · '),
    })),
    ...(detail.critical_dates || []).map(date => {
      const label = criticalDateLabel(date.kind) || 'Date';
      const due = calendarDay(date.due_on) && `Due ${dateCaption(date.due_on)}`;
      return {
        type: 'Critical date', when: date.updated_at, actor: date.actor,
        text: [...new Set([label, DATE_STATES.get(date.status), due, date.note].filter(Boolean))].join(' · '),
      };
    }),
    ...(detail.history || []).filter(event => !noteIds.has(event.activity_id)).map(event => ({
      type: event.field === 'note' ? 'Note' : event.field === 'phase' ? 'Phase move' : 'Change',
      when: event.recorded_at, actor: event.actor,
      text: event.field === 'note' ? noteText(event.new_value) : changeText(event, planTours),
    })),
  ];
  return entries.flatMap(({ type, when, actor, text }) => {
    if (!text?.trim() || !calendarDay(when)) return [];
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

const OLD_HISTORY_ACTION = new Map(Object.entries({
  'add-critical-date': 'Added a critical date',
  'add-premises': 'Added space to the deal',
  'backfill-document-attachments:document.attachments': 'Added document attachments',
  'complete-action:status': 'Finished a next step',
  'complete-one-action:status': 'Finished a next step',
  'create-national-market-deal': 'Opened a national account deal',
  'dismiss-email-proposal': 'Dismissed an email suggestion',
  import: 'Imported the deal',
  'log-activity': 'Logged an activity',
  'log-decision:decision': 'Added a decision',
  'new-deal': 'Opened the deal',
  'prepare-document:document': 'Prepared a document',
  'reattach-deal:client_id': 'Linked the deal to a client',
  'record-counter': 'Logged a counteroffer',
  'record-finding:address': 'Checked the address',
  'record-finding:code_requirement': 'Checked building code requirements',
  'record-finding:discrepancy': 'Checked for a discrepancy',
  'record-finding:market_study': 'Added market research',
  'record-finding:verified': 'Ran a verification check',
  'register-client-portal:client_portal': 'Set up the client website',
  'resolve-post-call-candidate:next_action': 'Confirmed a next step from a call',
  'set-lead': 'Changed the deal owner',
  'set-market-agent:market_agent': 'Changed the market agent',
  'set-next-action': 'Set a next step',
  'set-next-action:next_date': 'Changed the next step date',
  'set-next-step:next_step': 'Changed the next step',
  'update-deal:closed_on': 'Changed the closing date',
  'update-deal:invoiced_on': 'Changed the invoice date',
  'update-deal:lane': 'Changed the board lane',
  'update-deal:notes_path': 'Updated where the deal notes are kept',
  'update-deal:outcome': 'Changed the deal outcome',
  'update-deal:phase': 'Changed the phase',
  'update-deal:salesforce_id': 'Changed the Salesforce reference',
}));

const historicalActor = slug => timelineActor(slug) || 'Author unavailable';
// As a field value, a partner's machine sign-in names that partner; as an author it is the automation.
const HISTORY_PARTNER = { ...ACTOR_LABEL, 'joe-local': ACTOR_LABEL.joe, 'dell-local': ACTOR_LABEL.dell };
const historicalPartner = slug => typeof slug === 'string' && Object.hasOwn(HISTORY_PARTNER, slug) ? HISTORY_PARTNER[slug] : undefined;
const words = value => value.replace(/(^|[_-]+)([a-z])/g, (_, separator, letter) =>
  separator ? ' ' + letter : letter.toUpperCase());
function historicalDay(value) {
  const day = calendarDay(value);
  return day ? dateCaption(day) : 'Date unavailable';
}
const COUNTER_BASIS = new Map([
  ['usd_sf_yr', 'per square foot per year'], ['usd_sf_mo', 'per square foot per month'],
  ['usd_mo_gross', 'gross per month'], ['usd_yr_gross', 'gross per year'],
]);

const OLD_ACTIVITY_NAMES = new Map([
  ...Object.entries(activityLabels),
  ['email_in', 'Email received'], ['email_out', 'Email sent'], ['text', 'Text message'],
  ['counter_sent', 'Counteroffer sent'], ['counter_received', 'Counteroffer received'],
  ['loi', 'Letter of intent'], ['lease_signed', 'Lease signed'],
]);
const OLD_SUGGESTION_NAMES = new Map([
  ['file_to_deal', 'File email to this deal'], ['possible_new_deal', 'Possible new deal'],
  ['phase_move', 'Move to another phase'], ['next_step', 'Set a next step'], ['reply_draft', 'Draft a reply'],
]);
const OLD_HISTORY_KIND = new Map([
  ['add-critical-date', ['Date type', criticalDateLabel]],
  ['log-activity', ['Activity type', kind => OLD_ACTIVITY_NAMES.get(kind) || words(kind)]],
  ['dismiss-email-proposal', ['Suggestion type', kind => OLD_SUGGESTION_NAMES.get(kind) || words(kind)]],
]);

// References to old rows carry no display name. Only show facts the event actually held.
const OLD_HISTORY_FACTS = {
  name: ['Deal name'], client_name: ['Client'],
  phase: ['Phase', value => value === 'dead' ? 'Lost' : columnBySlug(value)?.label || words(value)],
  deal_type: [fieldLabel('kind'), words], market: ['Market'], agent_name: ['Market agent'],
  market_agent: ['Market agent'], lead: ['Deal owner', historicalPartner], owner: ['Assigned to', historicalPartner],
  assignee: ['Assigned to', historicalPartner], set_by: ['Set by', historicalActor],
  lane: ['Board lane', words], next_action: ['Next step'], next_step: ['Next step'],
  description: ['Next step'], summary: ['Summary'], reason: ['Reason'], outcome: ['Outcome', words],
  status: ['Status', words], closed_on: ['Closing date', historicalDay], invoiced_on: ['Invoice date', historicalDay],
  next_date: ['Next step date', historicalDay], due: ['Due date', historicalDay], due_on: ['Due date', historicalDay],
  found: ['Result', value => value ? 'Found' : 'Nothing found'], expires_on: ['Expires', historicalDay],
  proposes_correction: ['Suggested correction to', words], source: ['Where it came from'],
  building_created: ['New building added'], spaces: ['Spaces'], ownership: ['Owners listed'],
  client_portal_url: ['Client website'],
  salesforce_id: ['Salesforce reference'], round: ['Round'], side: ['From', words],
  rate: ['Rate', value => closedMoney.format(value)],
  basis: ['Rate basis', value => COUNTER_BASIS.get(value) || 'Details unavailable'],
  template: ['Template', words], filled: ['Fields filled'], owed: ['Fields still needed'],
  attachments: ['Attachments', value =>
    [value.pdf && 'PDF', value.working && 'Working copy'].filter(Boolean).join(', ') || 'None'],
  dropped_post_call_action_ids: ['Earlier call follow-ups cleared', value => String(value.length)],
};

function historicalValue(value, format) {
  if (value == null || value === '') return 'None';
  if (format) return format(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function importedFacts({ verb, old_value, new_value }) {
  const before = old_value ?? {};
  const after = new_value ?? {};
  const kind = OLD_HISTORY_KIND.get(verb);
  const facts = { ...OLD_HISTORY_FACTS, ...(kind ? { kind } : {}),
    ...(verb === 'new-deal' ? { reason: [fieldLabel('reason'), value => dealTypeLabel(value) || words(value)] } : {}) };
  return Object.entries(facts).flatMap(([key, [label, format]]) => {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    const oldText = had ? historicalValue(before[key], format) : undefined;
    const newText = has ? historicalValue(after[key], format) : undefined;
    // A new value with no name drops the fact: the old name alone would read as current.
    if (has && newText === undefined) return [];
    if (oldText !== undefined && newText !== undefined && oldText !== newText) {
      return [after[key] === null ? `${label} cleared (was ${oldText})` : `${label}: ${oldText} to ${newText}`];
    }
    const text = newText ?? oldText;
    return text === undefined ? [] : [`${label}: ${text}`];
  }).join('\n');
}

export function renderImportedDealHistory(history) {
  if (!Array.isArray(history)) return '';
  const rows = history.filter(entry => entry?.imported === true).reverse().map(event => {
    const key = event.field == null ? event.verb : `${event.verb}:${event.field}`;
    const action = OLD_HISTORY_ACTION.get(key);
    const facts = action ? importedFacts(event) : '';
    return `<li><b>${esc(historicalActor(event.actor))}</b> <time datetime="${esc(event.recorded_at)}">${esc(sourceTime(event.recorded_at))}</time>
      <div>${action || 'Earlier deal activity'}</div>${facts ? `<p class="note-original">${esc(facts)}</p>` : ''}</li>`;
  });
  return rows.length ? `<section aria-labelledby="old-deal-history"><h2 id="old-deal-history">History from the old system</h2><ol class="workspace-events">${rows.join('')}</ol></section>` : '';
}

export function renderDealTimeline(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="deal-timeline" data-detail-read="timeline" aria-label="Deal phases and timeline"><h3>Phase timeline</h3><ol class="phase-rail">${view.phases.map(p => `<li${p.current ? ' aria-current="step"' : ''}><span>${esc(p.label)}</span>${p.day ? `<time datetime="${esc(p.day)}">${esc(dateCaption(p.day))}</time>` : ''}</li>`).join('')}</ol></section>`;
}
export function renderDealUpdates(detail, now = Date.now(), { engineSignIn = false, noteHtml = esc } = {}) {
  const entries = (detail.entries || []).filter(e => e.source !== 'document' && (e.source !== 'hold' || calendarDay(e.holdUntil) > today(now)))
    .map(e => e.source === 'hold' ? {...e, kind:`Held until ${dateCaption(calendarDay(e.holdUntil))}`} : e);
  if (!entries.length) return '';
  const notes = engineSignIn && isEngineDealDetail(detail) ? (detail.thread || []).filter(note => note.kind === 'note') : [];
  const activityIds = new Set([...(detail.activities || []), ...notes]
    .map(activity => activity.id)
    .filter(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)));
  const overview = concise(entries[0]?.summary, 72);
  const latestDate = new Date(entries[0].when || NaN);
  const latestDay = Number.isFinite(latestDate.getTime()) ? latestDate.toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}) : 'Date not recorded';
  const attribution = id => activityIds.has(id)
    ? `<button type="button" class="btn" data-attribution-id="${esc(id)}" aria-expanded="false">Show deal attribution</button>`
    : '';
  return `<section class="deal-updates" data-detail-read="updates" aria-label="Deal updates"><h3>Updates</h3>${entries.length ? `<details class="updates-history"><summary data-detail-focus="update-history"><span>${entries.length} update${entries.length === 1 ? '' : 's'} · ${esc(latestDay)} · ${esc(overview)}</span></summary>${(detail.activities || []).length >= 50 ? '<p class="updates-scope">Includes the latest 50 activities; older activities may be omitted.</p>' : ''}${entries.map(e => `<article class="deal-note" data-id="${esc(e.id)}" data-kind="${esc(e.kind)}"><div class="timeline-entry-top"><b>${esc(authorLabel(e.actor))}</b><time datetime="${esc(e.when || '')}">${esc(sourceTime(e.when, undefined, 'Date not recorded'))}</time></div><small>${esc(e.kind)}</small><p>${noteHtml(e.summary)}</p>${attribution(e.id)}${e.original && e.original !== e.summary ? `<details><summary data-detail-focus="entry-original:${esc(e.id)}">Read full update</summary><p class="note-original">${noteHtml(e.original)}</p></details>` : ''}</article>`).join('')}</details>` : '<p>No updates recorded.</p>'}</section>`;
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
export function mountActivityAttribution(root, { engineSignIn = false, read = createActivityAttributionRead(), load = () => import('./ui-activity-attribution.generated.js'), onDenied = () => {} } = {}) {
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
      const activityId = trigger.dataset.attributionId;
      if (engineSignIn) {
        const response = await operation.read(sessionFetch(`/api/engine/activities/${encodeURIComponent(activityId)}/deal-attribution`, {
          signal: operation.signal,
        }));
        return module.decodeEngineActivityDealAttribution(response);
      }
      const response = await operation.read(read(activityId, operation.signal));
      return module.parseActivityDealAttribution(response, activityId);
    }, {
      success(value) { view.update({kind:'result',value}); },
      failure(error) {
        if ([401,403].includes(error?.status)) { retire(); onDenied(error); return; }
        const timedOut = error?.code === 'read_timeout' || error?.name === 'TimeoutError';
        if (view) view.update({kind: engineSignIn && timedOut ? 'sign-in' : 'failure'});
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
