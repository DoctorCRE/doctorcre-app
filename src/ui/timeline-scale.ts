export type Zoom = "day" | "week" | "month";

export const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
export const DAY_WIDTH: Record<Zoom, number> = { day: 28, week: 12, month: 4 };

const MS_PER_DAY = 86_400_000;

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
