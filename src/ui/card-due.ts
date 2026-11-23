const sameYearDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const otherYearDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export type CardDue = { text: string; tone: "" | "today" | "late" };

/** How a board card names its next step's due day, as of the business day `today` (both YYYY-MM-DD). */
export function cardDueLabel(day: string, today: string): CardDue {
  if (day === today) return { text: "Due today", tone: "today" };
  const format = day.slice(0, 4) === today.slice(0, 4) ? sameYearDay : otherYearDay;
  return { text: `Due ${format.format(new Date(`${day}T00:00:00Z`))}`, tone: day < today ? "late" : "" };
}
