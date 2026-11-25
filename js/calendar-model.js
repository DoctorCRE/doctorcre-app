import { createPageBudget } from './read-budget.mjs';
import { BUSINESS_TIME_ZONE, businessDay, meetingTime } from './business-date.js';
import { partnerName } from './visual-system.js';
// Calendar days use UTC arithmetic. Today uses America/Chicago.

/** Widest to narrowest; a change toward the end zooms in. */
export const CALENDAR_VIEWS = Object.freeze(["month", "week", "day"]);
/** The sheet's target when it lists the dates that could not be read. */
export const UNDATED = "undated";
const READ_CONCURRENCY = 4;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = MONTHS.map((name) => name.slice(0, 3));
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// node-pg serialises a DATE column as midnight UTC when a view forgets the
// `to_jsonb(...)#>>'{}'` cast. Only that exact shape is accepted as a day; any
// other time of day would mean guessing which calendar day was meant.
const MIDNIGHT_PATTERN = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)$/;

const KIND_LABEL = {
  loi_expiry: "LOI expiry",
  lease_expiration: "Lease expiration",
  option_window: "Option window",
  earnout: "Earnout",
};

/* ---------------------------------------------------------------- day values */

function asUtc(day) {
  const match = DAY_PATTERN.exec(day);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function fromUtc(date) {
  return date.toISOString().slice(0, 10);
}

/** A calendar day, or null when the value is not exactly one. */
export function toDay(value) {
  if (typeof value !== "string") return null;
  const day = DAY_PATTERN.test(value) ? value : MIDNIGHT_PATTERN.exec(value)?.[1];
  if (!day) return null;
  return fromUtc(asUtc(day)) === day ? day : null;
}

/** "Oct 8", with the year only when it is not this year's; non-dates pass through. */
export function shortDay(value, today) {
  const day = toDay(value);
  if (!day) return value;
  const [year, month, date] = day.split("-");
  const label = `${SHORT_MONTHS[Number(month) - 1]} ${Number(date)}`;
  return year === String(today).slice(0, 4) ? label : `${label}, ${year}`;
}

/** Strict date-only contracts share the calendar validation without midnight coercion. */
export function isCalendarDay(value) {
  return typeof value === "string" && DAY_PATTERN.test(value) && toDay(value) === value;
}

export const localToday = businessDay;

export function addDays(day, count) {
  const date = asUtc(day);
  date.setUTCDate(date.getUTCDate() + count);
  return fromUtc(date);
}

/** A month step that keeps the day of the month, clamped to the month's end. */
export function addMonths(day, count) {
  const date = asUtc(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return fromUtc(target);
}

export function daysBetween(from, to) {
  return Math.round((asUtc(to) - asUtc(from)) / 86_400_000);
}

function startOfWeek(day) {
  return addDays(day, -asUtc(day).getUTCDay());
}

function shortDate(day) {
  const date = asUtc(day);
  return `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** The Sunday-first weeks that hold a day of the anchor's month: four to six. */
export function monthGrid(anchor) {
  const date = asUtc(anchor);
  const first = fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  const start = startOfWeek(first);
  const month = date.getUTCMonth();
  const monthDays = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const weeks = Math.ceil((asUtc(first).getUTCDay() + monthDays) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, index) => {
    const day = addDays(start, index);
    return { day, inMonth: asUtc(day).getUTCMonth() === month };
  });
  return { title: `${MONTHS[month]} ${date.getUTCFullYear()}`, days };
}

/** The anchor's Sunday-first week. */
export function weekStrip(anchor) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, index) => ({ day: addDays(start, index), inMonth: true }));
  const end = days[6].day;
  const [startYear, endYear] = [start.slice(0, 4), end.slice(0, 4)];
  let title;
  if (startYear !== endYear) title = `${shortDate(start)}, ${startYear} – ${shortDate(end)}, ${endYear}`;
  else if (start.slice(5, 7) !== end.slice(5, 7)) title = `${shortDate(start)} – ${shortDate(end)}, ${endYear}`;
  else title = `${shortDate(start)} – ${asUtc(end).getUTCDate()}, ${endYear}`;
  return { title, days };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The anchor alone. */
function dayStrip(anchor) {
  const date = asUtc(anchor);
  return { title: `${WEEKDAY_NAMES[date.getUTCDay()]}, ${shortDate(anchor)}, ${date.getUTCFullYear()}`, days: [{ day: anchor, inMonth: true }] };
}

/* ---------------------------------------------------------------- URL memory */

/** The view the address names; anything unrecognised falls back, never errors. */
export function parseCalendarState(search, today) {
  const params = new URLSearchParams(search || "");
  const view = CALENDAR_VIEWS.includes(params.get("view")) ? params.get("view") : "month";
  const day = params.get("day") === UNDATED ? UNDATED : toDay(params.get("day"));
  const anchor = toDay(params.get("d")) || toDay(day) || today;
  return settleOpenDay({ view, anchor, day });
}

/** The days a state shows. */
export function calendarLayout({ view, anchor }) {
  switch (view) {
    case "day": return dayStrip(anchor);
    case "week": return weekStrip(anchor);
    default: return monthGrid(anchor);
  }
}

/** A move that leaves the open day outside the shown period closes it, so the sheet never shows a day the grid does not. */
export function settleOpenDay(state) {
  const shown = calendarLayout(state).days.some(cell => cell.inMonth && cell.day === state.day);
  return state.day && state.day !== UNDATED && !shown ? { ...state, day: null } : state;
}

export function calendarHref(state) {
  const params = new URLSearchParams({ view: state.view, d: state.anchor });
  if (state.day) params.set("day", state.day);
  return `/calendar?${params}`;
}

/** One period forward (1) or back (-1). */
export function stepAnchor(state, direction) {
  const anchor = state.view === "month" ? addMonths(state.anchor, direction)
    : addDays(state.anchor, (state.view === "week" ? 7 : 1) * direction);
  return { ...state, anchor };
}

/** Which way the grid should move when the view changes from `before` to `after`. */
export function motionDirection(before, after) {
  if (!before) return "enter";
  if (before.view !== after.view) return CALENDAR_VIEWS.indexOf(after.view) > CALENDAR_VIEWS.indexOf(before.view) ? "zoom-in" : "zoom-out";
  if (before.anchor === after.anchor) return "none";
  return after.anchor > before.anchor ? "forward" : "back";
}

/* ------------------------------------------------------------------- motion */

/**
 * How near a date is, and the marker that says so. The marker is a still
 * shape: a double ring for today and anything overdue (urgent), a ringed dot
 * for this week (attention), a dot for the rest of the month (calm), and a
 * hollow ring for anything further out or settled (still).
 */
export function approach(entry, today) {
  const days = daysBetween(today, entry.day);
  const label = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday"
    : days > 0 ? `in ${days} days` : `${-days} days ago`;
  // A meeting or tour on a past day happened or did not; either way it is not overdue.
  if (entry.settled || (days < 0 && (entry.type === "meeting" || entry.type === "tour"))) return { band: "settled", days, pulse: "still", label };
  if (days < 0) return { band: "overdue", days, pulse: "urgent", label };
  if (days === 0) return { band: "today", days, pulse: "urgent", label };
  if (days <= 7) return { band: "soon", days, pulse: "attention", label };
  if (days <= 30) return { band: "near", days, pulse: "calm", label };
  return { band: "later", days, pulse: "still", label };
}

/* ---------------------------------------------------------------- entries */

function words(slug) {
  const text = String(slug).replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function kindLabel(kind) {
  if (!kind) return null;
  return KIND_LABEL[kind] || words(kind);
}

/**
 * One deal's critical_date rows as calendar entries. The adapters may add a
 * label/date pair. A missing status stays unknown.
 */
export function criticalDateEntries(deal, detail) {
  const entries = [];
  const undated = [];
  (detail?.critical_dates || []).forEach((row, index) => {
    const kind = typeof row?.kind === "string" && row.kind ? row.kind : null;
    const rawLabel = row?.label || row?.note || kind;
    const label = rawLabel && rawLabel === kind ? kindLabel(kind) : (rawLabel || "Critical date");
    const status = typeof row?.status === "string" && row.status ? row.status : null;
    const entry = {
      key: row?.id ? String(row.id) : `${deal.id}:${index}`,
      deal_id: deal.id,
      deal_name: deal.name || "Unnamed deal",
      day: toDay(row?.due_on ?? row?.date ?? null),
      label,
      kind,
      kind_label: kindLabel(kind),
      source: typeof row?.source === "string" && row.source ? row.source : null,
      status,
      settled: status !== null && status !== "open",
    };
    (entry.day ? entries : undated).push(entry);
  });
  return { entries, undated };
}

/** Open before settled, then by label, within each day. */
export function entriesByDay(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.day)) map.set(entry.day, []);
    map.get(entry.day).push(entry);
  }
  for (const rows of map.values()) {
    // Meetings come first, in the order they start.
    rows.sort((a, b) => Number(a.settled) - Number(b.settled) || Number(!a.at) - Number(!b.at)
      || (a.at ?? "").localeCompare(b.at ?? "")
      || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  }
  return map;
}

/* ---------------------------------------------------------------- timeline */

const CENTRAL_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, hour: "numeric", minute: "numeric", hourCycle: "h23" });
const DAY_MINUTES = 24 * 60;
// The shortest slot Outlook offers; a shorter meeting, or one without a readable end, takes it so its name fits.
const SHORTEST_MINUTES = 30;

/** Minutes past Central midnight. */
export function centralMinutes(instant) {
  const parts = Object.fromEntries(CENTRAL_CLOCK.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * A day's timed meetings as blocks: start and end in minutes past Central
 * midnight, and the column of `columns` each takes so overlapping ones sit
 * side by side. A meeting that runs past midnight ends at midnight.
 */
export function timelineBlocks(entries) {
  const blocks = entries.filter(entry => entry.at && !entry.all_day).map(entry => {
    const start = centralMinutes(entry.at);
    const length = entry.end ? Math.round((Date.parse(entry.end) - Date.parse(entry.at)) / 60_000) : 0;
    return { entry, start, end: Math.min(DAY_MINUTES, start + Math.max(length, SHORTEST_MINUTES)), column: 0, columns: 1 };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let clusterEnd = -1;
  const settle = () => { for (const block of cluster) block.columns = Math.max(...cluster.map(other => other.column)) + 1; };
  for (const block of blocks) {
    if (block.start >= clusterEnd) { settle(); cluster = []; }
    const taken = new Set(cluster.filter(other => other.end > block.start).map(other => other.column));
    block.column = Array.from({ length: cluster.length + 1 }, (_, column) => column).find(column => !taken.has(column));
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  settle();
  return blocks;
}

/* ------------------------------------------------------------------- the read */

const endedSession = (error) => error?.status === 401 || error?.status === 403;

export async function readCalendar(client, { concurrency = READ_CONCURRENCY, onProgress } = {}) {
  const empty = { entries: [], undated: [], failed: [], dealCount: 0, readCount: 0 };
  if (client.getCalendarItems) {
    try {
      const { critical_dates, next_steps = [] } = await client.getCalendarItems();
      const entries = critical_dates.map(row => {
        const day = toDay(row.due_on);
        if (!day || !row.id || !row.deal_id || typeof row.deal_name !== "string" ||
            typeof row.kind !== "string" || typeof row.done !== "boolean")
          throw new Error("Calendar date unreadable");
        return {
          key: row.id, deal_id: row.deal_id, deal_name: row.deal_name, day,
          label: row.kind, owner: row.owner, type: "date", settled: row.done,
        };
      });
      entries.push(...next_steps.map(row => {
        if (!isCalendarDay(row.due_on) || !row.id ||
            typeof row.what !== "string" || typeof row.record_label !== "string" || typeof row.owner !== "string" ||
            !Number.isInteger(row.days_late) || row.days_late < 0 ||
            !(row.open_url === null || (typeof row.open_url === "string" && /^\/(?:deals|relationships)\?/.test(row.open_url))))
          throw new Error("Calendar step unreadable");
        const label = row.what.trim().replace(/\s+/g, " ");
        const why = typeof row.why === "string" ? row.why.trim().replace(/\s+/g, " ") : "";
        return {
          key: `step:${row.id}`, type: "step", day: row.due_on, label,
          why,
          owner: row.owner, record_name: row.record_label, open_url: row.open_url,
          days_late: row.days_late, settled: false,
        };
      }));
      return { ...empty, status: "ready", entries };
    } catch (error) {
      if (error?.status !== 404) return { ...empty, status: endedSession(error) ? "unauthorized" : "unavailable" };
    }
  }
  let board;
  try {
    board = await client.getBoard({ workspace: "all" });
  } catch (error) {
    return { ...empty, status: endedSession(error) ? "unauthorized" : "unavailable" };
  }
  if (!Array.isArray(board?.deals)) return { ...empty, status: "unavailable" };

  const deals = board.deals.filter((deal) => deal && typeof deal.id === "string");
  const entries = [];
  const undated = [];
  const failed = [];
  let readCount = 0;
  let signedOut = false;
  let next = 0;

  const takePage = createPageBudget();
  async function worker() {
    // eslint-disable-next-line no-restricted-syntax -- Workers share a max of 100 pages; takePage consumes the budget before each deal read.
    while (!signedOut && next < deals.length) {
      try { takePage(); }
      catch {
        failed.push(...deals.slice(next).map(deal => ({ deal_id: deal.id, deal_name: deal.name || 'Unnamed deal' })));
        next = deals.length;
        return;
      }
      const deal = deals[next++];
      try {
        const detail = await client.getDeal(deal.id);
        if (!Array.isArray(detail?.critical_dates)) throw new Error("critical_dates unreadable");
        const read = criticalDateEntries(deal, {
          critical_dates: detail.critical_dates.filter(row => row?.status === "open"),
        });
        const asDate = row => ({ ...row, owner: deal.owner, type: "date" });
        entries.push(...read.entries.map(asDate));
        undated.push(...read.undated.map(asDate));
        readCount += 1;
      } catch (error) {
        if (endedSession(error)) {
          signedOut = true;
          onProgress?.({ ...empty, status: "unauthorized" });
          return;
        }
        failed.push({ deal_id: deal.id, deal_name: deal.name || "Unnamed deal" });
      }
      if (!signedOut) onProgress?.({
        status: "reading", entries: [...entries], undated: [...undated], failed: [...failed],
        dealCount: deals.length, readCount, actor: board.actor || null,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, deals.length)) }, worker));
  if (signedOut) return { ...empty, status: "unauthorized" };
  failed.sort((a, b) => a.deal_name.localeCompare(b.deal_name));
  return { status: "ready", entries, undated, failed, dealCount: deals.length, readCount, actor: board.actor || null };
}

/** The one state the page shows. */
export function calendarPhase(result) {
  if (!result || result.status === "loading") return "loading";
  if (result.status === "unauthorized") return "unauthorized";
  if (result.status === "reading") return "reading";
  if (result.status !== "ready") return "unavailable";
  if (result.failed.length > 0) return "partial";
  if (result.entries.length === 0 && result.undated.length === 0) return "empty";
  return "ready";
}

/* ---------------------------------------------------------------- meetings */

const isInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const isText = value => typeof value === "string" && value.trim() !== "";
const recordUrl = value => typeof value === "string" && /^\/(?:deals|relationships)\?/.test(value) ? value : null;
const SECTION_STATES = ["ready", "empty", "partial", "unavailable"];
// The engine's freshness rule for an Outlook snapshot.
const STALE_MS = 18 * 3_600_000;
const named = (who, text) => text.startsWith(who) ? text : `${who}: ${text}`;
const UNLOADED = { status: "unavailable", entries: [], notes: ["Meetings could not be loaded. Refresh to try again."] };

/** The visible period as the meetings read's inclusive range. */
export const visibleRange = days => ({ from: days[0].day, to: days.at(-1).day });

/** The Outlook job attaches standing caveats to every snapshot; like Home, only a stale sync is worth a line. */
function sectionNotes(section, who, now) {
  if (section.state === "unavailable") return [section.reason || `${who}'s meetings could not be loaded.`];
  const synced = isInstant(section.observed_at) ? Date.parse(section.observed_at) : null;
  return [
    ...(synced !== null && now - synced > STALE_MS
      ? [`Last synced ${meetingTime(section.observed_at, BUSINESS_TIME_ZONE, { date: true })}.`] : []),
    ...(section.meetings_may_be_missing === true ? ["Calendar may be incomplete."] : []),
  ];
}

function dealLinks(item) {
  const matches = Array.isArray(item.possible_deals) ? item.possible_deals : [];
  const links = matches.flatMap(deal => isText(deal?.name) && recordUrl(deal.open_url) ? [{ name: deal.name, url: deal.open_url }] : []);
  if (links.length) return links;
  return isText(item.context_label) ? [{ name: item.context_label, url: recordUrl(item.open_url) }] : [];
}

/**
 * Both partners' meetings and planned tours for one period, as calendar
 * entries plus the plain notes that say what may be missing. `off` means the
 * engine does not serve the read, so the page says nothing about meetings.
 * A meeting both partners attend is one entry owned by both.
 */
export async function readMeetings(client, range, now = Date.now()) {
  if (!client.getCalendarMeetings) return { status: "off", entries: [], notes: [] };
  let answer;
  try {
    answer = await client.getCalendarMeetings(range);
  } catch (error) {
    return error?.status === 404 ? { status: "off", entries: [], notes: [] } : UNLOADED;
  }
  try {
    const notes = [];
    const meetings = new Map();
    for (const section of answer.meetings) {
      if (!isText(section.partner) || !isText(section.name) || !SECTION_STATES.includes(section.state) || !Array.isArray(section.items))
        throw new Error("Meetings unreadable");
      const who = partnerName(section.name);
      notes.push(...sectionNotes(section, who, now).map(note => named(who, note)));
      if (section.state === "unavailable") continue;
      for (const item of section.items) {
        if (!isText(item?.title) || !isInstant(item.start)) throw new Error("Meeting unreadable");
        const start = new Date(item.start);
        const label = item.title.trim().replace(/\s+/g, " ");
        // The Outlook job's key is the same for every attendee's copy of a meeting.
        const key = `meeting:${isText(item.key) ? item.key : `${start.toISOString()}:${label.toLowerCase()}`}`;
        const known = meetings.get(key);
        if (known) { if (!known.owners.includes(section.partner)) known.owners.push(section.partner); continue; }
        const links = dealLinks(item);
        meetings.set(key, {
          key, type: "meeting", day: businessDay(start), at: start.toISOString(), all_day: item.all_day === true,
          end: isInstant(item.end) ? new Date(item.end).toISOString() : null,
          label, owners: [section.partner], links, record_name: links.map(link => link.name).join(", ") || null, settled: false,
        });
      }
    }
    const tours = answer.tours;
    if (!SECTION_STATES.includes(tours?.state) || !Array.isArray(tours.items)) throw new Error("Tours unreadable");
    if (tours.state === "unavailable") notes.push(tours.reason || "Planned tours could not be loaded.");
    const planned = tours.state === "unavailable" ? [] : tours.items.map(tour => {
      if (!tour?.id || !isCalendarDay(tour.planned_on) || !isText(tour.deal_name) || !Number.isInteger(tour.stop_count))
        throw new Error("Tour unreadable");
      return {
        key: `tour:${tour.id}`, type: "tour", day: tour.planned_on,
        label: `${tour.stop_count} ${tour.stop_count === 1 ? "stop" : "stops"}`, owners: [tour.owner],
        links: [{ name: tour.deal_name, url: recordUrl(tour.open_url) }], record_name: tour.deal_name, settled: false,
      };
    });
    return { status: notes.length ? "partial" : "ready", entries: [...meetings.values(), ...planned], notes: [...new Set(notes)] };
  } catch {
    return UNLOADED;
  }
}
