// V5-UX-B03 — the Deals board's decisions, with no DOM in sight.
//
// Everything this module answers is a question about records and words: which
// columns exist and in what order, which column a record sits in, what a move
// would send, which of the optional follow-ups the person actually filled in,
// and what each of those says in the dock. js/pipeline.js does the painting and
// the sending; it decides nothing that is written down here.
//
// Two rules shape the file:
//
//   1. The phases follow the record layer's own `deal_phase` order, and the
//      map between a phase slug and what a person reads is ONE-TO-ONE. The map
//      that shipped before this slice sent two different phases — `research`
//      and `site_selection` — to a single board label, so writing that label
//      back relocated a site-selection deal into research (defect 5e355b84).
//      A round trip through this table returns the slug it started from.
//   2. Nothing here claims a gate. CARR checks a phase change for a non-empty
//      value and an existing record and NOTHING else: no transition table, no
//      precondition, no required evidence. The completion dialog therefore
//      collects things that have honest homes — a note, a next step, a critical
//      date — and says so in those words. A sentence that implied permission
//      would be a lie about the server.

/**
 * @typedef {Object} PipelineColumn
 * @property {string} slug the record layer's `deal_phase` value
 * @property {string} value the client interface's UI phase (js/client.js PHASES)
 * @property {string} label what a person reads on the board
 */

/**
 * The eight phases, in the table's order.
 *
 * `value` is what the client interface already speaks, because the board read,
 * the write and the fixture's own validation all go through it; `label` is what
 * the Kanban prints. They differ in exactly two places, and deliberately: the
 * Deal Room table at /deals has shown "On Deck" and "Diligence" for as long as
 * it has existed and its markup is pinned by several suites, so this surface
 * displays the phase's own name over the client's value rather than renaming a
 * shipped column out from under those tests.
 *
 * @type {readonly PipelineColumn[]}
 */
export const COLUMNS = Object.freeze([
  { slug: 'pending', value: 'On Deck', label: 'Prospective Client' },
  { slug: 'research', value: 'Research', label: 'Research' },
  { slug: 'site_selection', value: 'Site selection', label: 'Site Selection' },
  { slug: 'negotiation', value: 'Negotiation', label: 'Negotiating' },
  { slug: 'legal', value: 'Legal', label: 'Legal' },
  { slug: 'due_diligence', value: 'Diligence', label: 'Due Diligence' },
  { slug: 'closing', value: 'Closing', label: 'Closing' },
  { slug: 'closed', value: 'Closed', label: 'Closed' },
].map((column) => Object.freeze(column)));

/** Phase destinations on the open board. Closing remains available in deal details. */
export const OPEN_COLUMNS = Object.freeze(COLUMNS.filter(column => column.slug !== 'closed'));

/** The column whose slug is this, or null. Never a guess. */
export function columnBySlug(slug) {
  return COLUMNS.find((column) => column.slug === slug) || null;
}

/** The column whose UI phase value is this, or null. */
export function columnByValue(value) {
  return COLUMNS.find((column) => column.value === value) || null;
}

/** What a person should read for a UI phase value; the value itself if unknown. */
export function columnLabel(value) {
  return columnByValue(value)?.label || String(value ?? '');
}

/**
 * Split the board's rows into the parked lane and the seven open columns, in
 * table order. A parked deal goes to the lane whatever its phase.
 *
 * A record whose phase is not one of the eight is NOT dropped and NOT filed
 * under a guess: it is returned separately, so the page can say that the board
 * holds something this surface cannot place instead of quietly hiding it.
 *
 * @param {Array<Object>} deals
 * @returns {{columns: Array<PipelineColumn & {deals: Object[]}>, parked: Object[], unplaced: Object[]}}
 */
export function groupByColumn(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const columns = OPEN_COLUMNS.map((column) => ({ ...column, deals: [] }));
  const byValue = new Map(columns.map((column) => [column.value, column]));
  const parked = [];
  const unplaced = [];
  for (const deal of rows) {
    if (!deal || typeof deal !== 'object') continue;
    const column = byValue.get(deal.phase);
    if (deal.operating_state === 'parked') parked.push(deal);
    else if (column) column.deals.push(deal);
    else if (deal.phase !== 'Closed' && deal.phase !== 'closed') unplaced.push(deal);
  }
  return { columns, parked, unplaced };
}

/** The board's headline, counted from the same cards the columns and the lane show. */
export function boardHeadline({ columns, parked }) {
  const open = columns.reduce((sum, column) => sum + column.deals.length, 0);
  return `${open} open deals · ${parked.length} parked`;
}

/**
 * What a drop would change, or null when it would change nothing.
 *
 * The value is the client interface's UI phase, because that is the vocabulary
 * `patchDealField` takes in both adapters; the slug travels alongside it so a
 * caller can name the column without translating back.
 *
 * @param {Object} deal a board row
 * @param {string} toSlug the target column's `deal_phase`
 */
export function moveIntent(deal, toSlug) {
  if (!deal || !deal.id) return null;
  const to = columnBySlug(toSlug);
  if (!to) return null;
  const from = columnByValue(deal.phase);
  if (from && from.slug === to.slug) return null;
  return Object.freeze({
    deal: deal.id,
    name: deal.name || 'this record',
    field: 'phase',
    value: to.value,
    from: from ? from.slug : null,
    ...(Number.isSafeInteger(deal.seen) && { seen: deal.seen }),
    from_label: from ? from.label : String(deal.phase ?? 'an unplaced phase'),
    to: to.slug,
    to_label: to.label,
  });
}


/** The move, said the way a person reading a receipt would say it. */
export function moveSummary(intent) {
  if (!intent) return '';
  return `${intent.name} → ${intent.to_label}`;
}

/** The title the completion dialog carries. */
export function moveTitle(intent) {
  return intent ? `Move this deal to ${intent.to_label}?` : 'Move';
}

/**
 * The one extra sentence the Closed column owes.
 *
 * A phase patch to `closed` leaves the deal's outcome NULL, and the board view
 * keeps every record whose outcome is NULL — so the card would land in Closed
 * with nothing said about how it ended. `update-deal` is now pinned on this
 * app's interface, so the Closed dialog collects the outcome and the closing
 * date and writes them, and this sentence says exactly what will be written.
 * It still claims no gate: CARR checks the outcome against its own enum and
 * nothing else.
 */
export function closedColumnCaption() {
  return 'Records the outcome and the closing date on the deal.';
}

/**
 * The three outcomes the record layer accepts, and nothing else.
 *
 * `deal_outcome_check` constrains the column to exactly these values, so the
 * dialog offers exactly these values. A fourth chip here would be a write the
 * database refuses after the phase has already moved.
 */
export const DEAL_OUTCOMES = Object.freeze([
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'paused', label: 'Paused' },
].map((entry) => Object.freeze(entry)));

/** The slug of the one column that records an outcome. */
export const CLOSED_SLUG = 'closed';

/** Is this outcome one the record layer will take? */
export function isDealOutcome(value) {
  return DEAL_OUTCOMES.some((entry) => entry.value === value);
}

/** The `kind` a critical date created by a phase move carries. */
export const PHASE_DATE_KIND = 'phase_effective_date';

const text = (value) => String(value ?? '').trim();

function closingPlan(intent, form) {
  const { outcome } = form;
  if (outcome !== 'won' && outcome !== 'lost') return { steps: [], errors: ['Choose Won or Lost.'] };
  const closed_on = text(form.closedOn);
  if (!closed_on) return { steps: [], errors: ['Choose the closing date.'] };
  const fields = { outcome, closed_on };
  if (outcome === 'lost') {
    fields.lost_reason = text(form.lostReason);
    if (!fields.lost_reason) return { steps: [], errors: ['Enter the reason the deal was lost.'] };
  } else if (text(form.wonValue)) {
    fields.won_value = Number(form.wonValue);
    if (!Number.isFinite(fields.won_value) || fields.won_value <= 0) {
      return { steps: [], errors: ['Enter a positive closed value or leave it blank.'] };
    }
  }
  return { errors: [], steps: [{
    verb: 'update-deal',
    args: { deal: intent.deal, seen_change_id: intent.seen, phase_from: intent.from, fields },
    summary: `Close ${intent.name}`,
  }] };
}

/**
 * The ordered writes one Move would make, and the reasons it cannot be made.
 *
 * For an open phase move or a legacy closing, the phase patch is first: it is the move, and the
 * follow-ups are things a person chose to record alongside it. Each follow-up
 * appears only when it was filled in, and each is its own verb with its own
 * summary because each gets its own idempotency key and its own receipt — a
 * note that fails must never un-move a card the server already moved.
 *
 * The only refusal is the one the record layer itself would make: `add-critical-date`
 * requires a source, so asking for the date without saying where it came from is
 * named here rather than sent and bounced.
 *
 * A legacy move into Closed carries one more step, and it is deliberately LAST: the
 * outcome is a second write on a record the phase patch has already moved, it
 * needs a `base_version` read fresh AFTER that patch, and a refusal on it must
 * leave the card where the server put it. The plan names the step and the
 * fields; the caller supplies `base_version` at the moment it sends, because a
 * version this module captured would already be stale by then.
 *
 * @param {ReturnType<typeof moveIntent>} intent
 * @param {{changeReason?:string, outcome?:string, closedOn?:string,
 *          wonValue?:string|number, lostReason?:string}} [form]
 * @returns {{steps: Array<{verb:string, args:Object, summary:string}>, errors: string[]}}
 */
export function completionPlan(intent, form = {}) {
  const errors = [];
  if (!intent) return { steps: [], errors: ['There is no move to make.'] };
  if (intent.to === CLOSED_SLUG && Number.isSafeInteger(intent.seen)) return closingPlan(intent, form);

  // The reason rides on the phase patch, not a follow-up verb, so it shares the
  // move's write and receipt. A blank box sends no key at all.
  const phaseArgs = { deal: intent.deal, field: 'phase', value: intent.value };
  const changeReason = text(form.changeReason);
  if (changeReason) phaseArgs.change_reason = changeReason;
  const steps = [{ verb: 'patch-deal-field', args: phaseArgs, summary: moveSummary(intent) }];

  if (intent.to === CLOSED_SLUG) {
    const outcome = text(form.outcome);
    if (intent.wonOrLost && outcome !== 'won' && outcome !== 'lost') {
      errors.push('Choose Won or Lost.');
    } else if (!outcome) {
      errors.push('Choose the outcome — Won, Lost or Paused — before closing this record.');
    } else if (!isDealOutcome(outcome)) {
      errors.push('Select won, lost, or paused.');
    } else {
      const fields = { outcome };
      const closedOn = text(form.closedOn);
      if (closedOn) fields.closed_on = closedOn;
      // The money only belongs to a won record. A value typed against Won and
      // then switched to Lost is DROPPED here rather than written, because a
      // lost deal with a won value on it is a record nobody can read honestly.
      if (outcome === 'won') {
        const raw = text(form.wonValue);
        if (raw) {
          const amount = Number(raw);
          if (!Number.isFinite(amount)) errors.push('The won value must be a number, or leave it empty.');
          else fields.won_value = amount;
        }
      }
      if (!errors.length) {
        steps.push({
          verb: 'update-deal',
          args: { deal: intent.deal, fields },
          summary: `Outcome ${outcome} on ${intent.name}`,
        });
      }
    }
  }

  return { steps, errors };
}

/**
 * The column the arrow keys choose next, wrapping at both ends.
 *
 * Right and Down step forward, Left and Up step back — the same pairing the
 * prototype used, because a board that scrolls sideways is read both ways.
 * Anything else returns null, which the caller reads as "this key is not mine".
 *
 * @param {string} current the slug currently chosen
 * @param {string} key a KeyboardEvent key
 * @param {readonly PipelineColumn[]} [columns]
 * @returns {string|null}
 */
export function keyboardTarget(current, key, columns = COLUMNS) {
  const list = Array.isArray(columns) ? columns : [];
  if (list.length === 0) return null;
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return null;
  const index = list.findIndex((column) => column.slug === current);
  const from = index < 0 ? 0 : index;
  return list[(from + step + list.length) % list.length].slug;
}

/**
 * What a partner's open lease on this record says, or null.
 *
 * Only a lease belonging to someone else is a chip: a person does not need to be
 * told they are editing. Nothing is inferred about what the partner will do.
 *
 * @param {Array<Object>} presence leases as the changes feed returns them
 * @param {string} dealId
 * @param {{selfActor?:string|null, field?:string|null, actorLabel?:(slug:string)=>string}} [options]
 */
export function presenceChip(presence, dealId, options = {}) {
  const leases = Array.isArray(presence) ? presence : [];
  const label = options.actorLabel || ((slug) => slug);
  const field = options.field ?? null;
  for (const lease of leases) {
    if (!lease || lease.deal_id !== dealId) continue;
    if (field && lease.field !== field) continue;
    if (options.selfActor && lease.actor === options.selfActor) continue;
    if (!lease.actor) continue;
    return `${label(lease.actor) || lease.actor} is editing`;
  }
  return null;
}

// A note or next step can reach this board as a sentence, an object such as
// {text, at}, a list of those, or any of them printed into a string as JSON or
// a Python repr ("[{'text': '...', 'date': '...'}]"). Cards and the panel show
// the sentences only.
const NOTE_KEYS = ['text', 'note', 'body', 'summary', 'content', 'message'];
const PY_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
// The escapes Python's repr writes; a lone backslash matches the last branch.
const PY_ESCAPE = /\\(?:([ntr\\'"])|x([\da-fA-F]{2})|u([\da-fA-F]{4})|U(000[\da-fA-F]{5}|0010[\da-fA-F]{4}))|\\/g;
const PY_DICT = String.raw`\{(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^{}'"])*\}`;
const PY_FLAT_DICT = new RegExp(`^${PY_DICT}$`);

function dictSentence(raw) {
  try {
    return noteText(JSON.parse(raw));
  } catch { /* not JSON; try the Python repr */ }
  if (!PY_FLAT_DICT.test(raw)) return null;
  for (const key of NOTE_KEYS) {
    const match = new RegExp(`['"]${key}['"]\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(raw);
    if (match) return pyString(match[2]);
  }
  return '';
}

// The text a repr string body stands for, or null when an escape is not one Python writes.
function pyString(body) {
  let known = true;
  const text = body.replace(PY_ESCAPE, (_, ch, x, u, U) => {
    const code = x ?? u ?? U;
    if (ch) return PY_ESCAPES[ch];
    if (code) return String.fromCodePoint(parseInt(code, 16));
    known = false;
    return '';
  });
  return known ? text.trim() : null;
}

// A list it cannot read in full prints as written, so no note is silently hidden.
function listSentence(raw) {
  let texts;
  try {
    texts = JSON.parse(raw).map(jsonItemText);
  } catch {
    texts = pythonListTexts(raw);
  }
  return !texts || texts.includes(null) ? raw : texts.filter(Boolean).join('; ');
}

function jsonItemText(item) {
  if (typeof item === 'string') return noteText(item) || (item.trim() ? null : '');
  if (item && typeof item === 'object' && !Array.isArray(item)) return noteText(item) || null;
  return null;
}

const PY_ITEM = String.raw`(${PY_DICT})|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"`;
const PY_ITEMS = new RegExp(PY_ITEM, 'g');
const PY_LIST = new RegExp(String.raw`^\[\s*(?:${PY_ITEM})(?:\s*,\s*(?:${PY_ITEM}))*\s*\]$`);

function pythonListTexts(raw) {
  if (!PY_LIST.test(raw)) return null;
  return [...raw.matchAll(PY_ITEMS)].map(([, dict, single, double]) => (dict ? dictSentence(dict) || null : pyString(single ?? double)));
}

// A name written as a structured value ({"value":"…"}, seen on staging) reads
// as its text; anything else falls through to the note rules.
export function dealName(value) {
  const wrapped = typeof value === 'string' && /^\s*\{\s*"value"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(value);
  const text = wrapped ? JSON.parse(`"${wrapped[1]}"`).trim() : noteText(value);
  return text || 'Untitled deal';
}

/**
 * The sentence a note value carries, or '' when it carries none. A string
 * that is one dict never paints as raw braces; braces it cannot read print as
 * written.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function noteText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(noteText).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    for (const key of NOTE_KEYS) {
      const inner = noteText(value[key]);
      if (inner) return inner;
    }
    return '';
  }
  const text = String(value).trim();
  if (/^\{[\s\S]*\}$/.test(text) && (text === '{}' || /^\{\s*['"]/.test(text))) return dictSentence(text) ?? text;
  if (/^\[\s*(?:\]$|[{'"][\s\S]*\]$)/.test(text)) return listSentence(text);
  return text;
}

/* --------------------------------------------------------- V5-UX-B04: context */

// deal_participant carries five roles. 'lead' and 'support' are internal team
// assignment (actor_id, no party_id); these three carry an external party_id
// and are what the context
// drawer means by "attached parties/vendors".
const EXTERNAL_PARTY_ROLES = ['client_contact', 'referring_agent', 'listing_side'];
const PARTY_ROLE_LABEL = {
  client_contact: 'Client contact',
  referring_agent: 'Referring agent',
  listing_side: 'Listing side',
};

/** The word for a deal_participant role; the wire value itself when unmapped. */
export function partyRoleLabel(role) {
  return PARTY_ROLE_LABEL[role] || role || 'Party';
}

/**
 * The attached parties/vendors on a deal — the external `deal_participant`
 * rows, exactly as `get-deal-room` returned them. Never filled in from a
 * second read: their contact detail is not addressable here (see
 * `loadDealContext`), so this stays a name-and-role list.
 */
export function attachedParties(participants = []) {
  return participants.filter((row) => EXTERNAL_PARTY_ROLES.includes(row?.role));
}

/** Read exact client identity and recorded vendor-to-deal evidence only. */
export async function loadDealContext(client, detail) {
  const deal = detail?.deal || {};
  const id = deal.client_id || deal.account_client_id;
  let record = null;
  const status = id ? 'unavailable' : 'not_linked';
  if (id && client?.getPartyRecord) {
    try { record = (await client.getPartyRecord({dataset:'clients',id}))?.record || null; } catch (error) { if ([401,403].includes(error?.status)) throw error; }
  }
  let vendors = [], vendorsStatus = 'unavailable';
  if (client?.getRelationshipNetwork && deal.id) {
    try {
      const network = await client.getRelationshipNetwork();
      const linked = new Set((network.edges || []).filter(e => e.to === `deal:${deal.id}` && e.kind !== 'client_deal').map(e => e.from));
      if (!Array.isArray(network.nodes) || !Array.isArray(network.edges)) throw new Error('Invalid network');
      vendors = network.nodes.filter(n => n.kind === 'vendor' && linked.has(n.id));
      vendorsStatus = 'ready';
    } catch (error) { if ([401,403].includes(error?.status)) throw error; }
  }
  if (record && !record.id) record = {...record,id};
  return {client: record ? {status:'ok',record} : {status,reason:id ? 'fetch_failed' : undefined}, vendors, vendorsStatus,
    parties:attachedParties(detail?.participants || []),criticalDates:detail?.critical_dates || []};
}
function contextPhone(phone) {
  return phone?.replace(/^\+1(\d{3})(\d{3})(\d{4})(?=\s+x\d+$|$)/i, '($1) $2-$3');
}

export function contextDrawerSections(context, options = {}) {
  const sections = [];
  const record = context?.client?.record;
  if (record) sections.push({title:'Client',links:record.id ? [{label:'Open client record',href:`/clients?record=${encodeURIComponent(record.id)}`}] : [],lines:[record.name,
    [record.title,contextPhone(record.phone),contextPhone(record.cell),record.email].filter(Boolean).join(' · '),
    [record.city,record.state].filter(Boolean).join(', ')].filter(Boolean)});
  if (context?.client?.status === 'unavailable') sections.push({title:'Client',state:'unavailable',lines:['Client details unavailable. Retry to load this section.']});
  if (context?.vendorsStatus === 'unavailable') sections.push({title:'Vendors',state:'unavailable',lines:['Vendor details unavailable. Retry to load this section.']});
  const parties = context?.parties || [];
  if (parties.length) sections.push({title:'Attached parties',lines:parties.map(p => `${partyRoleLabel(p.role)} · ${p.name}`)});
  if (context?.vendors?.length) sections.push({title:'Vendors',links:context.vendors.filter(v=>v.record_id).map(v=>({label:`Open ${v.name}`,href:`/vendors?record=${encodeURIComponent(v.record_id)}`})),lines:context.vendors.map(v => [v.name,v.territory,v.summary].filter(Boolean).join(' · '))});
  if (!sections.length) return sections;
  const date = options.dateLabel || String;
  if (context?.criticalDates?.length) sections.push({title:'Critical dates',lines:context.criticalDates.map(d => `${d.label || d.kind} · ${date(d.date || d.due_on)}${d.source ? ` · ${d.source}` : ''}`)});
  return sections;
}

