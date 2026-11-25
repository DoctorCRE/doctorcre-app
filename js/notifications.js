import { createPageBudget } from './read-budget.mjs';
import { createCommandDock } from "./command-dock.js";
import { performCommand } from "./command-feedback.mjs";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { createLiveClient } from "./live-client.js";
import { privateSession, sessionFetch } from "./private-session.js";
import { resolveDealroomBoot, updatesFromEngine } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs, renderNotificationBadge } from "./shell.js";
import { BUSINESS_TIME_ZONE, meetingTime } from "./business-date.js";
import {
  PREFERENCE_OPERATION_KEY, QUIET_SUPPRESSED_MARK,
  acknowledgeArgs, acknowledgeOperationKey, activityRows, changeRows, classifyPreferenceFailure,
  classifyPreferenceReadFailure, classifyReadFailure, enginePreferenceArgs, feedState, updateFailure,
  notificationCards, preferenceState, preferenceSummary, preferenceView,
  quietNowBanner, setPreferenceArgs, unreadLine, validFeedPayload,
  preferenceSaveView, preferenceTimeLabel,
} from "./notifications-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
/** Updates shows the feed and Settings the preference form; both read preferences. */
const updatesPage = Boolean($("feedList"));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** The second line of a feed state: what fills this space, or what to do next. */
const FEED_HINT = {
  no_match: "Nothing in this view. Refresh to read the whole feed again.",
  refused: "Sign in again to read your notifications.",
};

/** The cap this page asks for, and the number it compares the count against. */
const LIMIT = 25;

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  after: null,
  sequence: 0,
  feed: { state: "pending" },
  activity: { state: "pending" },
  preference: { state: "pending" },
};

let client = null;
const sources = {
  engine: {
    feed: () => client.updates(),
    markRead: (request) => client.markUpdatesRead(request),
    preference: () => client.preferences(),
    preferenceArgs: enginePreferenceArgs,
    savePreference: (request) => client.savePreferences(request),
  },
  old: {
    feed: () => client.notificationFeed(view.after ? { after: view.after, limit: LIMIT } : { limit: LIMIT }),
    markRead: (request) => client.acknowledgeNotification(request),
    preference: () => client.notificationPreferences(),
    preferenceArgs: setPreferenceArgs,
    savePreference: (request) => client.setNotificationPreference(request),
  },
};
let source = sources.old;
let commandState = {};
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();
/** True while a save is in flight, and true while the fields hold an edit. */
let saving = false;
let dirty = false;
/** A conflict clears the draft version until the current preferences are read. */
let draftBaseVersion = null;
let preferenceSequence = 0;
let readWrites = Promise.resolve();
const preferenceInputs = {
  quiet_from: "quietStart", quiet_until: "quietEnd", push_to_device: "deviceOptIn",
};

function announceFeed(text) {
  const live = $("feedLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function showPreferenceMessage(text) {
  const message = $("prefMessage");
  if (message.textContent !== text) message.textContent = text;
}

const preferenceModel = () => source === sources.engine ? view.preference.payload : preferenceView(view.preference.payload);
const savedZone = () => preferenceModel()?.timezone || BUSINESS_TIME_ZONE;
const asOf = (read) => {
  const clock = read.state === "read" && Number.isFinite(Date.parse(read.observed_at)) ? meetingTime(read.observed_at, savedZone()) : "";
  return clock ? `As of ${clock}` : "";
};

/* -------------------------------------------------------------------- painting */

function recordDetailsHtml(details, path = null) {
  const rows = [["Actor", details.actor], ["Record type", details.subjectType], ["Reference", details.subjectRef], ["Action", details.verb], ["Route", path]]
    .filter(([, value]) => value);
  if (!rows.length) return "";
  return `<details class="record-details"><summary>Details</summary><dl>${rows.map(([label, value]) =>
    `<dt>${label}</dt><dd class="mono">${escapeHtml(value)}</dd>`).join("")}</dl></details>`;
}

/** Rows a partner opened stay open across refreshes. */
const openRows = new Set();

/** A compact row: its title opens it, and everything in `more` stays folded until then. */
function rowHtml({ key, chip = "", title, detail, detailHref = "", meta, actions = "", more = "", attrs = "" }) {
  const open = openRows.has(key);
  const panel = `more-${key.replace(/[^\w-]/g, "_")}`;
  return `<li class="update-row" data-row="${escapeHtml(key)}"${open ? " data-open" : ""} ${attrs}>
    ${chip}
    <h3 class="row-title"><button type="button" class="row-toggle" aria-expanded="${open}" aria-controls="${escapeHtml(panel)}">${escapeHtml(title)}</button></h3>
    <span class="row-meta">${meta}</span>
    ${detailHref ? `<a class="note-subject" href="${escapeHtml(detailHref)}">${escapeHtml(detail)}</a>` : `<p class="note-subject">${escapeHtml(detail)}</p>`}
    <div class="row-act">${actions}</div>
    <div class="row-more" id="${escapeHtml(panel)}"${open ? "" : " hidden"}>${more}</div>
  </li>`;
}

function cardHtml(card) {
  const delivery = card.delivery.length ? `<ul class="note-delivery">${card.delivery
    .map((row) => `<li data-channel="${escapeHtml(row.channel)}" data-delivery="${escapeHtml(row.state)}">${escapeHtml(row.phrase)}</li>`)
    .join("")}</ul>` : "";
  const unread = card.reading?.kind === "unread";
  const routed = card.link.path && card.link.href;
  const link = routed
    ? `<span class="note-link" data-link="routed"><a href="${escapeHtml(card.link.href)}" target="_blank" rel="noopener"${unread ? ` data-open-unread="${escapeHtml(card.id)}"` : ""}>${escapeHtml(card.link.label)}</a></span>`
    : "";
  const unrouted = card.link.path && !routed ? `<p class="note-link" data-link="unrouted">${escapeHtml(card.link.sentence)}</p>` : "";
  const quiet = card.quietSuppressed
    ? `<span class="quiet-mark" data-quiet="suppressed" title="${escapeHtml(QUIET_SUPPRESSED_MARK)}"><span class="sr-only">${escapeHtml(QUIET_SUPPRESSED_MARK)}</span></span>`
    : "";
  const readMark = card.reading
    ? unread ? "" : `<span class="read-mark" data-read="true">Read at ${escapeHtml(card.readClock)}</span>`
    : card.read ? `<span class="read-mark" data-read="true">Acknowledged${card.readClock ? ` at ${escapeHtml(card.readClock)}` : ""}</span>` : "";
  const button = card.reading
    ? unread ? `<button class="btn" type="button" data-mark-read="${escapeHtml(card.id)}">Mark read</button>` : ""
    : card.read ? "" : `<button class="btn" type="button" data-ack="${escapeHtml(card.id)}">Acknowledge</button>`;
  return rowHtml({
    key: card.id,
    attrs: `data-priority="${card.severity === "failure" ? "overdue" : "deadline"}" data-notification="${escapeHtml(card.id)}"${unread || (!card.reading && !card.read) ? " data-unread" : ""}`,
    chip: `<span class="severity-chip" data-severity="${escapeHtml(card.severity || "")}">${escapeHtml(card.severityLabel)}</span>`,
    title: card.reason,
    detail: card.subject,
    meta: `${quiet}<span class="row-clock">${escapeHtml(card.clock)}</span>`,
    actions: `${link}${button}${readMark}`,
    more: `${delivery}${unrouted}${card.reading ? "" : recordDetailsHtml(card.details, card.link.path)}`,
  });
}

function toggleRow(row) {
  const key = row.dataset.row;
  const open = !openRows.delete(key);
  if (open) openRows.add(key);
  row.toggleAttribute("data-open", open);
  row.querySelector(".row-toggle").setAttribute("aria-expanded", String(open));
  row.querySelector(".row-more").hidden = !open;
}

/** A click anywhere on a row that is not one of its own controls opens or closes it. */
function onRowClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest(".update-row[data-row]");
  if (!row || target.closest(".row-more") || (target.closest("a, button") && !target.closest(".row-toggle"))) return false;
  toggleRow(row);
  return true;
}

function renderFeed() {
  const read = view.feed;
  $("feedAsOf").textContent = asOf(read);
  const state = feedState(read, source === sources.old ? { after: view.after, limit: LIMIT } : undefined);
  const block = $("feedState");
  block.setAttribute("data-state", state.state);
  $("feedStateTitle").textContent = state.sentence || "";
  const failed = ["refused", "unavailable", "unknown"].includes(state.state);
  $("retryRead").textContent = failed ? "Retry" : "Refresh";
  const hint = $("feedStateHint");
  if (hint) hint.textContent = FEED_HINT[state.state] || "";
  block.hidden = state.state === "ready";
  const payload = read.state === "read" ? read.payload : null;
  renderNotificationBadge(payload?.unread_count);
  const markAll = $("markAllRead");
  const shown = unreadUpdateIds().length;
  markAll.hidden = shown === 0;
  markAll.textContent = payload?.unread_count > shown ? "Mark shown as read" : "Mark all read";
  const unread = unreadLine(payload);
  $("unreadLine").textContent = unread;
  announceFeed(state.sentence || unread);
  $("feedList").innerHTML = notificationCards(payload, undefined, savedZone()).map(cardHtml).join("");
  const banner = $("quietNowBanner");
  const sentence = quietNowBanner(payload, view.preference.payload);
  banner.textContent = sentence || "";
  banner.setAttribute("data-quiet", sentence ? "now" : "off");
  banner.hidden = !sentence;
}

/**
 * The preference panel. The fields are painted from the ANSWER and never from
 * what was typed: a save that landed shows what the record layer now holds, and
 * a save that was refused shows what it still holds. While a save is in flight
 * the form is disabled, because a second save would carry the same stale
 * version and earn a conflict this page could have prevented.
 */
function renderPreference() {
  if (updatesPage) return;
  const read = view.preference;
  const model = preferenceModel();
  const state = preferenceState(read, model);
  const block = $("prefState");
  block.setAttribute("data-state", state.state);
  $("prefStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  $("retryPreference").hidden = state.state === "ready" || state.state === "loading";
  $("prefAsOf").textContent = asOf(read);
  $("prefSummary").textContent = preferenceSummary(model);
  $("prefSummary").hidden = !model;
  const form = $("prefForm");
  form.hidden = !model && !dirty;
  form.setAttribute("data-disabled", String(saving));
  form.setAttribute("data-quiet", model?.quietHoursSet ? "set" : "off");
  const retained = commandState[PREFERENCE_OPERATION_KEY];
  for (const id of ["deviceOptIn", "quietStart", "quietEnd", "prefSave", "prefClear"]) {
    const field = $(id);
    if (field) field.disabled = saving || !model || (Boolean(retained) && id !== "prefSave");
  }
  $("prefSave").textContent = retained ? "Check outcome" : "Save preferences";
  if (!model || dirty) return;
  $("deviceOptIn").checked = model.deviceOptIn;
  $("quietStart").value = preferenceTimeLabel(model.start);
  $("quietEnd").value = preferenceTimeLabel(model.end);
}

function renderActivity() {
  const read = view.activity;
  // The old change feed retires when Deals reads move to the engine before its saves do.
  $("activityBlock").hidden = read.state === "retired" || read.state === "pending";
  $("activityAsOf").textContent = asOf(read);
  const payload = read.state === "read" ? read.payload : null;
  const rows = payload?.changes ? changeRows(payload.changes, savedZone()) : activityRows(payload?.events, savedZone());
  $("activityState").hidden = read.state === "pending" || (Boolean(payload) && !read.refreshFailed);
  $("retryActivity").hidden = source === sources.old;
  const more = $("activityMore");
  more.hidden = payload?.cursor?.kind !== "more";
  more.disabled = read.loadingMore === true;
  more.textContent = read.moreFailed === "invalid_fields" ? "Reload activity" : read.moreFailed ? "Retry" : "Show more";
  $("activityMoreState").textContent = read.moreFailed ? "Couldn't load more" : "";
  $("activityList").innerHTML = rows.map((row, n) => rowHtml({
    key: `activity:${row.id ?? n}`,
    attrs: 'data-priority="ordinary"',
    title: `${row.actor} · ${row.verb}`,
    detail: row.subject,
    detailHref: row.link?.href,
    meta: `<span class="row-clock">${escapeHtml(row.clock)}</span>`,
    more: recordDetailsHtml(row.details),
  })).join("") || (payload ? `<li class="update-row" data-priority="ordinary"><h3 class="row-title">No recent activity</h3></li>` : "");
}

function render() {
  if (updatesPage) {
    renderFeed();
    renderActivity();
  }
  renderPreference();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, settled on its own. A failure is classified from its STATUS and its
 * CODE, which is what tells a decision apart from a silence; the server's own
 * text is never carried into the sentence a person reads.
 */
async function takeFeed() {
  const pending = view.feed.state === "read" ? { ...view.feed, refreshing: true } : { state: "pending" };
  view.feed = pending;
  render();
  try {
    const payload = await source.feed();
    if (view.feed !== pending) return;
    if (source === sources.old && !validFeedPayload(payload)) throw new Error("Invalid notification feed");
    view.feed = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch (error) {
    if (view.feed !== pending) return;
    view.feed = classifyReadFailure(error);
  }
  render();
}

/**
 * The preference read. It passes NOTHING: the verb declares zero properties,
 * and the client method takes no arguments, so there is no place an actor, a
 * tenant or a filter could be introduced here.
 */
async function takePreference() {
  const sequence = ++preferenceSequence;
  if (view.preference.state !== "read" || (dirty && draftBaseVersion === null)) {
    view.preference = { state: "pending" };
    renderPreference();
  }
  try {
    const payload = await source.preference();
    if (preferenceSequence !== sequence) return;
    view.preference = { state: "read", payload, observed_at: new Date().toISOString() };
    if (!preferenceModel()) throw new Error("Preferences unavailable");
    if (dirty) {
      const version = preferenceModel().version;
      if (draftBaseVersion === null) draftBaseVersion = version;
      else if (version !== draftBaseVersion) {
        showPreferenceMessage("Preferences changed while you were editing. Save will check your earlier version before changing anything.");
      }
    }
  } catch (error) {
    if (preferenceSequence !== sequence) return;
    view.preference = classifyPreferenceReadFailure(error);
  }
  render();
}

async function takeChanges() {
  const sequence = view.sequence;
  const shown = new Set(view.activity.payload?.changes.map((row) => row.id));
  const newer = [];
  let before = null;
  const takePage = createPageBudget();
  try {
    // eslint-disable-next-line no-restricted-syntax -- takePage checks the budget before each read, with a max of 100 pages per refresh.
    do {
      takePage();
      const page = await readChanges(before);
      if (view.sequence !== sequence) return;
      before = page.cursor.before ?? null;
      const overlap = page.changes.findIndex((row) => shown.has(row.id));
      newer.push(...(overlap < 0 ? page.changes : page.changes.slice(0, overlap)));
      if (overlap >= 0) break;
    } while (shown.size && before);
    const current = view.activity.payload;
    const changes = uniqueChanges([...newer, ...(current?.changes ?? [])]);
    view.activity = {
      ...view.activity,
      state: "read", observed_at: new Date().toISOString(), refreshFailed: false,
      payload: { changes, cursor: shown.size ? current.cursor : before ? { kind: "more", before } : { kind: "end" } },
    };
  } catch {
    if (view.sequence !== sequence) return;
    view.activity = view.activity.state === "read" ? { ...view.activity, refreshFailed: true } : { state: "unknown" };
  }
  renderActivity();
}

async function readChanges(before) {
  const page = await client.updateChanges(before);
  if (before && page.cursor.before === before) throw new Error("Who did what unavailable");
  return page;
}

function uniqueChanges(changes) {
  return [...new Map(changes.map((row) => [row.id, row])).values()];
}

async function takeMoreChanges() {
  const before = view.activity.payload?.cursor?.before;
  if (!before || view.activity.loadingMore) return;
  if (view.activity.moreFailed === "invalid_fields") {
    view.activity = { state: "pending" };
    return takeChanges();
  }
  view.activity = { ...view.activity, loadingMore: true, moreFailed: false };
  renderActivity();
  try {
    const page = await readChanges(before);
    const changes = uniqueChanges([...view.activity.payload.changes, ...page.changes]);
    view.activity = {
      state: "read", observed_at: new Date().toISOString(),
      payload: { changes, cursor: page.cursor },
    };
  } catch (error) {
    view.activity = { ...view.activity, loadingMore: false, moreFailed: updateFailure(error).kind };
  }
  renderActivity();
}

async function takeActivity() {
  if (source === sources.engine) return takeChanges();
  const sequence = view.sequence;
  try {
    let cursor = view.activity?.payload?.cursor || null;
    let events = view.activity?.payload?.events || [];
    const seen = new Set();
    let payload;
    const takePage = createPageBudget();
    // eslint-disable-next-line no-restricted-syntax -- Feed pagination consumes takePage before each read; a max of 100 pages per refresh.
    do {
      takePage();
      payload = await client.getChanges(cursor);
      if (view.sequence !== sequence) return;
      if (payload === null) {
        view.activity = { state: "retired" };
        renderActivity();
        return;
      }
      if (!Array.isArray(payload?.events) || typeof payload.cursor !== "string" || payload.ok === false) throw new Error("Activity page unavailable.");
      const rows = payload.events;
      if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Activity event unavailable.");
      events = [...events, ...rows].slice(-12);
      if (!rows.length) break;
      if (!payload.cursor || payload.cursor === cursor || seen.has(payload.cursor)) throw new Error("Activity cursor did not advance.");
      seen.add(payload.cursor);
      cursor = payload.cursor;
    } while (true);
    view.activity = { state: "read", payload: { ...payload, cursor: cursor || payload.cursor, events }, observed_at: new Date().toISOString() };
  } catch {
    if (view.sequence !== sequence) return;
    view.activity = { state: "unknown" };
  }
  render();
}

async function load() {
  ++view.sequence;
  await Promise.all(updatesPage ? [takeFeed(), takeActivity(), takePreference()] : [takePreference()]);
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary) {
  const feedAtDispatch = view.feed;
  let failure;
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: async (request) => {
      try { return await source.markRead(request); }
      catch (error) { failure = updateFailure(error); throw error; }
    },
  });
  operations.set(operationKey, { args, summary });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null, canDispatch: failure?.kind !== "missing",
    // eslint-disable-next-line no-restricted-syntax -- The dock only retries on a click.
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announceFeed(result.message);
  if (source === sources.old) {
    if (result.status === "ok") await load();
    return;
  }
  if (failure?.kind === "missing") {
    await takeFeed();
  } else if (result.status === "ok") {
    const { readTimes, unread_count } = result.response;
    const payload = view.feed.payload;
    if (!payload) return takeFeed();
    const needsFreshCount = result.replayed || view.feed !== feedAtDispatch;
    const updates = payload.updates.map((row) => row.reading.kind === "unread" && readTimes.has(row.id)
      ? { ...row, reading: { kind: "read", at: readTimes.get(row.id) } }
      : row);
    view.feed = {
      state: "read",
      payload: { updates, unread_count: needsFreshCount ? payload.unread_count : unread_count },
      observed_at: needsFreshCount ? view.feed.observed_at : new Date().toISOString(),
    };
    if (needsFreshCount) await takeFeed();
    else renderFeed();
  }
}

function sendRead(operationKey, args, summary) {
  const send = () => dispatch(operationKey, args, summary);
  if (source === sources.old) return send();
  readWrites = readWrites.then(send, send);
}

const unreadUpdateIds = () => (view.feed.payload?.updates ?? [])
  .filter((row) => row.reading.kind === "unread").map((row) => row.id);

function markUpdates(ids, operationKey = "updates:mark-all") {
  if (!ids.length || commandState[operationKey]) return;
  const summary = ids.length === 1 ? "Mark update as read" : "Mark updates as read";
  dock.record(operationKey, { summary, status: "sending", undo: false });
  sendRead(operationKey, { update_ids: ids }, summary);
}

function acknowledge(id) {
  const built = acknowledgeArgs(id);
  if (!built.ok) {
    announceFeed(built.message);
    return;
  }
  const operationKey = acknowledgeOperationKey(id);
  const summary = "Acknowledge notification";
  dock.record(operationKey, { summary, status: "sending", undo: false });
  sendRead(operationKey, built.args, summary);
}

/* --------------------------------------------------- the preference write */

/**
 * One save. The arguments are built from the form and from the LAST READ's
 * version; a refusal is rendered by the record layer's own reason id, and a
 * `version_conflict` re-reads before it says anything, so the sentence a person
 * reads is true about the values now on screen.
 */
async function savePreference(form) {
  if (saving) return;
  const model = preferenceModel();
  const retained = commandState[PREFERENCE_OPERATION_KEY];
  const built = retained ? { ok: true, args: retained.request } : source.preferenceArgs(form, preferenceSaveView(model, draftBaseVersion));
  if (!built.ok) {
    showPreferenceMessage(built.message);
    return built;
  }
  saving = true;
  showPreferenceMessage("");
  renderPreference();
  for (const id of Object.values(preferenceInputs)) $(id).removeAttribute("aria-invalid");
  if (source === sources.old && !retained) {
    try {
      const payload = await source.preference(), current = preferenceView(payload);
      if (!current) throw new Error("Preferences unavailable");
      view.preference = { state: "read", payload, observed_at: new Date().toISOString() };
      if (current.version !== built.args.base_version) {
        // Current saved values appear in the summary beside the held draft.
        // The next deliberate save reviews this version and reads again.
        dirty = true; draftBaseVersion = current.version; saving = false;
        renderPreference();
        showPreferenceMessage("Preferences changed. Review the current saved preferences above and your kept draft before saving again.");
        return;
      }
    } catch {
      saving = false; renderPreference();
      showPreferenceMessage("Preferences not sent. Their current version could not be verified.");
      return;
    }
  }
  const summary = form.clear_quiet_hours === true
    ? "Clear quiet hours"
    : "Save notification preferences";
  dock.record(PREFERENCE_OPERATION_KEY, { summary, status: "sending", undo: false });
  let failure;
  const result = await performCommand({
    operationKey: PREFERENCE_OPERATION_KEY,
    args: built.args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: async (request) => {
      try { return await source.savePreference(request); }
      catch (error) { failure = updateFailure(error); throw error; }
    },
  });
  saving = false;
  let sentence = result.message || null;
  if (result.status === "refused" || result.status === "conflict") {
    // The kernel classifies `version_conflict` as a CONFLICT and every other
    // reason id as a REFUSAL, and both are settled answers that saved nothing,
    // so both are rendered by the record layer's own name for them.
    const refusal = classifyPreferenceFailure(result);
    sentence = refusal.message;
    if (failure?.kind === "invalid_fields") {
      for (const field of failure.fields) {
        if (Object.hasOwn(preferenceInputs, field)) $(preferenceInputs[field]).setAttribute("aria-invalid", "true");
      }
      sentence = "Check the highlighted fields and save again.";
    }
    // A conflict is not retried. Show the current saved values beside the
    // unsaved fields so the person can review both before another save.
    if (failure?.kind === "conflict" || (source === sources.old && refusal.conflict)) {
      dirty = true;
      draftBaseVersion = null;
      sentence = `${sentence} Your draft is kept. Review the current saved preferences above before saving again.`;
      showPreferenceMessage(sentence);
      await takePreference();
    }
  }
  dock.record(PREFERENCE_OPERATION_KEY, {
    // eslint-disable-next-line no-restricted-syntax -- Only an explicit save or retry dispatches preferences; the receipt flag schedules no attempts.
    summary, status: result.status, reason: sentence, retry: result.retry, undo: false,
    request: result.request,
  });
  if (result.status === "ok") {
    dirty = false;
    draftBaseVersion = null;
    sentence = sentence || "Saved";
  }
  showPreferenceMessage(sentence || "");
  if (result.status === "ok") {
    if (source === sources.engine) {
      const preference = result.response.preference;
      if (preference.version >= (preferenceModel()?.version ?? 0)) {
        ++preferenceSequence;
        view.preference = { state: "read", payload: preference, observed_at: new Date().toISOString() };
      }
    } else await load();
  }
  renderPreference();
  return result;
}

/** What the four controls currently say, read once, at submit time. */
const formValues = () => ({
  device_opt_in: $("deviceOptIn").checked,
  quiet_hours_start: $("quietStart").value,
  quiet_hours_end: $("quietEnd").value,
});

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  const resend = (operationKey) => {
    if (operationKey === PREFERENCE_OPERATION_KEY) return savePreference(formValues());
    const entry = operations.get(operationKey);
    if (entry) sendRead(operationKey, entry.args, entry.summary);
  };
  dock = createCommandDock({
    root,
    onDispatch: resend,
    onReconcile: resend,
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();

  mountDock();
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.after = params.get("after") || null;
  $("retryRead")?.addEventListener("click", () => load());
  $("retryPreference")?.addEventListener("click", () => takePreference());
  $("retryActivity")?.addEventListener("click", () => takeActivity());
  $("markAllRead")?.addEventListener("click", () => markUpdates(unreadUpdateIds()));
  $("activityMore")?.addEventListener("click", () => takeMoreChanges());
  $("prefForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    savePreference(formValues());
  });
  $("prefForm")?.addEventListener("input", (event) => {
    event.target.removeAttribute("aria-invalid");
    if (!dirty) draftBaseVersion = view.preference.state === "read"
      ? preferenceModel()?.version ?? null
      : null;
    dirty = true;
  });
  $("prefClear")?.addEventListener("click", () => {
    savePreference({ clear_quiet_hours: true });
  });
  $("feedList")?.addEventListener("click", (event) => {
    if (onRowClick(event)) return;
    const target = event.target instanceof Element ? event.target.closest("[data-ack], [data-open-unread], [data-mark-read]") : null;
    if (!target) return;
    const read = target.dataset.openUnread ?? target.dataset.markRead;
    if (read) markUpdates([read], acknowledgeOperationKey(read));
    else acknowledge(target.dataset.ack);
  });
  $("activityList")?.addEventListener("click", onRowClick);
  const boot_ = resolveDealroomBoot(location);
  const docLink = $("docLinkSettings");
  const session = privateSession();
  if (docLink && session) {
    void session.verify().then(async () => {
      if (!session.engineSignIn) return;
      const { mountDocLinkSettings } = await import("./ui-doc-link-settings.generated.js");
      if (session.engineSignIn) mountDocLinkSettings(docLink, sessionFetch);
    }).catch(() => {
      if (session.engineSignIn) docLink.textContent = "Couldn't load Doc link settings.";
    });
  }
  const outage = params.get("outage");
  if (updatesFromEngine()) source = sources.engine;
  client = boot_.mode === "live"
    ? createLiveClient()
    : await (await import("./fixture-client.js")).createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  if (!updatesPage) mountNotificationBadge(client);
  mountAutoRefresh({ document, window: globalThis.window, refresh: load });
  await load();
}

boot();

export { view };
