export type Zoom = "day" | "week" | "month";

export const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
export const DAY_WIDTH: Record<Zoom, number> = { day: 28, week: 12, month: 4 };
export const MIN_BAR_WIDTH = 10;

const MS_PER_DAY = 86_400_000;
// A bar's name has this much padding either side, and its metadata one gap and a right pad.
const NAME_PAD = 16;
const META_PAD = 16;
const ARROW_CORNER = 5;
const ARROW_EXIT = 10;
const ARROW_ENTRY = 14;
const ARROW_TIP_INSET = 1.5;
const ARROW_HEAD_DEPTH = 4.5;
const ARROW_HEAD_WING = 4;

// A day is a whole number of days since 1970-01-01, so its place on the chart is plain arithmetic.
export function dayOf(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== iso)
    throw new RangeError(`Not a calendar day: ${iso}`);
  return ms / MS_PER_DAY;
}

const dateOf = (day: number) => new Date(day * MS_PER_DAY);
const label = (day: number, options: Intl.DateTimeFormatOptions) =>
  dateOf(day).toLocaleDateString("en-US", { timeZone: "UTC", ...options });

export const yearOf = (day: number) => dateOf(day).getUTCFullYear();

export function shortDate(day: number, refYear: number): string {
  return label(day, { month: "short", day: "numeric", ...(yearOf(day) !== refYear && { year: "numeric" }) });
}

export function weekdayDate(day: number, refYear: number): string {
  return label(day, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(yearOf(day) !== refYear && { year: "numeric" }),
  });
}

interface Tick {
  day: number;
  label: string;
}

export interface Scale {
  months: Tick[];
  days: Tick[];
  saturdays: number[];
}

const daysLeftInMonth = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() - date.getUTCDate() + 1;

// The header's month names and day numbers, and the weekends to shade, for the days from..to.
// A month that starts too close to the left edge to fit its name gets no name there, and Month
// zoom leaves weekends unshaded because a 4px day would turn them into stripes.
export function scale(from: number, to: number, zoom: Zoom): Scale {
  const months: Tick[] = [];
  const days: Tick[] = [];
  const saturdays: number[] = [];
  for (const d of Array.from({ length: to - from }, (_, i) => from + i)) {
    const date = dateOf(d);
    const weekday = date.getUTCDay();
    const dayOfMonth = date.getUTCDate();
    if (zoom !== "month" && (weekday === 6 || (d === from && weekday === 0))) saturdays.push(weekday === 6 ? d : d - 1);
    if (dayOfMonth === 1 || (d === from && daysLeftInMonth(date) >= 21)) {
      const withYear = zoom === "month" || months.length === 0 || date.getUTCMonth() === 0;
      months.push({
        day: d,
        label: label(d, { month: zoom === "month" ? "short" : "long", ...(withYear && { year: "numeric" }) }),
      });
    }
    const tick = zoom === "day" || (zoom === "week" ? weekday === 1 : dayOfMonth === 15);
    if (tick) days.push({ day: d, label: String(dayOfMonth) });
  }
  return { months, days, saturdays };
}

export function spanBox(startDay: number, endDay: number, origin: number, px: number) {
  return {
    left: (startDay - origin) * px,
    width: Math.max((endDay - startDay) * px, MIN_BAR_WIDTH),
  };
}

// Spent fill stops on today's midpoint so it aligns with the Today vertical line.
export function spentWidth(startDay: number, barWidth: number, today: number, px: number): number {
  return Math.max(0, Math.min(barWidth, (today - startDay + 0.5) * px));
}

// A name goes inside its bar only when the whole measured text fits; otherwise it goes beside the bar.
// Metadata shows only when it fits as well, after the name.
export function labelLayout(nameWidth: number, metaWidth: number, barWidth: number) {
  const nameFits = nameWidth + NAME_PAD <= barWidth;
  return {
    outside: !nameFits,
    showMeta: nameFits && metaWidth > 0 && nameWidth + NAME_PAD + metaWidth + META_PAD <= barWidth,
  };
}

export interface Point {
  x: number;
  y: number;
}

export interface ArrowRoute {
  path: string;
  backRoute: boolean;
}

// Right-angle route with rounded corners and an open arrowhead; routes back along the row divider when
// the target starts left of (or too close to) the drop column.
export function arrowPath(from: Point, to: Point, rowHeight: number): ArrowRoute {
  const tx = to.x - ARROW_TIP_INSET;
  const head = `M${tx - ARROW_HEAD_DEPTH} ${to.y - ARROW_HEAD_WING}L${tx} ${to.y}L${tx - ARROW_HEAD_DEPTH} ${to.y + ARROW_HEAD_WING}`;
  const dy = to.y - from.y;
  if (Math.abs(dy) < 1 && to.x >= from.x + ARROW_HEAD_DEPTH + ARROW_TIP_INSET) {
    return { path: `M${from.x} ${from.y}H${tx}${head}`, backRoute: false };
  }
  const s = dy < 0 ? -1 : 1;
  const mx = from.x + ARROW_EXIT;
  if (Math.abs(dy) >= 1 && to.x >= mx + ARROW_CORNER + 5) {
    const r = Math.min(ARROW_CORNER, Math.abs(dy) / 2);
    const body = `M${from.x} ${from.y}H${mx - r}Q${mx} ${from.y} ${mx} ${from.y + r * s}V${to.y - r * s}Q${mx} ${to.y} ${mx + r} ${to.y}H${tx}`;
    return { path: `${body}${head}`, backRoute: false };
  }
  const gy = from.y + (s * rowHeight) / 2;
  const nx = Math.min(to.x - ARROW_ENTRY, mx - 2 * ARROW_CORNER);
  const rv = Math.min(ARROW_CORNER, Math.abs(gy - from.y) / 2, Math.abs(to.y - gy) / 2 || ARROW_CORNER);
  const body =
    `M${from.x} ${from.y}H${mx - rv}Q${mx} ${from.y} ${mx} ${from.y + rv * s}` +
    `V${gy - rv * s}Q${mx} ${gy} ${mx - rv} ${gy}` +
    `H${nx + rv}Q${nx} ${gy} ${nx} ${gy + rv * s}` +
    `V${to.y - rv * s}Q${nx} ${to.y} ${nx + rv} ${to.y}H${tx}`;
  return { path: `${body}${head}`, backRoute: true };
}
