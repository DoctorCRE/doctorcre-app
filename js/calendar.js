import { selectDocRecord, pageDocContext } from './doc-context.js';
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import {
  addDays, approach, calendarHref, calendarLayout, calendarPhase, centralMinutes, entriesByDay, entryWhen, localToday, motionDirection,
  ownerNames, parseCalendarState, readCalendar, readMeetings, recordsFor, settleOpenDay, shortDay, stepAnchor, timelineBlocks, UNDATED, visibleRange,
} from "./calendar-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** css/calendar.css uses `(width > 640px)`, the exact inverse, for the sheet beside the grid. */
const PHONE_SHEET = window.matchMedia("(width <= 640px)");

/** One place holds what this page believes. */
const view = {
  today: localToday(),
  /** `state.day` is the open day and the only thing that opens the sheet. */
  state: null,
  painted: null,
  focusEntry: null,
  /** The day holding the grid's tab stop while no day is open. */
  cursor: null,
  /** Where focus goes back to when the open day closes. */
  opener: null,
  result: { status: "loading" },
  meetings: { range: null, status: "off", entries: [], notes: [] },
  meetingSequence: 0,
  /** Chip lines a month day holds under its number, measured from the grid; "+N more" sits beside the number. */
  monthLines: 3,
  byDay: new Map(),
  /** Every late step; each sits on its own due day and today counts them all in one chip. */
  late: [],
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

const KINDS = [
  { type: "step", label: "Next step", one: "next step", many: "next steps" },
  { type: "date", label: "Critical date", one: "critical date", many: "critical dates" },
  { type: "meeting", label: "Meeting", one: "meeting", many: "meetings" },
  { type: "tour", label: "Tour", one: "tour", many: "tours" },
];
const typeLabel = entry => KINDS.find(kind => kind.type === entry.type).label;
const entryTime = entry => entry.type === "meeting" ? entryWhen(entry, view.today) : "";
const entryText = entry => [entryTime(entry), entry.label].filter(Boolean).join(" ");

/** "Deal Example lease", the template's for-line as plain text. */
function forText(entry) {
  const { word, records } = recordsFor(entry);
  return [word, records.map(record => record.name).join(", ")].filter(Boolean).join(" ");
}

function forHtml(entry) {
  const { word, records } = recordsFor(entry);
  const links = records.map(({ name, url }) => url
    ? `<a href="${escapeHtml(url)}" data-entry="${escapeHtml(entry.key)}">${escapeHtml(name)}</a>` : escapeHtml(name)).join(", ");
  return links && [word, links].filter(Boolean).join(" ");
}

/** `day` is the cell the chip sits in, so a late step listed under today opens today. */
function chipHtml(entry, { withDeal, overflow, place, day = entry.day }) {
  const near = approach(entry, view.today);
  const byline = [forText(entry), ownerNames(entry)].filter(Boolean).join(" · ");
  const text = [typeLabel(entry), entryText(entry), byline, near.label].filter(Boolean).join(" · ");
  return `<li${overflow ? ' data-overflow="true"' : ""}${place ? ` data-place="${place}"` : ""}><button class="cal-chip" type="button" data-entry="${escapeHtml(entry.key)}" data-day="${escapeHtml(day)}" data-kind="${entry.type}" data-band="${near.band}" aria-label="${escapeHtml(text)}" title="${escapeHtml(entryText(entry))}">`
    + `<span class="cal-mark" data-kind="${entry.type}" aria-hidden="true"></span>`
    + `<span class="cal-chip-label">${escapeHtml(entryText(entry))}</span>`
    + (withDeal && byline ? `<span class="cal-chip-deal">${escapeHtml(byline)}</span>` : "")
    + "</button></li>";
}

const moreHtml = (day, more, readable) => more > 0
  ? `<button class="cal-more" type="button" data-more="${day}" aria-label="${escapeHtml(`${more} more on ${readable}`)}">+${more} more</button>` : "";

/** A day's late group, which only today has, and its own items. */
const dayRows = day => ({ late: day === view.today ? view.late : [], rows: view.byDay.get(day) || [] });

const HOURS = Array.from({ length: 24 }, (_, hour) => `<li data-hour="${hour}"><span>${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}</span></li>`).join("");

/** Day view: untimed items in a band over an hour-by-hour timeline, meetings placed by start and length. */
function timelineHtml(day, rows) {
  const timed = timelineBlocks(rows);
  const blocks = timed.map(({ entry, start, end, column, columns }) =>
    chipHtml(entry, { withDeal: true, place: [start, end, column, columns].join(" ") })).join("");
  const now = day === view.today ? `<div class="cal-now" aria-hidden="true"></div>` : "";
  return `<div class="cal-timeline"><ol class="cal-hours" aria-hidden="true">${HOURS}</ol><ul class="cal-blocks">${blocks}</ul>${now}</div>`;
}

/** A month cell shows the chips that fit and "+N more"; the rest stay for the phone agenda. A week shows every chip; a day puts timed ones on its timeline. */
function dayHtml(cell) {
  const state = view.state;
  const { late, rows } = cell.inMonth ? dayRows(cell.day) : { late: [], rows: [] };
  const shape = state.view;
  const dated = [...late, ...rows.filter(entry => shape !== "day" || !entry.at || entry.all_day)];
  const selected = (state.day || view.today) === cell.day && cell.inMonth;
  const isToday = cell.day === view.today;
  const readable = formatCalendarDate(cell.day);
  const count = late.length + rows.length ? ` · ${itemCount([...late, ...rows])}` : "";
  const chips = dated.map((entry, at) => chipHtml(entry, { withDeal: shape !== "month", overflow: shape === "month" && at >= view.monthLines, day: cell.day })).join("");
  const band = dated.length ? `<ul class="cal-chips">${chips}</ul>` : "";
  return `<div class="cal-day" role="gridcell" data-day="${cell.day}" data-today="${isToday}" data-out-month="${!cell.inMonth}" data-empty="${!rows.length}" aria-selected="${selected}">`
    + `<button class="cal-day-open" type="button" data-select-day="${cell.day}" tabindex="${selected ? 0 : -1}" aria-label="${escapeHtml(`${readable}${isToday ? " · today" : ""}${count}`)}">`
    + `<span class="cal-day-weekday">${WEEKDAYS[new Date(cell.day).getUTCDay()]}</span><span class="cal-day-num">${Number(cell.day.slice(8))}</span>`
    + "</button>"
    + (shape === "month" ? moreHtml(cell.day, dated.length - view.monthLines, readable) : "")
    + band
    + (shape === "day" ? timelineHtml(cell.day, rows) : "")
    + "</div>";
}

const placeNow = () => $("calGrid").querySelector(".cal-now")?.style.setProperty("--at", String(centralMinutes(Date.now())));

/** Ends each meeting's name on the last whole line its block holds; a resize changes the hour height and the block width, so it runs again. */
function fitBlockNames(timeline) {
  const fits = [...timeline.querySelectorAll(".cal-blocks .cal-chip-label")].map(label => {
    const chip = getComputedStyle(label.parentElement);
    const room = label.parentElement.clientHeight - Number.parseFloat(chip.paddingTop) - Number.parseFloat(chip.paddingBottom);
    return [label, Math.max(1, Math.floor(room / Number.parseFloat(getComputedStyle(label).lineHeight)))];
  });
  fits.forEach(([label, lines]) => label.style.setProperty("--lines", String(lines)));
}

/**
 * Places each meeting and the now-line, ends each meeting's name on its last
 * whole line, then scrolls: a day opens at 7 AM, or two hours before now when
 * now would be off screen; a repaint of the same day keeps its scroll unless the
 * timeline changed height. Positions go through CSSOM because the Worker's CSP
 * refuses a `style` attribute in markup.
 */
function placeTimeline(grid, kept) {
  const timeline = grid.querySelector(".cal-timeline");
  if (!timeline) return;
  for (const block of timeline.querySelectorAll("[data-place]")) {
    const [start, end, column, columns] = block.dataset.place.split(" ");
    Object.entries({ start, end, col: column, cols: columns }).forEach(([name, value]) => block.style.setProperty(`--${name}`, value));
  }
  fitBlockNames(timeline);
  placeNow();
  if (kept?.height === timeline.clientHeight) { timeline.scrollTop = kept.top; return; }
  const perMinute = timeline.querySelector(".cal-hours").offsetHeight / (24 * 60);
  const now = view.state.anchor === view.today ? centralMinutes(Date.now()) : null;
  const shown = timeline.clientHeight / perMinute;
  const minute = now !== null && (now < 7 * 60 || now > 7 * 60 + shown - 60) ? Math.max(0, now - 120) : 7 * 60;
  // A quarter hour of headroom keeps the first hour's label on screen.
  timeline.scrollTop = Math.max(0, minute - 15) * perMinute;
}

function paintGrid(layout) {
  const grid = $("calGrid");
  if (!grid) return;
  const state = view.state;
  const header = state.view !== "month" ? "" : `<div class="cal-week" role="row">${WEEKDAYS.map((name) => `<div class="cal-weekday" role="columnheader">${name}</div>`).join("")}</div>`;
  const weeks = [];
  // eslint-disable-next-line no-restricted-syntax -- Calendar rendering advances seven days per iteration and will stop at layout.days.length; 0 reads.
  for (let start = 0; start < layout.days.length; start += 7) {
    const cells = layout.days.slice(start, start + 7).map(dayHtml).join("");
    weeks.push(`<div class="cal-week" role="row">${cells}</div>`);
  }
  const direction = motionDirection(view.painted, state);
  const shownDay = grid.dataset.view === "day" && grid.querySelector(".cal-day")?.dataset.day;
  const timeline = shownDay === state.anchor && state.view === "day" && grid.querySelector(".cal-timeline");
  const kept = timeline ? { top: timeline.scrollTop, height: timeline.clientHeight } : null;
  grid.dataset.view = state.view;
  grid.innerHTML = header + weeks.join("");
  placeTimeline(grid, kept);
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
  $("calPrev")?.setAttribute("aria-label", `Previous ${state.view}`);
  $("calNext")?.setAttribute("aria-label", `Next ${state.view}`);
  document.querySelectorAll("#calViewSwitch [data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
}

function paintSelection() {
  const chosen = view.state.day || view.cursor || view.today;
  const cells = [...$("calGrid").querySelectorAll(".cal-day[data-out-month='false']")];
  const selected = cells.find(cell => cell.dataset.day === chosen);
  cells.forEach(cell => {
    cell.setAttribute("aria-selected", String(cell === selected));
    cell.querySelector(".cal-day-open").tabIndex = cell === (selected || cells[0]) ? 0 : -1;
  });
  paintSheet();
}

function measureMonthLines() {
  const cell = $("calGrid").querySelector(".cal-day");
  if (!cell || view.state.view !== "month" || PHONE_SHEET.matches) return view.monthLines;
  const style = getComputedStyle(cell);
  const room = cell.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - cell.querySelector(".cal-day-open").offsetHeight;
  const line = parseFloat(style.getPropertyValue("--cal-chip")) + parseFloat(style.rowGap);
  return Math.max(1, Math.floor(room / line));
}

const sheetMode = () => !view.state.day ? "closed" : PHONE_SHEET.matches ? "modal" : "beside";

/** The sheet follows the open day and the phone query; nothing else opens, closes or swaps it. */
function paintSheet() {
  paintDayPanel(view.state.day);
  const sheet = $("dayPanel");
  const want = sheetMode();
  const shown = !sheet.open ? "closed" : sheet.matches(":modal") ? "modal" : "beside";
  if (want === shown) return;
  const focused = document.activeElement;
  if (sheet.open) sheet.close();
  if (want === "modal") sheet.showModal();
  else if (want === "beside") {
    // show() moves focus into the sheet; beside the grid, focus stays where it was so the arrows keep moving days.
    sheet.show();
    if (focused && focused !== document.body) focused.focus({ preventScroll: true });
    else document.activeElement?.blur();
  }
}

function itemCount(rows) {
  return KINDS.map(kind => {
    const count = rows.filter(entry => entry.type === kind.type).length;
    return count && `${count} ${count === 1 ? kind.one : kind.many}`;
  }).filter(Boolean).join(" · ") || "0 items";
}

/** The one entry template: what it is and whose, what to do, what it is for, and when. */
function dayList(rows) {
  return `<ol class="cal-day-entries">${rows.map(entry => {
    const near = approach(entry, view.today);
    const owner = ownerNames(entry);
    const record = forHtml(entry);
    const when = entryWhen(entry, view.today);
    const whenHtml = entry.type === "meeting" ? `<time datetime="${escapeHtml(entry.at)}">${escapeHtml(when)}</time>` : escapeHtml(when);
    return `<li class="cal-day-entry" data-focus="${entry.key === view.focusEntry}" data-band="${near.band}">
      <small><span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span> ${[typeLabel(entry), owner].filter(Boolean).join(" · ")}</small>
      <h3>${escapeHtml(entry.label)}</h3>
      ${entry.why ? `<p>${escapeHtml(entry.why)}</p>` : ""}
      ${record ? `<p class="cal-entry-for">${record}</p>` : ""}
      ${when ? `<p class="cal-entry-when">${whenHtml}</p>` : ""}</li>`;
  }).join("")}</ol>`;
}

const undatedText = count => `${count} without a date`;

function paintDayPanel(day) {
  $("dayPanelTitle").textContent = day === UNDATED ? "Without a date" : day ? formatCalendarDate(day) : "Choose a day";
  const body = $("dayPanelBody");
  const phase = calendarPhase(view.result);
  if (day === UNDATED) {
    body.innerHTML = `<ul class="cal-undated" id="calUndatedList">${(view.result.undated || []).map(entry =>
      `<li><b>${escapeHtml(entry.label)}</b> · ${forHtml(entry)} · Date unavailable</li>`).join("")}</ul>`;
    return;
  }
  const { late, rows } = dayRows(day);
  if (phase === "unauthorized" || phase === "unavailable") {
    body.textContent = "Calendar temporarily unavailable.";
  } else if (late.length || rows.length) {
    body.innerHTML = (phase === "partial" ? "<p>This day may be incomplete. Refresh to try again.</p>" : "") + (late.length
      ? `<section class="cal-day-late" aria-labelledby="calLateTitle"><h3 id="calLateTitle">Late</h3>${dayList(late)}</section>`
      : "") + (rows.length ? dayList(rows) : "");
  } else {
    body.textContent = phase === "loading" || phase === "reading" ? "Reading Calendar…"
      : !day ? "Select a day to see its items."
      : phase === "partial" ? "This day may be incomplete. Refresh to try again." : "Nothing on this day.";
  }
}

const COMING_UP_DAYS = 14;

function paintComingUp() {
  const last = addDays(view.today, COMING_UP_DAYS);
  const dates = [...view.byDay.keys()].filter(date => date > view.today && date <= last).sort().slice(0, 5);
  $("calComing").hidden = dates.length === 0;
  $("calAgenda").innerHTML = dates.map(date => {
    const items = view.byDay.get(date).map(entry => `<span class="cal-agenda-detail">
      ${escapeHtml(entryText(entry))}<small>${escapeHtml([forText(entry), ownerNames(entry)].filter(Boolean).join(" · "))}</small>
    </span>`).join("");
    return `<li><button class="cal-agenda-item" type="button" data-day="${date}">
      <time datetime="${date}">${shortDay(date, view.today)}</time>
      <span class="cal-agenda-details">${items}</span>
    </button></li>`;
  }).join("");
  const missing = view.result.undated?.length ?? 0;
  $("calUndated").hidden = missing === 0;
  $("calUndated").textContent = undatedText(missing);
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

const FOCUS_KEYS = { selectDay: "data-select-day", entry: "data-entry", more: "data-more", day: "data-day" };

/** A selector that finds the same control again after a repaint replaces it. */
function focusAddress(node) {
  if (node?.id === "calUndated") return "#calUndated";
  const scope = node?.closest?.("#calGrid, #dayPanelBody, #calAgenda");
  const keys = Object.entries(FOCUS_KEYS).filter(([key]) => node?.dataset?.[key])
    .map(([key, attribute]) => `[${attribute}="${CSS.escape(node.dataset[key])}"]`);
  return scope && keys.length ? `#${scope.id} ${node.localName}${keys.join("")}` : null;
}

function render() {
  const focused = focusAddress(document.activeElement);
  const phase = calendarPhase(view.result);
  const layout = calendarLayout(view.state);
  const shown = ["ready", "partial", "reading", "empty"].includes(phase);
  view.byDay = shown ? entriesByDay([...(view.result.entries || []), ...view.meetings.entries]) : new Map();
  view.late = shown ? (view.result.entries || []).filter(entry => entry.days_late > 0) : [];
  paintNotices(phase);
  // A late step due before the period still counts once while today's chip shows it.
  const periodRows = [...new Set(layout.days.flatMap(cell => {
    if (!cell.inMonth) return [];
    const { late, rows } = dayRows(cell.day);
    return [...late, ...rows];
  }))];
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
  paintComingUp();
  paintSelection();
  if (focused) document.querySelector(focused)?.focus({ preventScroll: true });

  const asOf = $("calAsOf");
  if (["ready", "partial"].includes(view.result.status)) asOf.textContent = updatedLabel(view.updatedAt);
  else asOf.textContent = "";
}

/* -------------------------------------------------------------- navigation */

function go(target, { push = true } = {}) {
  const before = view.state;
  const next = settleOpenDay(target);
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
  if (moved) announce(`${periodText}. ${next.view[0].toUpperCase()}${next.view.slice(1)} view.`);
}

const inPeriod = day => settleOpenDay({ ...view.state, day }).day === day;

function announceDay(day) {
  if (day === UNDATED) { announce(`${undatedText(view.result.undated?.length ?? 0)}.`); return; }
  const { late, rows } = dayRows(day);
  const incomplete = calendarPhase(view.result) === "partial" ? " This day may be incomplete." : "";
  announce(`${formatCalendarDate(day)}: ${itemCount([...late, ...rows])}.${incomplete}`);
}

/** Every control that opens a day comes here. Opening replaces history unless the period moves. */
function openDay(day, { entry = null } = {}) {
  view.opener = focusAddress(document.activeElement);
  view.focusEntry = entry;
  if (day !== UNDATED) view.cursor = day;
  const currentEntry = view.result?.entries?.find(row => row.key === entry);
  selectDocRecord(currentEntry?.deal_id ? "deal" : null, currentEntry?.deal_id);
  if (currentEntry?.deal_id) void client.getDeal(currentEntry.deal_id).catch(() => {});
  const shown = inPeriod(day);
  go({ ...view.state, day, anchor: shown ? view.state.anchor : day }, { push: !shown });
  if (entry) $("dayPanel").querySelector('[data-focus="true"] a[data-entry]')?.focus();
  announceDay(day);
}

/** Arrow keys move the grid's tab stop, turning the period when they leave it. */
function moveCursor(day) {
  view.cursor = day;
  if (inPeriod(day)) paintSelection();
  else go({ ...view.state, anchor: day });
  $("calGrid").querySelector(`.cal-day-open[data-select-day="${day}"]`)?.focus();
  announceDay(day);
}

/** Today opens the Day view of today and puts the tab stop on it without opening its sheet. */
function showToday() {
  view.opener = null;
  view.focusEntry = null;
  view.cursor = view.today;
  go({ view: "day", day: null, anchor: view.today });
  $("calGrid").querySelector(`.cal-day-open[data-select-day="${view.today}"]`)?.focus();
  announceDay(view.today);
}

/** Closing hands focus back to the control that opened the day, else to a day still shown. */
function closeDay() {
  const day = view.state.day;
  if (!day) return;
  const opener = view.opener;
  view.opener = null;
  view.focusEntry = null;
  view.cursor = null;
  go({ ...view.state, day: null }, { push: false });
  const days = [...$("calGrid").querySelectorAll(".cal-day[data-out-month='false'] .cal-day-open")].filter(button => button.checkVisibility());
  const fromOpener = opener && document.querySelector(opener);
  const target = (fromOpener?.checkVisibility() && fromOpener)
    || days.find(button => button.dataset.selectDay === day) || days.find(button => button.dataset.selectDay === view.today) || days[0];
  if (target?.matches(".cal-day-open")) {
    view.cursor = target.dataset.selectDay;
    paintSelection();
  }
  target?.focus();
}

/** Days an arrow key moves the cursor; Up and Down move a row, and a Day view row is one day. */
const arrowStep = (key, shown) => {
  const row = shown === "day" ? 1 : 7;
  return { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -row, ArrowDown: row }[key];
};

function wire() {
  $("calViewSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === view.state.view) return;
    const selected = $("calGrid")?.querySelector('[aria-selected="true"][data-out-month="false"]');
    go({ ...view.state, view: button.dataset.view, anchor: selected?.dataset.day || view.state.anchor });
  });
  $("calPrev")?.addEventListener("click", () => go(stepAnchor(view.state, -1)));
  $("calNext")?.addEventListener("click", () => go(stepAnchor(view.state, 1)));
  $("calToday")?.addEventListener("click", showToday);
  $("calUndated")?.addEventListener("click", () => openDay(UNDATED));
  // eslint-disable-next-line no-restricted-syntax -- Moves the now-line once a minute; it reads nothing.
  setInterval(placeNow, 60_000);
  $("calRefresh")?.addEventListener("click", () => load());
  const sheet = $("dayPanel");
  $("dayPanelClose")?.addEventListener("click", closeDay);
  // A phone's back gesture asks the modal sheet to close; the open day decides, so the dialog never closes itself.
  sheet.addEventListener("cancel", (event) => { event.preventDefault(); closeDay(); });
  sheet.addEventListener("click", (event) => { if (event.target === sheet) closeDay(); });
  // Escape inside the page, or with nothing focused, closes the open day and goes no further, so a menu outside it keeps its own Escape.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !view.state.day) return;
    if (event.target !== document.body && !$("main").contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeDay();
  });
  PHONE_SHEET.addEventListener("change", paintSheet);
  new ResizeObserver(() => {
    const timeline = $("calGrid").querySelector(".cal-timeline");
    if (timeline) { fitBlockNames(timeline); return; }
    const lines = measureMonthLines();
    if (lines !== view.monthLines) { view.monthLines = lines; render(); }
  }).observe($("calGrid"));
  $("calNotices")?.addEventListener("click", (event) => {
    if (event.target.closest("#calRetry")) load();
  });

  $("calGrid")?.addEventListener("click", (event) => {
    const chip = event.target.closest(".cal-chip");
    if (chip) { openDay(chip.dataset.day, { entry: chip.dataset.entry }); return; }
    const more = event.target.closest(".cal-more");
    if (more) { openDay(more.dataset.more); return; }
    const open = event.target.closest(".cal-day-open");
    if (open) openDay(open.dataset.selectDay);
  });
  $("calGrid")?.addEventListener("keydown", (event) => {
    const open = event.target.closest(".cal-day-open");
    const step = arrowStep(event.key, view.state.view);
    if (!open || !step) return;
    event.preventDefault();
    moveCursor(addDays(open.dataset.selectDay, step));
  });
  $("calAgenda")?.addEventListener("click", (event) => {
    const item = event.target.closest(".cal-agenda-item");
    if (item) openDay(item.dataset.day);
  });

  window.addEventListener("popstate", () => {
    view.state = parseCalendarState(location.search, view.today);
    view.opener = null;
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
