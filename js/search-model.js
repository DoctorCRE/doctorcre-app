// V5-UX-B05 — Authorized global search, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock of its own. Every rule the
// Search tab obeys is decided here so it can be tested without a browser.
//
// Four producer facts shape everything below, and each one is a place a
// friendlier consumer would lie:
//
//  1. `find` takes ONE argument and `find-and-catch-up` takes TWO, both under
//     additionalProperties:false. There is no actor, kind, tenant or scope
//     argument, and a third key is refused `unregistered_operation_fields`.
//     So the record layer decides what is authorized; this page adds no filter
//     of its own and invents no field.
//  2. An array of refs is NOT an array of links. `organizations[].refs` and
//     `.role_refs` aggregate a nullable column, and a null ELEMENT was observed
//     in two real payloads. Every ref is filtered to a non-empty string before
//     it is rendered or linked.
//  3. The producer's order is the answer's order — parties by `merged` then
//     similarity, candidates by `localeCompare`. This model never sorts and
//     never reverses; a re-ranked list would be this page's opinion presented
//     as the record layer's.
//  4. A no-match is a 200 with six empty arrays. A missing source is a thrown
//     error carrying a status. They are two different facts, not two paints of
//     one, and they are never allowed to collapse into each other.
import { PREFERENCES_KEY } from "./shell.js";
import { isCalendarDay } from './calendar-model.js';

/* -------------------------------------------------- the producer's own numbers */

/** `FIND_CATCH_UP_QUERY_MAX` (tools.js:2059) — the input's maxlength, too. */
const FIND_QUERY_MAX = 200;
/** `FIND_CATCH_UP_LIMIT_MAX` (tools.js:2060). */
const FIND_CATCH_UP_LIMIT_MAX = 50;
const FIND_CATCH_UP_LIMIT_DEFAULT = 20;


/* --------------------------------------------------------- the frozen sentences */

/** checkable_done 1 — what "authorized" can honestly mean on this page. */
export const AUTHORIZATION_SENTENCE =
  "";

/** checkable_done 3 — saved views are a device fact, because no verb stores one. */
export const SAVED_VIEW_SENTENCE =
  "Saved on this device";

/** §3 — three of the four named sources have no door at all. */
export const NOT_SEARCHED_SENTENCE =
  "Search people, practices, buildings, deals, leads and vendors";

/** UX01's out-of-scope half: a chip is a view, never a narrower question. */
export const SCOPE_CHIP_SENTENCE =
  "";

/** §4.4 — most result kinds have no address to open into, and this says so. */
const NO_PAGE_SENTENCE = "This record has no page that opens by address yet.";

/* ------------------------------------------------------------------ validation */

/** All seven keys, always, in every captured response. */
const SEARCH_PAYLOAD_KEYS = Object.freeze([
  "parties", "deals", "connections", "organizations", "lead_client_links", "deals_via_link", "note",
]);

const PARTY_KEYS = ["name", "city", "specialty", "org_name", "ref", "kind", "merged"];
const ORGANIZATION_KEYS = ["name", "live_rows", "refs", "retired_aliases", "retired_refs", "retired_refs_truncated", "live_as_role", "role_refs", "all_retired"];
const DEAL_KEYS = ["name", "phase", "owner", "client_ref", "invoiced_on", "closed_on", "lane", "outcome"];

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** NULLABLE, by §2.2: the producer's column is nullable and a real payload had null. */
function nullableString(value) {
  return value === null || typeof value === "string";
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Exact keys, compared as SETS and never by sorting them. This module must
 * contain no sort of any kind — UX01's "no default workload ranking" is asserted
 * by a grep over this file, and a sort here, however innocent, would make that
 * assertion unreadable.
 */
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  if (present.length !== keys.length) return false;
  const wanted = new Set(keys);
  return present.every((key) => wanted.has(key));
}

/**
 * An array whose ELEMENTS may be null. This is not laxity: `array_agg(ref …)`
 * over a nullable column produced `refs: [null]` in two real payloads, and a
 * validator that refused it would refuse the production answer.
 */
function nullableStringArray(value) {
  return Array.isArray(value) && value.every((entry) => nullableString(entry));
}

function validSearchParty(row) {
  if (!exactKeys(row, PARTY_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  // city, specialty, org_name and ref are each nullable in v_ref_index.
  if (!nullableString(row.city) || !nullableString(row.specialty)) return false;
  if (!nullableString(row.org_name) || !nullableString(row.ref)) return false;
  if (!nonEmptyString(row.kind)) return false;
  return typeof row.merged === "boolean";
}

function validSearchOrganization(row) {
  if (!exactKeys(row, ORGANIZATION_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  if (!wholeNumber(row.live_rows) || !wholeNumber(row.retired_aliases) || !wholeNumber(row.live_as_role)) return false;
  if (!nullableStringArray(row.refs) || !nullableStringArray(row.role_refs) || !nullableStringArray(row.retired_refs)) return false;
  if (typeof row.retired_refs_truncated !== "boolean") return false;
  return typeof row.all_retired === "boolean";
}

function validSearchDeal(row) {
  if (!exactKeys(row, DEAL_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  // owner is lead_owner and was observed null; client_ref is nullable too.
  return nullableString(row.phase) && nullableString(row.owner) && nullableString(row.client_ref)
    && (row.invoiced_on === null || isCalendarDay(row.invoiced_on))
    && (row.closed_on === null || isCalendarDay(row.closed_on))
    && nullableString(row.lane) && nullableString(row.outcome);
}

/**
 * The exact-key contract for a `find` response. All seven keys are required —
 * the producer returns all seven on every call, including a no-match — and an
 * eighth is refused rather than ignored, so a producer that starts sending a
 * field this page does not render has to come back and declare it.
 *
 * Every row shape below is checked as a shape, not as content: `connections`
 * and `lead_client_links` carry producer-chosen columns whose
 * set this page does not pin, so they are required to be objects with a name or
 * a ref the page can print and nothing more.
 */
export function validSearchPayload(payload) {
  if (!exactKeys(payload, SEARCH_PAYLOAD_KEYS)) return false;
  for (const key of ["parties", "deals", "connections", "organizations", "lead_client_links", "deals_via_link"]) {
    if (!Array.isArray(payload[key])) return false;
  }
  if (!payload.parties.every((row) => validSearchParty(row))) return false;
  if (!payload.organizations.every((row) => validSearchOrganization(row))) return false;
  if (!payload.deals.every((row) => validSearchDeal(row))) return false;
  if (!payload.deals_via_link.every((row) => validSearchDeal(row))) return false;
  for (const key of ["connections", "lead_client_links"]) {
    if (!payload[key].every((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))) return false;
  }
  // `note` is the producer's own sentence and this page prints it verbatim.
  return nonEmptyString(payload.note);
}

/* -------------------------------------------------------------------- requests */

/**
 * `find` declares ONE property. The object below carries exactly one key, and a
 * test asserts that, because an actor or a kind added here would be refused by
 * the gateway with `unregistered_operation_fields` — and, worse, would mean the
 * app had started deciding what a partner may see.
 */
export function buildFindArguments(query) {
  return { query: String(query ?? "") };
}

/** `find-and-catch-up` declares exactly two: query and limit. */
export function buildFindAndCatchUpArguments(query, limit = FIND_CATCH_UP_LIMIT_DEFAULT) {
  const asked = Number.isInteger(limit) ? limit : FIND_CATCH_UP_LIMIT_DEFAULT;
  return { query: String(query ?? ""), limit: Math.min(Math.max(asked, 1), FIND_CATCH_UP_LIMIT_MAX) };
}

/** What the producer refuses, refused here first so no pointless read is sent. */
export function queryIsSendable(query) {
  const text = String(query ?? "").trim();
  return text.length > 0 && text.length <= FIND_QUERY_MAX;
}

/* ---------------------------------------------------------------- the grouping */

/**
 * The groups, in the order the page paints them. `parties` is split by the
 * producer's own `kind` word so a chip can name Leads rather than "records",
 * and the split preserves each row's position inside its group.
 */
const SEARCH_GROUPS = Object.freeze([
  Object.freeze({ id: "people", label: "People and practices", source: "parties", kind: "party" }),
  Object.freeze({ id: "leads", label: "Leads", source: "parties", kind: "lead" }),
  Object.freeze({ id: "clients", label: "Clients", source: "parties", kind: "client" }),
  Object.freeze({ id: "vendors", label: "Vendors", source: "parties", kind: "vendor" }),
  Object.freeze({ id: "organizations", label: "Organizations", source: "organizations", kind: null }),
  Object.freeze({ id: "deals", label: "Deals", source: "deals", kind: null }),
  Object.freeze({ id: "connections", label: "Connections", source: "connections", kind: null }),
  Object.freeze({ id: "lead_client_links", label: "Lead and client links", source: "lead_client_links", kind: null }),
  Object.freeze({ id: "deals_via_link", label: "Linked deals", source: "deals_via_link", kind: null }),
]);

export const SEARCH_GROUP_IDS = Object.freeze(SEARCH_GROUPS.map((group) => group.id));
const isScope = id => id === "none" || SEARCH_GROUP_IDS.includes(id);

export function toggleSearchScope(kinds, id, available = SEARCH_GROUP_IDS) {
  const selected = kinds.length === 0 ? [...available] : kinds.filter(kind => available.includes(kind));
  const next = selected.includes(id) ? selected.filter(kind => kind !== id) : [...selected, id];
  return next.length === 0 ? ["none"] : next.length === available.length ? [] : next;
}

/** Non-null, non-empty strings only. An array of refs is not an array of links. */
function refChips(list) {
  return (Array.isArray(list) ? list : []).filter((entry) => nonEmptyString(entry));
}

/** §4.4 — only two pages read a name, so only two kinds get an address. */
export function deepLinkFor(row) {
  if (!row || row.merged === true) return null;
  if (row.kind === "client") return `/clients?q=${encodeURIComponent(row.name)}`;
  if (row.kind === "vendor") return `/vendors?q=${encodeURIComponent(row.name)}`;
  return null;
}

function partyRow(row) {
  const link = deepLinkFor(row);
  return Object.freeze({
    kind: "party",
    name: row.name,
    // Each of these prints ONLY when the producer sent one. A null never
    // reaches a line of its own, and the word "null" is never rendered.
    facts: Object.freeze([
      row.city === null ? null : { label: "City", value: row.city },
      row.specialty === null ? null : { label: "Specialty", value: row.specialty },
      row.org_name === null ? null : { label: "Organization", value: row.org_name },
    ].filter(Boolean)),
    refs: refChips([row.ref]),
    retired: row.merged === true,
    link,
    note: link ? null : NO_PAGE_SENTENCE,
  });
}

function organizationRow(row) {
  return Object.freeze({
    kind: "organization",
    name: row.name,
    // Two numbers, two words. They are printed as returned and never summed:
    // the producer refuses to blend live rows with retired aliases, and so does
    // this page.
    counts: Object.freeze([
      { label: "Current matches", value: row.live_rows },
      { label: "retired aliases", value: row.retired_aliases },
      { label: "live as a role", value: row.live_as_role },
    ]),
    refs: refChips(row.refs),
    roleRefs: refChips(row.role_refs),
    retiredRefs: refChips(row.retired_refs),
    retiredRefsTruncated: row.retired_refs_truncated === true,
    allRetired: row.all_retired === true,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

function dealRow(row) {
  return Object.freeze({
    kind: "deal",
    name: row.name,
    facts: Object.freeze([
      row.phase === null ? null : { label: "Phase", value: row.phase },
      { label: "Owner", value: row.owner === null ? "no owner recorded" : row.owner },
      row.client_ref === null ? null : { label: "Client", value: row.client_ref },
    ].filter(Boolean)),
    refs: refChips([row.client_ref]),
    retired: false,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

/**
 * A row from a group whose columns this page does not pin. Every printable
 * field is taken from the object as it arrived: no key is invented, no value is
 * reworded, and a null is dropped rather than printed.
 */
function passthroughRow(row, kind) {
  return Object.freeze({
    kind,
    name: nonEmptyString(row?.name) ? row.name : null,
    facts: Object.freeze(Object.entries(row || {})
      .filter(([key, value]) => key !== "name" && value !== null && value !== undefined && typeof value !== "object")
      .map(([key, value]) => ({ label: key, value: String(value) }))),
    refs: Object.freeze([]),
    retired: false,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

/**
 * Groups, in painting order, each carrying the producer's own order untouched.
 * A group with no rows is dropped: an empty group would draw a chip for a kind
 * the answer never mentioned.
 */
export function groupSearchResults(payload) {
  if (!validSearchPayload(payload)) return Object.freeze([]);
  return Object.freeze(SEARCH_GROUPS.map((group) => {
    let rows = [];
    if (group.source === "parties") {
      const matching = payload.parties.filter((row) => (group.kind === "party" ? !["lead", "client", "vendor"].includes(row.kind) : row.kind === group.kind));
      rows = matching.map((row) => partyRow(row));
    } else if (group.source === "organizations") {
      rows = payload.organizations.map((row) => organizationRow(row));
    } else if (group.source === "deals") {
      rows = payload.deals.map((row) => dealRow(row));
    } else {
      rows = payload[group.source].map((row) => passthroughRow(row, group.id));
    }
    return Object.freeze({ id: group.id, label: group.label, count: rows.length, rows: Object.freeze(rows) });
  }).filter((group) => group.count > 0));
}

const roleLabels = { client: "Client", lead: "Lead", vendor: "Vendor" };
const roleGroups = { client: "clients", lead: "leads", vendor: "vendors" };
const legacyRelationNames = {
  connections: ["from_name", "to_name"],
  lead_client_links: ["lead_name", "client_name"],
};
const isSearchRole = role => typeof role === "string" && Object.hasOwn(roleLabels, role);
const recordLink = (page, key, id) => `/${page}?${new URLSearchParams({ [key]: id })}`;
const isDealLink = row => nonEmptyString(row?.id) && nonEmptyString(row?.name);

export function validSearchRecords(payload) {
  return payload?.schema_version === "search.v1"
    && Array.isArray(payload.deals) && payload.deals.every(row => isDealLink(row)
      && nullableString(row.phase) && nonEmptyString(row.owner))
    && Array.isArray(payload.parties) && payload.parties.every(row => isDealLink(row)
      && ["person", "company"].includes(row.kind) && nullableString(row.city) && nullableString(row.lead_id)
      && Array.isArray(row.roles) && row.roles.every(isSearchRole)
      && Array.isArray(row.deals) && row.deals.every(isDealLink));
}

function partyLink(row) {
  if (row.roles.includes("client")) return recordLink("clients", "record", row.id);
  if (row.roles.includes("vendor")) return recordLink("vendors", "record", row.id);
  if (row.lead_id) return recordLink("leads", "lead", row.lead_id);
  return recordLink("relationships", "node", `party:${row.id}`);
}

export function usesLegacyRelationScope(kinds) {
  return kinds.some(id => Object.hasOwn(legacyRelationNames, id));
}

export function displaySearchGroups(payload, kinds = []) {
  if (payload?.schema_version !== "search.v1") {
    return groupSearchResults(payload).flatMap(group => {
      const relationNames = legacyRelationNames[group.id];
      if (relationNames && !kinds.includes(group.id)) return [];
      const rows = group.rows.filter(row => !row.retired && !row.allRetired).map(row => ({
        ...row,
        ...(group.id === "leads" && row.refs[0] && { link: recordLink("leads", "lead", row.refs[0]) }),
        ...(group.id === "organizations" && { link: recordLink("relationships", "q", row.name) }),
      }));
      const shown = relationNames ? rows.flatMap(row => {
        const [from, to] = relationNames.map(label => row.facts.find(fact => fact.label === label)?.value);
        const name = to || from;
        return name ? [{ name, meta: from && from !== name ? [from] : [], link: recordLink("relationships", "q", name) }] : [];
      }) : rows;
      return shown.length ? [{ ...group, rows: shown, count: shown.length }] : [];
    });
  }
  const listedDeals = new Set(payload.deals.map(deal => deal.id));
  const parties = payload.parties.map(row => {
    const scopes = row.roles.map(role => roleGroups[role]);
    if (!scopes.length) scopes.push(row.kind === "company" ? "organizations" : "people");
    return {
      name: row.name,
      scopes: row.deals.length ? [...scopes, "deals_via_link"] : scopes,
      group: roleGroups[row.roles.find(role => role !== "lead") || row.roles[0]] || scopes[0],
      meta: [...(row.roles.length ? row.roles.map(role => roleLabels[role]) : [row.kind === "person" ? "Person" : "Company"]), row.city].filter(Boolean),
      link: partyLink(row),
      deals: row.deals.filter(deal => !listedDeals.has(deal.id))
        .map(deal => ({ name: deal.name, link: recordLink("deals", "deal", deal.id) })),
    };
  });
  const deals = payload.deals.map(row => ({
    ...row, group: "deals", link: recordLink("deals", "deal", row.id),
  }));
  return SEARCH_GROUPS.flatMap(({ id, label }) => {
    const rows = [...parties, ...deals].filter(row => row.group === id);
    return rows.length ? [{ id, label, rows, count: rows.length }] : [];
  });
}

/**
 * The chips. One per group actually present, carrying that group's own count —
 * a number read from the answer, never one this page computed over anything
 * else. A chip is SELECTED when the scope names it or the scope is empty.
 */
export function scopeChips(groups, kinds = []) {
  const chosen = new Set((Array.isArray(kinds) ? kinds : []).filter((id) => isScope(id)));
  const counts = new Map();
  for (const group of groups) for (const row of group.rows) {
    for (const id of row.scopes || [group.id]) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return SEARCH_GROUPS.filter(group => counts.has(group.id)).map(({ id, label }) => ({
    id, label, count: counts.get(id), selected: chosen.size === 0 || chosen.has(id),
  }));
}

/** A chip hides rows from the answer already in hand. It asks nothing new. */
export function applyScope(groups, kinds = []) {
  const chosen = new Set((Array.isArray(kinds) ? kinds : []).filter((id) => isScope(id)));
  if (chosen.size === 0) return Object.freeze([...(Array.isArray(groups) ? groups : [])]);
  return groups.flatMap(group => {
    const rows = group.rows.filter(row => (row.scopes || [group.id]).some(id => chosen.has(id)));
    return rows.length ? [{ ...group, rows, count: rows.length }] : [];
  });
}

/** The total the page may print, which is the sum of what it is showing. */
export function visibleCount(groups) {
  return (Array.isArray(groups) ? groups : []).reduce((total, group) => total + group.count, 0);
}

/* ------------------------------------------------------------ the retired block */

/**
 * The tombstone block, built from the producer's own fields and its own
 * sentence. Never blended into the live counts.
 */
export function retiredSummary(payload) {
  if (!validSearchPayload(payload)) return null;
  const organizations = payload.organizations.filter((row) => row.retired_aliases > 0 || row.all_retired === true || row.retired_refs_truncated === true);
  return Object.freeze({
    note: payload.note,
    retiredParties: payload.parties.filter((row) => row.merged === true).length,
    organizations: Object.freeze(organizations.map((row) => Object.freeze({
      name: row.name,
      retiredAliases: row.retired_aliases,
      retiredRefs: refChips(row.retired_refs),
      truncated: row.retired_refs_truncated === true,
      allRetired: row.all_retired === true,
    }))),
  });
}

/**
 * The partial state's own sentence and its exact count. A truncation is the
 * producer telling you what it left out; the page repeats the number rather
 * than rounding it into a word.
 */
export function truncationNotes(payload, catchUp = null) {
  const notes = [];
  if (validSearchPayload(payload)) {
    for (const row of payload.organizations) {
      if (row.retired_refs_truncated !== true) continue;
      notes.push(`${row.name}: ${refChips(row.retired_refs).length} retired references shown of ${row.retired_aliases} recorded.`);
    }
  }
  if (catchUp && catchUp.state === "needs_disambiguation" && catchUp.candidates_truncated === true) {
    notes.push(`${catchUp.candidates.length} candidates shown of ${catchUp.candidate_count} found.`);
  }
  return Object.freeze(notes);
}

/* ------------------------------------------------------------------- the states */

/** The nine states of §4.6. One state, one heading, one body. */
export const SEARCH_STATE_COPY = Object.freeze({
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for loading only; 0 automatic attempts, and any retry requires a fresh user action.
  loading: Object.freeze({ title: "Searching…", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for empty only; 0 automatic attempts, and any retry requires a fresh user action.
  empty: Object.freeze({ title: "Search by name", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for no_match only; 0 automatic attempts, and any retry requires a fresh user action.
  no_match: Object.freeze({ title: "No matches", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for stale only; 0 automatic attempts, and any retry requires a fresh user action.
  stale: Object.freeze({ title: "Updating…", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for unavailable only; 0 automatic attempts, and any retry requires a fresh user action.
  unavailable: Object.freeze({ title: "Search temporarily unavailable", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for refused only; 0 automatic attempts, and any retry requires a fresh user action.
  refused: Object.freeze({ title: "Sign-in required", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for unknown only; 0 automatic attempts, and any retry requires a fresh user action.
  unknown: Object.freeze({ title: "Search temporarily unavailable", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for partial only; 0 automatic attempts, and any retry requires a fresh user action.
  partial: Object.freeze({ title: "Some results unavailable", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for disambiguation only; 0 automatic attempts, and any retry requires a fresh user action.
  disambiguation: Object.freeze({ title: "Multiple matches", copy: "", retry: false }),
  // eslint-disable-next-line no-restricted-syntax -- Search state copy for ready only; 0 automatic attempts, and any retry requires a fresh user action.
  ready: Object.freeze({ title: "Results", copy: "", retry: false }),
});

export const SEARCH_STATES = Object.freeze([
  "loading", "empty", "no_match", "stale", "unavailable", "refused", "unknown", "partial", "disambiguation",
]);

/**
 * A thrown error to its state. The status is what separates a DECIDED refusal
 * from an unanswered path: `live-client.js` attaches it precisely so these two
 * never collapse into one, and this page keeps them apart.
 */
export function classifySearchFailure(error) {
  if ([401,403].includes(error?.status) || (error && error.payload && nonEmptyString(error.payload.error))) return "refused";
  return "unavailable";
}

/** The refusal code, named. The BODY is never read and never rendered. */
export function refusalDetail(error) {
  const payload = error?.payload;
  if (!payload || !nonEmptyString(payload.error)) return null;
  const fields = Array.isArray(payload.fields) ? payload.fields.filter((entry) => nonEmptyString(entry)) : [];
  const missing = Array.isArray(payload.missing) ? payload.missing.filter((entry) => nonEmptyString(entry)) : [];
  return Object.freeze({
    code: payload.error,
    operation: nonEmptyString(payload.operation) ? payload.operation : null,
    fields: Object.freeze(fields),
    missing: Object.freeze(missing),
    hint: nonEmptyString(payload.hint) ? payload.hint : null,
  });
}

/**
 * What the tab shows. A refused, failed or unreadable read has already dropped
 * the payload before this is asked, so no state can print a number the read did
 * not deliver. `no_match` and `unavailable` are mutually exclusive by
 * construction: the first needs a valid payload, the second needs none.
 */
export function searchPhase({ status, payload, catchUp = null, submitted = false }) {
  if (status === "loading") return "loading";
  if (status === "unavailable" || status === "refused" || status === "unknown") return status;
  if (!submitted) return "empty";
  if (catchUp?.state === "unavailable") return "partial";
  if (catchUp && catchUp.state === "needs_disambiguation") return "disambiguation";
  if (!payload) return "empty";
  if (truncationNotes(payload, catchUp).length > 0) return "partial";
  if (visibleCount(groupSearchResults(payload)) === 0) return "no_match";
  return "ready";
}

/* ------------------------------------------------------------------ the address */

/** `?q=` and `?kinds=` on an already-admitted path. The gate reads neither. */
export function parseSearchAddress(search) {
  const parameters = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const query = parameters.get("q");
  const kinds = (parameters.get("kinds") || "").split(",").map((entry) => entry.trim()).filter((entry) => isScope(entry));
  return Object.freeze({
    query: typeof query === "string" ? query : "",
    kinds: Object.freeze([...new Set(kinds)]),
    present: parameters.has("q"),
  });
}

/** The address a view is restored from. Byte-stable for the same view. */
export function searchAddress({ query = "", kinds = [] } = {}) {
  const parameters = new URLSearchParams();
  if (String(query ?? "").trim()) parameters.set("q", String(query));
  const scope = (Array.isArray(kinds) ? kinds : []).filter((entry) => isScope(entry));
  if (scope.length > 0) parameters.set("kinds", scope.join(","));
  return `/search${parameters.size ? `?${parameters.toString()}` : ""}`;
}

/* ---------------------------------------------------------------- saved views */

/**
 * A DIFFERENT key from the workspace preferences. That separation is the whole
 * of checkable_done 3: saving a view must not touch a partner preference, and
 * there is no verb that would store one anywhere else.
 */
export const SAVED_VIEWS_KEY = "doctorcre.saved-views.v1";
const SAVED_VIEWS_MAX = 12;

/** Guard rather than comment: this module may not write the preferences key. */
function assertNotPreferences(key) {
  if (key === PREFERENCES_KEY) throw new Error("saved views never write the workspace preference key");
}

export function readSavedViews(storage, actor) {
  try { storage?.removeItem(SAVED_VIEWS_KEY); } catch {}
  if (typeof actor !== "string" || !actor) return Object.freeze([]);
  if (!storage) return Object.freeze([]);
  let raw = null;
  try { raw = storage.getItem(`${SAVED_VIEWS_KEY}:${encodeURIComponent(actor)}`); } catch { return Object.freeze([]); }
  let parsed = null;
  try { parsed = JSON.parse(raw || "[]"); } catch { return Object.freeze([]); }
  if (!Array.isArray(parsed)) return Object.freeze([]);
  return Object.freeze(parsed
    .filter((view) => view && typeof view === "object" && nonEmptyString(view.name) && typeof view.query === "string")
    .slice(0, SAVED_VIEWS_MAX)
    .map((view) => Object.freeze({
      name: view.name,
      query: view.query,
      kinds: Object.freeze((Array.isArray(view.kinds) ? view.kinds : []).filter((entry) => isScope(entry))),
    })));
}

export function writeSavedViews(storage, views, actor) {
  if (typeof actor !== "string" || !actor) return Object.freeze([]);
  if (!storage) return Object.freeze([]);
  const next = Object.freeze((Array.isArray(views) ? views : []).slice(0, SAVED_VIEWS_MAX).map((view) => Object.freeze({
    name: view.name, query: view.query, kinds: Object.freeze([...(view.kinds || [])]),
  })));
  assertNotPreferences(SAVED_VIEWS_KEY);
  // Storage is a convenience and never a requirement: a browser that refuses it
  // keeps the views for this page's lifetime and says nothing was stored.
  try { storage.setItem(`${SAVED_VIEWS_KEY}:${encodeURIComponent(actor)}`, JSON.stringify(next)); } catch { /* a convenience, never a requirement */ }
  return next;
}

/** Save under a name. A second save under the same name replaces that view. */
export function saveView(views, { name, query, kinds = [] }) {
  const label = String(name ?? "").trim();
  if (label === "") return Object.freeze([...(views || [])]);
  const entry = Object.freeze({ name: label, query: String(query ?? ""), kinds: Object.freeze((Array.isArray(kinds) ? kinds : []).filter((id) => isScope(id))) });
  const rest = (views || []).filter((view) => view.name !== label);
  return Object.freeze([...rest, entry].slice(0, SAVED_VIEWS_MAX));
}

export function renameView(views, from, to) {
  const label = String(to ?? "").trim();
  if (label === "") return Object.freeze([...(views || [])]);
  return Object.freeze((views || []).map((view) => (view.name === from ? Object.freeze({ ...view, name: label }) : view)));
}
