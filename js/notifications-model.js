// Notifications present only facts returned by the existing read operations.
// Names are absent from the feed contract: use human record labels rather than
// guessing a name or fetching a second record. Identifiers stay in Details.
import { routeContract, docRequestTarget } from "./routes.js";
import { BUSINESS_TIME_ZONE, meetingTime } from "./business-date.js";

import { REFUSAL_SENTENCE } from "./status-model.js";
import { CONVERSATION_ID } from "./conversations-model.js";
import { knownAuthor } from "./client.js";
import { changeAction } from "./change-receipts.mjs";

export { REFUSAL_SENTENCE };

const formatClock = (value, zone) => value && Number.isFinite(new Date(value).valueOf()) ? meetingTime(value, zone) : null;

/* ----------------------------------------------------------- the vocabulary */

/**
 * The whole severity vocabulary of this page, because it is the whole severity
 * vocabulary a mint can produce. A third chip here would be a chip no row can
 * ever carry.
 */
export const SEVERITY_LABELS = Object.freeze({
  action_required: "Action required",
  failure: "Failure",
});
export const SEVERITIES = Object.freeze(Object.keys(SEVERITY_LABELS));

/** The delivery states migration 0521 declares, in this page's plain English. */
export const DELIVERY_PHRASES = Object.freeze({
  pending: "in-app, waiting",
  delivered: "delivered",
  suppressed_quiet_hours: "device push held by your quiet hours",
  failed: "device push failed",
});

/**
 * What a card with no `device` delivery row means. No opt-in, no row — so this
 * is a reading of the absence, not an inference about a person's phone.
 */
export const DEVICE_OFF = "device push is off for you";

/** The banner shown when the record layer says quiet hours cover this moment. */
export const QUIET_NOW_BANNER =
  "Quiet hours cover this moment. Device push is being held; the items below still arrived in-app.";

/** The marker a suppressed row carries. It is marked, never hidden. */
export const QUIET_SUPPRESSED_MARK = "held by your quiet hours";

// Browser and Worker routing come from the same assembled slice fragments.
export const APP_ROUTE_PATHS = Object.freeze(Object.keys(routeContract.routes));
const LEGACY_ROUTE_HOMES = Object.freeze(routeContract.redirects);

/** The sentence an unroutable deep link carries. */
export const NO_PAGE_SENTENCE = "Record unavailable in this app";

const isText = (value) => typeof value === "string" && value.length > 0;

/* --------------------------------------------------------------- the payload */

/** The old feed lists `notifications`; the engine's `/updates` lists `updates`. */
const feedRows = (payload) => payload.notifications ?? payload.updates;

/** The count and the list, kept separate. */
export function validFeedPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!Number.isInteger(payload.unread_count) || payload.unread_count < 0) return false;
  return Array.isArray(feedRows(payload));
}

/* ---------------------------------------------------------------- the header */

/**
 * The unread line, printed from the payload's own number. Zero is a sentence,
 * never a hidden element: "nothing unread" is an answer and an empty space is
 * not.
 */
export function unreadLine(payload) {
  if (!validFeedPayload(payload)) return "";
  const count = payload.unread_count;
  if (count === 0) return "Nothing unread";
  return `${count} unread`;
}

/* ----------------------------------------------------------------- the cards */

export function deliveryPhrases(delivery) {
  const rows = Array.isArray(delivery) ? delivery : [];
  const validRow = row => row && typeof row === "object"
    && ["in_app", "device"].includes(row.channel)
    && isText(row.state) && Object.hasOwn(DELIVERY_PHRASES, row.state);
  const phrases = rows
    .filter(row => row && typeof row === "object" && isText(row.channel))
    .map(row => ({
      channel: row.channel,
      state: isText(row.state) ? row.state : "unavailable",
      phrase: validRow(row) ? DELIVERY_PHRASES[row.state] : "Delivery status unavailable",
    }));
  if (!rows.some(row => row?.channel === "device")) {
    const absent = Array.isArray(delivery) && rows.every(validRow);
    phrases.push({ channel: "device", state: absent ? "absent" : "unavailable",
      phrase: absent ? DEVICE_OFF : "Delivery status unavailable" });
  }
  return phrases;
}

// Keep routing separate from display labels. A signal id is not an
// investigation run id, so signal links cannot open a record with these reads.
const DOC_CONVERSATION_LINK = /^\/doc-conversations\/([^/]+)$/;
const RECORD_LABELS = Object.freeze({
  deal: "Deal", client: "Client", lead: "Lead", vendor: "Vendor", party: "Contact",
  doc_conversation: "Doc conversation", signal: "Signal", work_request: "Work request",
});
const recordLabel = kind => Object.hasOwn(RECORD_LABELS, kind) ? RECORD_LABELS[kind] : "Record";
const linkLabel = path => ({
  "/deals": "Open deal", "/clients": "Open client", "/leads": "Open lead",
  "/vendors": "Open vendor", "/doc-chats": "Open conversation",
})[path] || "Open record";

export function deepLinkView(deepLink, routes = APP_ROUTE_PATHS) {
  const path = isText(deepLink) ? deepLink : null;
  if (!path) return { path: null, href: null, routed: false, sentence: null, label: null };
  const routeList = Array.isArray(routes) ? routes : [];
  if (docRequestTarget(path) && routeList.includes('/doc-chats')) {
    return { path, href: path, routed: true, sentence: null, label: 'Open conversation' };
  }
  const docMatch = DOC_CONVERSATION_LINK.exec(path);
  if (docMatch && CONVERSATION_ID.test(docMatch[1]) && routeList.includes("/doc-chats")) {
    return { path, href: `/doc-chats?id=${docMatch[1]}`, routed: true, sentence: null, label: "Open conversation" };
  }
  const [pathname, query] = path.split("?");
  const home = LEGACY_ROUTE_HOMES[pathname] || pathname;
  const homePath = home.split("?")[0];
  const routed = routeList.includes(homePath);
  const href = routed ? `${home}${query ? `${home.includes("?") ? "&" : "?"}${query}` : ""}` : null;
  return { path, href, routed, sentence: routed ? null : NO_PAGE_SENTENCE, label: routed ? linkLabel(homePath) : null };
}

/**
 * One card per notification row, in the order the feed returned them. A row
 * without an id is dropped rather than drawn: the id is what an acknowledgement
 * is addressed to, and a card that cannot be acknowledged is a dead control.
 */
export function notificationCards(payload, routes = APP_ROUTE_PATHS, zone = BUSINESS_TIME_ZONE) {
  if (!validFeedPayload(payload)) return [];
  if (payload.updates) return payload.updates.map((row) => updateCard(row, zone));
  return payload.notifications
    .filter((row) => row && typeof row === "object" && isText(row.id))
    .map((row) => ({
      id: row.id,
      severity: SEVERITIES.includes(row.severity) ? row.severity : null,
      severityLabel: SEVERITY_LABELS[row.severity] || "Severity unavailable",
      reason: isText(row.reason) ? row.reason : "no reason recorded",
      subject: recordLabel(row.subject_type),
      details: { subjectType: row.subject_type || null, subjectRef: row.subject_ref || null },
      clock: formatClock(row.created_at, zone),
      read: isText(row.read_at),
      readClock: formatClock(row.read_at, zone) || null,
      delivery: deliveryPhrases(row.delivery),
      // OUTPUT-ONLY, and printed exactly as the producer decided it. The page
      // does not recompute suppression from the delivery rows: the producer's
      // value is a DISJUNCTION of "quiet hours cover now" and "a push was
      // suppressed at mint time", and a page that recomputed it would lose the
      // first term the moment the window closed.
      quietSuppressed: row.quiet_suppressed === true,
      link: deepLinkView(row.deep_link, routes),
    }));
}

function updateCard(row, zone) {
  return {
    id: row.id,
    severityLabel: row.label,
    reason: row.title,
    subject: row.why,
    clock: formatClock(row.at, zone),
    reading: row.reading,
    readClock: row.reading.kind === "read" ? formatClock(row.reading.at, zone) : null,
    link: row.link,
    delivery: [],
    details: {},
  };
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isDate = (value) => isText(value) && Number.isFinite(Date.parse(value));

export function updateFailure(error) {
  const code = error?.payload?.error;
  if (error?.status === 404 && code === "not_found") return { kind: "missing" };
  if (error?.status === 409 && code === "version_conflict") return { kind: "conflict" };
  if (error?.status === 400 && code === "invalid_field_value") return {
    kind: "invalid_fields",
    fields: Array.isArray(error.payload.fields) ? error.payload.fields.filter(isText) : [],
  };
  return { kind: "unavailable" };
}

export function parseUpdates(payload) {
  if (!isCount(payload?.unread_count) || !Array.isArray(payload.updates)) throw new Error("Invalid update list");
  const updates = new Map();
  for (const row of payload.updates) {
    const link = deepLinkView(row?.open_url);
    if (!UUID.test(row?.source_id) || !link.href?.startsWith("/deals?deal=") ||
        !isDate(row.activity_at) || (row.read_at !== null && !isDate(row.read_at))) throw new Error("Invalid update");
    if (!updates.has(row.source_id)) updates.set(row.source_id, {
      id: row.source_id,
      title: isText(row.title) ? row.title : "Deal update",
      why: isText(row.why) ? row.why : "",
      label: isText(row.kind_label) ? row.kind_label : "Update",
      at: row.activity_at,
      link: { ...link, label: isText(row.primary_action) ? row.primary_action : link.label },
      reading: row.read_at === null ? { kind: "unread" } : { kind: "read", at: row.read_at },
    });
  }
  return { unread_count: payload.unread_count, updates: [...updates.values()] };
}

export function parseMarkedUpdates(payload, ids) {
  if (payload?.ok !== true || !isCount(payload.unread_count) || !Array.isArray(payload.updates) ||
      payload.updates.some((row) => !UUID.test(row?.id) || !isDate(row.read_at))) throw new Error("Invalid read receipt");
  const readTimes = new Map(payload.updates.map((row) => [row.id, row.read_at]));
  if (readTimes.size !== ids.length || !ids.every((id) => readTimes.has(id))) throw new Error("Incomplete read receipt");
  return { ok: true, replayed: payload.replayed === true, unread_count: payload.unread_count, readTimes };
}

/* -------------------------------------------------------------- the UX20 states */

/**
 * The refusal a failed read is turned into, from the STATUS and the CODE alone.
 * The server's prose never travels: a 500's body is written for whoever
 * maintains the verb, and this page prints at partners.
 *
 *  - 401/403 is a DECISION taken before the verb ran. Nothing was read.
 *  - any other HTTP status means the page could not read the feed.
 *  - `notification_feed_unavailable` is the shaper's own refusal: the answer
 *    could not be shaped, so the page shows nothing rather than a guess.
 */
export function classifyReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "notification_feed_unavailable") return { state: "unknown", reason: FEED_STATES.unknown };
  if (status === 401 || status === 403) return { state: "refused", reason: FEED_STATES.refused };
  if (status) return { state: "unavailable", reason: FEED_STATES.unavailable };
  return { state: "unknown", reason: REFUSAL_SENTENCE };
}

/** The eight states UX20 demands, each with the sentence the page renders. */
export const FEED_STATES = Object.freeze({
  loading: "Loading notifications…",
  empty: "No updates",
  no_match: "No matching notifications",
  stale: "Updating…",
  unavailable: "Couldn't load updates",
  refused: "Unavailable for this account",
  unknown: "Couldn't load updates",
  partial: "More notifications available",
});

/**
 * Which of the eight states this page is in. Order is the whole design: a
 * refusal outranks an empty list, because an empty list drawn over a refusal
 * would read as "you have nothing" when the truth is "we were not told".
 */
export function feedState(read = {}, { after = null, limit = null } = {}) {
  const has = read.state === "read" && validFeedPayload(read.payload);
  if (read.state === "refused") return { state: "refused", sentence: FEED_STATES.refused };
  if (read.state === "unavailable") return { state: "unavailable", sentence: FEED_STATES.unavailable };
  if (read.state === "unknown") return { state: "unknown", sentence: FEED_STATES.unknown };
  if (read.state === "pending") {
    if (!has && !read.payload) return { state: "loading", sentence: FEED_STATES.loading };
  }
  if (read.refreshing === true && has) return { state: "stale", sentence: FEED_STATES.stale };
  if (!has) return { state: "loading", sentence: FEED_STATES.loading };
  const rows = feedRows(read.payload).length;
  if (rows === 0) {
    return isText(after)
      ? { state: "no_match", sentence: FEED_STATES.no_match }
      : { state: "empty", sentence: FEED_STATES.empty };
  }
  if (Number.isInteger(limit) && rows >= limit && read.payload.unread_count > rows) {
    return {
      state: "partial",
      sentence: `${FEED_STATES.partial} It shows ${rows} of ${read.payload.unread_count} unread.`,
    };
  }
  return { state: "ready", sentence: null };
}

/* ------------------------------------------------------ accountable activity */

/**
 * The activity stream, as *actor · verb · subject · time*. It is deliberately
 * NOT merged into the feed: a notification is addressed to you, and an event is
 * something that happened.
 */
// A partner reads by name; another simple account slug reads as a word. Any
// other actor reference is an identifier and stays in Details.
const activityActor = (actor) => !isText(actor) ? "Unattributed"
  : knownAuthor(actor) ?? (/^[a-z]+$/.test(actor) ? actor.charAt(0).toUpperCase() + actor.slice(1)
  : "Recorded actor");
export function activityRows(events, zone = BUSINESS_TIME_ZONE) {
  return (Array.isArray(events) ? events : [])
    .filter((row) => row && typeof row === "object" && isText(row.verb))
    .slice(-12)
    .reverse()
    .map((row) => ({
      actor: activityActor(row.actor),
      verb: changeAction(row),
      subject: recordLabel(row.subject_type),
      details: { actor: row.actor || null, verb: row.verb, subjectType: row.subject_type || null, subjectRef: row.subject_id || null },
      clock: formatClock(row.recorded_at, zone),
    }));
}

export function parseChangesPage(page) {
  if (!Array.isArray(page?.changes) || (page.next_before !== null && !isText(page.next_before))) throw new Error("Invalid changes page");
  const changes = page.changes.map((row) => {
    const link = deepLinkView(row?.open_url);
    if (![row?.id, row?.what, row?.record].every(isText) || !(isText(row.who) || isText(row.job)) || !link.href ||
        !isDate(row.changed_at)) throw new Error("Invalid change");
    return { id: row.id, actor: isText(row.who) ? row.who : knownAuthor(row.job) ?? "Automatically", verb: row.what, subject: row.record, at: row.changed_at, link, details: {} };
  });
  const cursor = page.next_before === null ? { kind: "end" } : { kind: "more", before: page.next_before };
  return { changes, cursor };
}

export function changeRows(changes, zone = BUSINESS_TIME_ZONE) {
  return changes.map((row) => ({ ...row, clock: formatClock(row.at, zone) }));
}

/* -------------------------------------------------------------- the one write */

/** One operation per notification id, so two cards never share a key. */
export function acknowledgeOperationKey(id) {
  return `notifications:ack:${id}`;
}

/**
 * The arguments for `acknowledge-notification`, or the refusal. The verb
 * declares exactly two fields and refuses any other, and the kernel mints the
 * idempotency key, so nothing here adds, defaults or trims one into shape.
 */
export const ID_REFUSAL = "A notification is identified by the id the feed returned. Nothing was sent.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function acknowledgeArgs(id) {
  const value = String(id || "").trim();
  if (!UUID.test(value)) return { ok: false, message: ID_REFUSAL };
  return { ok: true, args: { notification_id: value } };
}

/* ------------------------------------------ the preference form (WR-000116) */

/**
 * `read-notification-preferences`' own shape, and `set-notification-preference`'s
 * too — the set answer is the same object minus `quiet_now` and plus
 * `deduplicated`, so `quiet_now` is read with `=== true` and never required.
 * `exists` is a first-class boolean here because "no row yet" is an answer the
 * page prints, not a hole it fills in.
 */
export function validPreferencePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok !== true) return false;
  if (typeof payload.exists !== "boolean") return false;
  if (typeof payload.device_opt_in !== "boolean") return false;
  if (!Number.isInteger(payload.version) || payload.version < 1) return false;
  if (!isText(payload.timezone)) return false;
  for (const field of ["quiet_hours_start", "quiet_hours_end"]) {
    const value = payload[field];
    if (value !== null && typeof value !== "string") return false;
  }
  return true;
}

/**
 * A stored `time` reaches the browser as `HH:MM:SS`, and the verb accepts
 * `HH:MM`. This is the ONE place the two spellings meet; a null stays null,
 * and anything that is not a clock time is null rather than a guess.
 */
const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9](?:\.\d+)?)?$/;
export function toInputTime(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = CLOCK.exec(text);
  if (match) return `${match[1]}:${match[2]}`;
  // "10:00 PM", "10:00pm", "10 PM" and "10pm" are the same clock time.
  const twelveHour = /^(0?[1-9]|1[0-2])(?::([0-5][0-9]))?\s*([AP])\.?\s*M\.?$/i.exec(text);
  if (!twelveHour) return null;
  const hour = Number(twelveHour[1]) % 12 + (twelveHour[3].toUpperCase() === "P" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${twelveHour[2] || "00"}`;
}

export function preferenceTimeLabel(value) {
  const time = toInputTime(value);
  if (!time) return "";
  const [hour, minute] = time.split(":");
  return `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? "AM" : "PM"}`;
}

export function parseEnginePreference(payload) {
  if (!isText(payload?.time_zone) || typeof payload.push_to_device !== "boolean" ||
      !isCount(payload.base_version) ||
      ![payload.quiet_from, payload.quiet_until].every((value) => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))
    throw new Error("Invalid preferences");
  return {
    deviceOptIn: payload.push_to_device,
    start: payload.quiet_from,
    end: payload.quiet_until,
    timezone: payload.time_zone,
    version: payload.base_version,
    quietHoursSet: payload.quiet_from !== null && payload.quiet_until !== null,
  };
}

export function preferenceView(payload) {
  if (!validPreferencePayload(payload)) return null;
  const start = toInputTime(payload.quiet_hours_start);
  const end = toInputTime(payload.quiet_hours_end);
  return {
    exists: payload.exists,
    deviceOptIn: payload.device_opt_in,
    start,
    end,
    timezone: payload.timezone,
    version: payload.version,
    quietNow: payload.quiet_now === true,
    quietHoursSet: start !== null && end !== null,
  };
}

/**
 * A human-readable summary. The compare-and-swap version belongs in Details.
 */
export function preferenceSummary(view) {
  if (!view) return "";
  const window = view.quietHoursSet
    ? `Quiet hours ${preferenceTimeLabel(view.start)} to ${preferenceTimeLabel(view.end)}`
    : "No quiet hours set";
  return `${window} · device push ${view.deviceOptIn ? "on" : "off"}`;
}

/** The five states the panel can be in, each with the sentence it renders. */
export const PREFERENCE_STATES = Object.freeze({
  loading: "Loading preferences…",
  ready: null,
  unavailable: "Preferences temporarily unavailable",
  refused: "Unavailable for this account",
  unknown: "Preferences temporarily unavailable",
});

export function classifyPreferenceReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "notification_preferences_unavailable") return { state: "unknown" };
  if (status === 401 || status === 403) return { state: "refused" };
  if (status) return { state: "unavailable" };
  return { state: "unknown" };
}

export function preferenceState(read = {}, model = preferenceView(read.payload)) {
  if (read.state === "read" && model) return { state: "ready", sentence: null };
  if (["refused", "unavailable", "unknown"].includes(read.state)) {
    return { state: read.state, sentence: PREFERENCE_STATES[read.state] };
  }
  return { state: "loading", sentence: PREFERENCE_STATES.loading };
}

/* ------------------------------------------------------- the preference write */

/** One operation key for the whole form: two saves are the same operation. */
export const PREFERENCE_OPERATION_KEY = "notifications:preference";

export const BASE_VERSION_REFUSAL =
  "This form has not read your preferences yet, so it holds no version to save against. Nothing was sent.";
export const TIME_REFUSAL =
  "Enter a time with AM or PM, such as 10:00 PM. Nothing was sent.";

/**
 * The arguments for `set-notification-preference`, or the refusal.
 *
 * A half pair — a start with no end — is DELIBERATELY sent, because
 * `notification_preference_quiet_hours_incomplete` is the record layer's own
 * refusal and rendering it by name is what proves the page is reading the
 * store's answer instead of guessing it. `base_version` comes from the last
 * READ, never from a caller.
 */
export function setPreferenceArgs(form = {}, view = null) {
  if (!view || !Number.isInteger(view.version)) return { ok: false, message: BASE_VERSION_REFUSAL };
  const args = { base_version: view.version };
  if (typeof form.device_opt_in === "boolean") args.device_opt_in = form.device_opt_in;
  if (form.clear_quiet_hours === true) {
    args.clear_quiet_hours = true;
    return { ok: true, args };
  }
  for (const field of ["quiet_hours_start", "quiet_hours_end"]) {
    const raw = typeof form[field] === "string" ? form[field].trim() : "";
    if (raw === "") continue;
    const time = toInputTime(raw);
    if (!time) return { ok: false, message: TIME_REFUSAL };
    args[field] = time;
  }
  return { ok: true, args };
}

export const QUIET_PAIR_REFUSAL =
  "Quiet hours need a start and an end that differ, or neither. Nothing was sent.";

/** The engine save sends all four fields, so blanks mean no quiet hours. */
export function enginePreferenceArgs(form = {}, view = null) {
  if (!view || !Number.isInteger(view.version)) return { ok: false, message: BASE_VERSION_REFUSAL };
  const typed = (value) => (form.clear_quiet_hours !== true && typeof value === "string" ? value.trim() : "");
  const [from, until] = [typed(form.quiet_hours_start), typed(form.quiet_hours_end)];
  const quiet_from = from ? toInputTime(from) : null;
  const quiet_until = until ? toInputTime(until) : null;
  if ((from && !quiet_from) || (until && !quiet_until)) return { ok: false, message: TIME_REFUSAL };
  if ((quiet_from === null) !== (quiet_until === null) || (quiet_from && quiet_from === quiet_until))
    return { ok: false, message: QUIET_PAIR_REFUSAL };
  return { ok: true, args: {
    base_version: view.version,
    time_zone: view.timezone,
    quiet_from,
    quiet_until,
    push_to_device: typeof form.device_opt_in === "boolean" ? form.device_opt_in : view.deviceOptIn,
  } };
}

/**
 * Every refusal `ops.set_notification_preference` can return, in this page's
 * plain English. A reason id this page has not been taught is named as itself:
 * a refusal the record layer issued is still a refusal, and swallowing it would
 * leave a person looking at a form that did nothing and said nothing.
 */
export const PREFERENCE_REFUSALS = Object.freeze({
  // F2: the discard is STATED. A conflict repaints the four controls from the
  // record layer's answer, so anything typed and not saved is gone, and a page
  // that dropped it silently would look like it had simply ignored the person.
  // The values are not preserved across the re-read on purpose: the whole point
  // of the re-read is that the person is deciding again against what the record
  // layer actually holds, and a form that kept the old typing over fresh values
  // would invite saving a change that was composed against a picture that is no
  // longer true.
  version_conflict:
    "Preferences changed elsewhere. Your changes were not saved.",
  notification_preference_quiet_hours_incomplete:
    "Quiet hours are two times. Set a start and an end together, or clear them together. Nothing was saved.",
  notification_preference_quiet_hours_conflicting_request:
    "Quiet hours could not be saved.",
  notification_preference_timezone_unknown:
    "Timezone unavailable. Preferences were not saved.",
  notification_preference_idempotency_key_required:
    "Preferences were not saved.",
  notification_preference_idempotency_key_reused:
    "Preferences were not saved.",
  notification_preference_not_set:
    "Preferences were not saved.",
});

export const VERSION_CONFLICT = "version_conflict";

/**
 * The refusal, from EITHER shape it can arrive in: the thrown client error
 * (`payload.error`) or the command kernel's settled outcome (`code`), because
 * the kernel classifies `version_conflict` as a CONFLICT and never lets the
 * raw error out. One function reads both so the sentence cannot depend on
 * which door the page happened to come through.
 */
export function classifyPreferenceFailure(source) {
  const payload = source?.payload || {};
  const code = isText(payload.error) ? payload.error
    : (isText(source?.code) ? source.code : null);
  return {
    code,
    conflict: code === VERSION_CONFLICT,
    currentVersion: Number.isInteger(payload.current_version) ? payload.current_version
      : (Number.isInteger(source?.conflict?.current_version) ? source.conflict.current_version : null),
    message: code
      ? (PREFERENCE_REFUSALS[code] || `Preferences were not saved.`)
      : REFUSAL_SENTENCE,
  };
}

/* --------------------------------------------------------- quiet, right now */

/**
 * Whether quiet hours cover this instant. BOTH doors answer it and they are
 * read on one snapshot each, so either saying yes is yes; the page never
 * computes it from a clock of its own.
 */
export function quietNowBanner(feedPayload, preferencePayload) {
  const fromFeed = !!feedPayload && typeof feedPayload === "object" && feedPayload.quiet_now === true;
  const fromPreference = !!preferencePayload && typeof preferencePayload === "object"
    && preferencePayload.quiet_now === true;
  return fromFeed || fromPreference ? QUIET_NOW_BANNER : null;
}

/**
 * A resumed read may advance the current version while a person still holds
 * fields typed against an older one. Keep that draft's base for the record
 * layer's compare-and-swap. An untouched form uses the current read.
 */
export function preferenceSaveView(currentView, draftBaseVersion) {
  if (!currentView) return null;
  return Number.isInteger(draftBaseVersion) && draftBaseVersion >= 0
    ? { ...currentView, version: draftBaseVersion }
    : currentView;
}
