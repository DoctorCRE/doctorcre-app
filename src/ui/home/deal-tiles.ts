const DAY_MS = 86_400_000;
const isDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const addDays = (day: string, days: number) => new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

export type CriticalDate = Readonly<{ id: string; dealId: string; dealName: string; kind: string; day: string }>;

/** Open dates from the Calendar's critical-dates read; anything malformed refuses the whole read. */
export function parseCriticalDates(answer: unknown): CriticalDate[] {
  if (
    !record(answer) ||
    answer.schema_version !== "calendar-critical-dates.v1" ||
    !Array.isArray(answer.critical_dates)
  )
    throw Error("Coming up unavailable");
  return answer.critical_dates.flatMap((row: unknown) => {
    if (
      !record(row) ||
      !text(row.id) ||
      !text(row.deal_id) ||
      !text(row.deal_name) ||
      !text(row.kind) ||
      !isDay(row.due_on) ||
      typeof row.done !== "boolean"
    )
      throw Error("Coming up unavailable");
    return row.done
      ? []
      : [{ id: row.id, dealId: row.deal_id, dealName: row.deal_name, kind: row.kind, day: row.due_on }];
  });
}

/** Dates from `today` through 14 days later, both included, soonest first. */
export function comingUp(dates: readonly CriticalDate[], today: string): CriticalDate[] {
  const last = addDays(today, 14);
  return dates
    .filter(({ day }) => day >= today && day <= last)
    .sort((a, b) => a.day.localeCompare(b.day) || a.dealName.localeCompare(b.dealName));
}

/** The Monday that starts the review week holding `today`. */
export function reviewWeek(today: string) {
  return addDays(today, -((new Date(Date.parse(today)).getUTCDay() + 6) % 7));
}

/** "31 of 47": how many of this week's review items carry a mark. */
export function reviewProgress(answer: unknown) {
  if (!record(answer) || !Array.isArray(answer.items) || !answer.items.every(record))
    throw Error("Monday review unavailable");
  return { reviewed: answer.items.filter((item) => record(item.reviewed)).length, total: answer.items.length };
}

type BoardDeal = { id: string; name: unknown; attention?: unknown };
/** The Deals board's own rules, which Home loads from the board's modules at run time. */
export type BoardRules = {
  localDeals: (deals: unknown[]) => BoardDeal[];
  groupByColumn: (deals: BoardDeal[]) => { columns: { slug: string; label: string; deals: BoardDeal[] }[] };
  attentionReasons: (deal: BoardDeal, today: string) => string[];
  missingNextStep: (deal: BoardDeal) => boolean;
  dealName: (name: unknown) => string;
};

/** Local Deals' open deals: per phase, needing attention by name and reason, and missing a next step. */
export function dealsAtAGlance(board: unknown, today: string, rules: BoardRules) {
  if (!record(board) || !Array.isArray(board.deals)) throw Error("Deals unavailable");
  const { columns } = rules.groupByColumn(rules.localDeals(board.deals));
  const open = columns.flatMap((column) => column.deals);
  return {
    open: open.length,
    phases: columns.map(({ slug, label, deals }) => ({ slug, label, count: deals.length })),
    attention: open.flatMap((deal) => {
      const reasons = rules.attentionReasons(deal, today);
      const flagged = deal.attention === true;
      const late = reasons.length > Number(flagged);
      return reasons.length
        ? [{ id: deal.id, name: rules.dealName(deal.name), reason: reasons.join(". "), flagged, late }]
        : [];
    }),
    missingNextStep: open.filter(rules.missingNextStep).length,
  };
}
