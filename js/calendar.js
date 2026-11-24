import { selectDocRecord, pageDocContext } from './doc-context.js';
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import { BUSINESS_TIME_ZONE } from "./business-date.js";
import { meetingTime } from "./home-week.js";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import {
  addDays, approach, calendarHref, calendarPhase, entriesByDay, localToday, monthGrid, motionDirection,
  parseCalendarState, readCalendar, readMeetings, shortDay, stepAnchor, visibleRange, weekStrip,
} from "./calendar-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_CHIP_LIMIT = 2;

/** One place holds what this page believes. */
const view = {
  today: localToday(),
  state: null,
  painted: null,
  focusEntry: null,
  result: { status: "loading" },
  meetings: { range: null, status: "off", entries: [], notes: [] },
  meetingSequence: 0,
  byDay: new Map(),
  sequence: 0,
  refreshFailed: false,
};

let client = null;

/** The OS setting or the in-app toggle; either one stops programmatic motion. */
function motionReduced() {
  const media = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return media || document.documentElement.getAttribute("data-motion") === "reduced";
}

function announce(text) {
  const live = $("calLive");
  if (live && live.textContent !== text) live.textContent = text;
}

const recordName = entry => entry.record_name ?? entry.deal_name;
const KINDS = [
  { type: "step", label: "Next step", one: "next step", many: "next steps" },
  { type: "date", label: "Critical date", one: "critical date", many: "critical dates" },
  { type: "meeting", label: "Meeting", one: "meeting", many: "meetings" },
  { type: "tour", label: "Tour", one: "tour", many: "tours" },
];
const typeLabel = entry => KINDS.find(kind => kind.type === entry.type).label;
const entryTime = entry => entry.type !== "meeting" ? "" : entry.all_day ? "All day" : meetingTime(entry.at, BUSINESS_TIME_ZONE);
const entryText = entry => [entryTime(entry), entry.label].filter(Boolean).join(" ");
const ownerNames = entry => (entry.owners ?? [entry.owner]).filter(owner => typeof owner === "string" && owner)
  .map(owner => owner[0].toUpperCase() + owner.slice(1)).join(" and ");

function chipHtml(entry, { withDeal }) {
  const near = approach(entry, view.today);
  const text = [typeLabel(entry), entryText(entry), recordName(entry), near.label].filter(Boolean).join(" · ");
  return `<li><button class="cal-chip" type="button" data-entry="${escapeHtml(entry.key)}" data-day="${escapeHtml(entry.day)}" data-band="${near.band}" aria-label="${escapeHtml(text)}">`
    + `<span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span>`
    + `<span class="cal-chip-label">${escapeHtml(entryText(entry))}</span>`
    + (withDeal ? `<span class="cal-chip-deal">${escapeHtml(recordName(entry))}</span>` : "")
    + "</button></li>";
}

const calendarLayout = ({ view, anchor }) => view === "week" ? weekStrip(anchor) : monthGrid(anchor);

function dayHtml(cell, index) {
  const state = view.state;
  const rows = cell.inMonth ? view.byDay.get(cell.day) || [] : [];
  const week = state.view === "week";
  const lateCount = rows.filter(entry => entry.days_late > 0).length;
  const dated = rows.filter(entry => !entry.days_late);
  const lateChip = lateCount ? `<li><button class="cal-chip" type="button" data-entry="late" data-day="${cell.day}" data-band="overdue" aria-label="${lateCount} late step${lateCount === 1 ? "" : "s"}">
    <span class="cal-chip-label">${lateCount} late</span>
  </button></li>` : "";
  const shown = week ? dated : dated.slice(0, MONTH_CHIP_LIMIT - Number(Boolean(lateCount)));
  const more = dated.length - shown.length;
  const selected = (state.day || view.today) === cell.day && cell.inMonth;
  const isToday = cell.day === view.today;
  const readable = formatCalendarDate(cell.day);
  const count = rows.length ? ` · ${itemCount(rows)}` : "";
  const dayNumber = Number(cell.day.slice(8));
  return `<div class="cal-day" role="gridcell" data-day="${cell.day}" data-today="${isToday}" data-out-month="${!cell.inMonth}" aria-selected="${selected}">`
    + `<button class="cal-day-open" type="button" data-select-day="${cell.day}" tabindex="${selected ? 0 : -1}" aria-label="${escapeHtml(`${readable}${isToday ? " · today" : ""}${count}`)}">`
    + `<span class="cal-day-num">${week ? `${WEEKDAYS[index % 7]} ${dayNumber}` : dayNumber}</span>`
    + (rows.length ? `<span class="cal-day-count" aria-hidden="true">${rows.length}</span>` : "")
    + "</button>"
    + (lateChip || shown.length ? `<ul class="cal-chips">${lateChip}${shown.map((entry) => chipHtml(entry, { withDeal: week })).join("")}</ul>` : "")
    + (more > 0 ? `<span class="cal-more">+${more} more</span>` : "")
    + "</div>";
}

function paintGrid(layout) {
  const grid = $("calGrid");
  if (!grid) return;
  const state = view.state;
  const header = `<div class="cal-week" role="row">${WEEKDAYS.map((name) => `<div class="cal-weekday" role="columnheader">${name}</div>`).join("")}</div>`;
  const weeks = [];
  // eslint-disable-next-line no-restricted-syntax -- Calendar rendering advances seven days per iteration and will stop at layout.days.length; 0 reads.
  for (let start = 0; start < layout.days.length; start += 7) {
    const cells = layout.days.slice(start, start + 7).map((cell, offset) => dayHtml(cell, start + offset)).join("");
    weeks.push(`<div class="cal-week" role="row">${cells}</div>`);
  }
  const direction = motionDirection(view.painted, state);
  grid.dataset.view = state.view;
  grid.innerHTML = header + weeks.join("");
  // Restart the transition on every paint: removing the attribute and reading
  // layout lets the same direction play twice in a row.
  grid.removeAttribute("data-enter");
  if (!motionReduced() && direction !== "none") {
    void grid.offsetWidth;
    grid.setAttribute("data-enter", direction === "enter" ? "zoom-in" : direction);
  }
  view.painted = { ...state };

  const period = $("calPeriod");
  if (period) period.textContent = layout.title;
  const unit = state.view === "week" ? "week" : "month";
  $("calPrev")?.setAttribute("aria-label", `Previous ${unit}`);
  $("calNext")?.setAttribute("aria-label", `Next ${unit}`);
  document.querySelectorAll("#calViewSwitch [data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
}

function paintSelection() {
  const cells = [...$("calGrid").querySelectorAll(".cal-day[data-out-month='false']")];
  const selected = cells.find(cell => cell.dataset.day === (view.state.day || view.today));
  cells.forEach(cell => {
    cell.setAttribute("aria-selected", String(cell === selected));
    cell.querySelector(".cal-day-open").tabIndex = cell === (selected || cells[0]) ? 0 : -1;
  });
  const day = selected?.dataset.day;
  paintDayPanel(day);
  paintComingUp(day);
}

function recordLinks(entry) {
  const links = entry.links ?? [{ name: recordName(entry),
    url: entry.type === "date" ? entry.deal_id && `/deals?deal=${encodeURIComponent(entry.deal_id)}` : entry.open_url }];
  return links.filter(link => link.name).map(({ name, url }) => url
    ? `<a href="${escapeHtml(url)}" data-entry="${escapeHtml(entry.key)}">${escapeHtml(name)}</a>` : escapeHtml(name)).join(", ");
}

function itemCount(rows) {
  return KINDS.map(kind => {
    const count = rows.filter(entry => entry.type === kind.type).length;
    return count && `${count} ${count === 1 ? kind.one : kind.many}`;
  }).filter(Boolean).join(" · ") || "0 items";
}

function dayList(rows) {
  return `<ol class="cal-day-entries">${rows.map(entry => {
    const near = approach(entry, view.today);
    const byline = [ownerNames(entry), entryTime(entry) && `<time datetime="${escapeHtml(entry.at)}">${escapeHtml(entryTime(entry))}</time>`]
      .filter(Boolean).map(part => ` · ${part}`).join("");
    const record = recordLinks(entry);
    const late = entry.days_late ? `<span class="cal-late">${entry.days_late} ${entry.days_late === 1 ? "day" : "days"} late · Due ${shortDay(entry.due_on, view.today)}</span>` : "";
    return `<li class="cal-day-entry" data-focus="${entry.key === view.focusEntry}">
      <small><span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span> ${typeLabel(entry)}${byline}</small>
      <h3>${escapeHtml(entry.label)}</h3>
      ${entry.why ? `<p>${escapeHtml(entry.why)}</p>` : ""}
      ${record ? `<p>${record}</p>` : ""}${late}</li>`;
  }).join("")}</ol>`;
}

function paintDayPanel(day) {
  $("dayPanelTitle").textContent = day ? formatCalendarDate(day) : "Choose a day";
  const body = $("dayPanelBody");
  const phase = calendarPhase(view.result);
  const rows = view.byDay.get(day) || [];
  if (phase === "unauthorized" || phase === "unavailable") {
    body.textContent = "Calendar temporarily unavailable.";
  } else if (rows.length) {
    const late = rows.filter(entry => entry.days_late > 0);
    const dated = rows.filter(entry => !entry.days_late);
    body.innerHTML = (phase === "partial" ? "<p>This day may be incomplete. Refresh to try again.</p>" : "") + (late.length
      ? `<section class="cal-day-late" aria-labelledby="calLateTitle"><h3 id="calLateTitle">Late</h3>${dayList(late)}</section>`
      : "") + (dated.length ? dayList(dated) : "");
  } else {
    body.textContent = phase === "loading" || phase === "reading" ? "Reading Calendar…"
      : !day ? "Select a day to see its items."
      : phase === "partial" ? "This day may be incomplete. Refresh to try again." : "Nothing on this day.";
  }
}

function paintComingUp(day) {
  const after = day && day > view.today ? day : view.today;
  const dates = [...view.byDay.keys()].filter(date => date > after).sort().slice(0, 5);
  $("calComing").hidden = dates.length === 0;
  $("calAgenda").innerHTML = dates.map(date => {
    const items = view.byDay.get(date).map(entry => `<span class="cal-agenda-detail">
      ${escapeHtml(entryText(entry))}<small>${escapeHtml([recordName(entry), ownerNames(entry)].filter(Boolean).join(" · "))}</small>
    </span>`).join("");
    return `<li><button class="cal-agenda-item" type="button" data-day="${date}">
      <time datetime="${date}">${shortDay(date, view.today)}</time>
      <span class="cal-agenda-details">${items}</span>
    </button></li>`;
  }).join("");
  const missing = view.result.undated || [];
  $("calUndated").hidden = missing.length === 0;
  $("calUndatedList").innerHTML = missing.map(entry =>
    `<li><b>${escapeHtml(entry.label)}</b> · ${recordLinks(entry)} · Date unavailable</li>`).join("");
}

const STATE_COPY = {
  loading: "Reading Calendar…",
  reading: "Reading deal dates…",
  unauthorized: "Your session has ended.",
  unavailable: "Calendar temporarily unavailable. Refresh to try again.",
};

function paintState(phase, periodRows) {
  const block = $("calState");
  const unit = view.state.view;
  const empty = ["ready", "empty"].includes(phase) && periodRows.length === 0;
  const message = empty ? `Nothing this ${unit}.` : STATE_COPY[phase];
  block.hidden = !message;
  const signIn = phase === "unauthorized"
    ? ` <a href="/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>` : "";
  block.innerHTML = message ? `<p>${escapeHtml(message)}${signIn}</p>` : "";
}

function paintNotices(phase) {
  const region = $("calNotices");
  if (!region) return;
  const notes = view.meetings.notes;
  const notices = (view.refreshFailed
    ? `<div class="notice" role="status"><p>Calendar could not refresh. Try again.</p><button type="button" id="calRetry">Retry</button></div>` : "")
    + (notes.length ? `<div class="notice notice-partial" role="status">${notes.map(note => `<p class="notice-copy">${escapeHtml(note)}</p>`).join("")}</div>` : "");
  if (phase !== "partial" && !(phase === "reading" && view.result.failed.length)) { region.innerHTML = notices; return; }
  const failed = view.result.failed;
  const names = failed.slice(0, 6).map((row) => escapeHtml(row.deal_name)).join(", ");
  const rest = failed.length > 6 ? ` and ${failed.length - 6} more` : "";
  region.innerHTML = notices + `<div class="notice notice-partial" role="status"><p class="notice-title">${failed.length} of ${view.result.dealCount} deals temporarily unavailable</p>`
    + `<p class="notice-copy">Their dates are not on this calendar: ${names}${rest}.</p></div>`;
}

function render() {
  const active = document.activeElement;
  const focusScope = active?.closest("#calGrid, #dayPanelBody, #calAgenda");
  const focusSelector = active?.dataset.selectDay
    ? `[data-select-day="${CSS.escape(active.dataset.selectDay)}"]`
    : active?.dataset.entry ? `[data-entry="${CSS.escape(active.dataset.entry)}"]`
    : active?.dataset.day ? `button[data-day="${CSS.escape(active.dataset.day)}"]` : null;
  const phase = calendarPhase(view.result);
  const layout = calendarLayout(view.state);
  view.byDay = ["ready", "partial", "reading", "empty"].includes(phase)
    ? entriesByDay([...(view.result.entries || []), ...view.meetings.entries]) : new Map();
  paintNotices(phase);
  $("calMeetingsNote").hidden = view.meetings.status === "off";
  const periodRows = layout.days.flatMap(cell => cell.inMonth ? view.byDay.get(cell.day) || [] : []);
  const count = $("calCount");
  const total = ["ready", "partial", "empty"].includes(phase) ? itemCount(periodRows) : "";
  if (count.textContent !== total) count.textContent = total;
  paintState(phase, periodRows);
  const gridNode = $("calGrid");
  gridNode.setAttribute("aria-busy", String(phase === "loading" || phase === "reading"));
  if (phase === "unauthorized" || phase === "unavailable") {
    if (gridNode) gridNode.innerHTML = "";
    view.painted = null;
  } else {
    paintGrid(layout);
  }
  paintSelection();
  if (focusScope && focusSelector) focusScope.querySelector(focusSelector)?.focus({ preventScroll: true });

  const asOf = $("calAsOf");
  if (["ready", "partial"].includes(view.result.status)) asOf.textContent = updatedLabel(view.updatedAt);
  else asOf.textContent = "";
}

/* -------------------------------------------------------------- navigation */

function go(next, { push = true } = {}) {
  const before = view.state;
  view.state = next;
  const href = calendarHref(next);
  if (`${location.pathname}${location.search}` !== href) {
    if (push) history.pushState({ calendar: true }, "", href);
    else history.replaceState({ calendar: true }, "", href);
  }
  const moved = !before || before.view !== next.view || before.anchor !== next.anchor;
  if (moved) {
    void loadMeetings();
    render();
  }
  else paintSelection();
  const periodText = $("calPeriod")?.textContent || "";
  if (moved) announce(`${periodText}. ${next.view === "week" ? "Week" : "Month"} view.`);
}

/** Select a day, moving the period so it is on screen. Selection replaces history. */
function selectDay(day, { entry = null, focus = false } = {}) {
  view.focusEntry = entry;
  const currentEntry = view.result?.entries?.find(row => row.key === entry);
  selectDocRecord(currentEntry?.deal_id ? "deal" : null, currentEntry?.deal_id);
  if (currentEntry?.deal_id) void client.getDeal(currentEntry.deal_id).catch(() => {});
  const state = view.state;
  const inView = calendarLayout(state).days.some(cell => cell.inMonth && cell.day === day);
  const next = { ...state, day, anchor: inView ? state.anchor : day };
  go(next, { push: !inView });
  if (focus) {
    const button = document.querySelector(`.cal-day-open[data-select-day="${day}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", behavior: motionReduced() ? "auto" : "smooth" });
  }
  const rows = view.byDay.get(day) || [];
  const incomplete = calendarPhase(view.result) === "partial" ? " This day may be incomplete." : "";
  announce(`${formatCalendarDate(day)}: ${itemCount(rows)}.${incomplete}`);
}

const ARROW_STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function wire() {
  $("calViewSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === view.state.view) return;
    const selected = $("calGrid")?.querySelector('[aria-selected="true"][data-out-month="false"]');
    go({ ...view.state, view: button.dataset.view, anchor: selected?.dataset.day || view.state.anchor });
  });
  $("calPrev")?.addEventListener("click", () => go(stepAnchor(view.state, -1)));
  $("calNext")?.addEventListener("click", () => go(stepAnchor(view.state, 1)));
  $("calToday")?.addEventListener("click", () => go({ ...view.state, anchor: view.today, day: view.today }));
  $("calRefresh")?.addEventListener("click", () => load());
  $("calNotices")?.addEventListener("click", (event) => {
    if (event.target.closest("#calRetry")) load();
  });

  $("calGrid")?.addEventListener("click", (event) => {
    const chip = event.target.closest(".cal-chip");
    if (chip) { selectDay(chip.dataset.day, { entry: chip.dataset.entry }); return; }
    const open = event.target.closest(".cal-day-open");
    if (open) selectDay(open.dataset.selectDay);
  });
  $("calGrid")?.addEventListener("keydown", (event) => {
    const open = event.target.closest(".cal-day-open");
    const step = ARROW_STEP[event.key];
    if (!open || !step) return;
    event.preventDefault();
    selectDay(addDays(open.dataset.selectDay, step), { focus: true });
  });
  $("calAgenda")?.addEventListener("click", (event) => {
    const item = event.target.closest(".cal-agenda-item");
    if (item) selectDay(item.dataset.day, { focus: true });
  });

  window.addEventListener("popstate", () => {
    view.state = parseCalendarState(location.search, view.today);
    void loadMeetings();
    render();
  });
}

const sameRange = (a, b) => a?.from === b.from && a?.to === b.to;

/** A newly shown period's meetings. */
async function loadMeetings() {
  const range = visibleRange(calendarLayout(view.state).days);
  if (!client || calendarPhase(view.result) === "unauthorized" || sameRange(view.meetings.range, range)) return;
  const sequence = ++view.meetingSequence;
  view.meetings = { ...view.meetings, range, entries: [], notes: [] };
  const read = await readMeetings(client, range);
  if (sequence !== view.meetingSequence) return;
  view.meetings = { ...read, range };
  render();
}

async function load() {
  const sequence = ++view.sequence;
  const showingResults = ["ready", "partial"].includes(view.result.status);
  // Every load reads the shown period's meetings alongside the dates, so the page paints once.
  const range = visibleRange(calendarLayout(view.state).days);
  const meetingSequence = ++view.meetingSequence;
  const shownMeetings = sameRange(view.meetings.range, range) && ["ready", "partial"].includes(view.meetings.status)
    ? view.meetings : null;
  if (!sameRange(view.meetings.range, range)) view.meetings = { ...view.meetings, range, entries: [], notes: [] };
  if (!showingResults) {
    view.result = { status: "loading" };
    render();
  }
  view.today = localToday();
  const [result, meetings] = await Promise.all([readCalendar(client, { onProgress: result => {
    if (sequence !== view.sequence || (showingResults && result.status === "reading")) return;
    view.result = result;
    render();
  } }), readMeetings(client, range)]);
  const current = meetingSequence === view.meetingSequence;
  // A failed refresh keeps the meetings already on screen, like the dates.
  const meetingsFailed = current && shownMeetings !== null && meetings.status === "unavailable";
  if (current && !meetingsFailed) view.meetings = { ...meetings, range };
  if (sequence !== view.sequence) return;
  if (showingResults && (result.status === "unavailable" ||
      (result.status === "ready" && result.failed.length > 0 && result.readCount === 0))) {
    view.refreshFailed = true;
    render();
    announce("Calendar could not refresh. Try again.");
    return false;
  }
  view.refreshFailed = meetingsFailed;
  view.result = result;
  const selected = pageDocContext?.snapshot().selected;
  if(selected?.kind === "deal" && result.status === "ready") void client.getDeal(selected.id).catch(() => {});
  if (["ready", "partial"].includes(result.status) && !meetingsFailed) view.updatedAt = new Date().toISOString();
  view.painted = null;
  render();
  announce(meetingsFailed ? "Calendar could not refresh. Try again." : STATE_COPY[calendarPhase(result)] || "");
  return result.status === "ready" && !meetingsFailed;
}

async function boot() {
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  mountPrefs();

  view.state = parseCalendarState(location.search, view.today);
  history.replaceState({ calendar: true }, "", calendarHref(view.state));
  wire();
  render();
  client = resolved.mode === "live" ? createLiveClient() : await (await import("./fixture-client.js")).createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  mountAutoRefresh({ document, window: globalThis.window, refresh: load });
  await load();
}

boot();

export { view };
