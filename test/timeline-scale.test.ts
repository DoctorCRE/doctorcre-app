import assert from "node:assert/strict";
import test from "node:test";
import { dayOf, scale } from "../src/ui/timeline-scale.ts";

const weekday = (day: number) => new Date(day * 86_400_000).getUTCDay();

test("week zoom names each month once, with the year on the first and on January, and ticks Mondays", () => {
  const { months, days } = scale(dayOf("2026-11-10"), dayOf("2027-02-01"), "week");
  assert.deepEqual(
    months.map((m) => m.label),
    ["November 2026", "December", "January 2027"],
  );
  assert.deepEqual(
    days.slice(0, 3).map((d) => d.label),
    ["16", "23", "30"],
  );
  assert.ok(days.every((d) => weekday(d.day) === 1));
});

test("a month that starts too near the left edge gets no name there", () => {
  const { months } = scale(dayOf("2026-09-28"), dayOf("2026-12-01"), "month");
  assert.deepEqual(
    months.map((m) => m.label),
    ["Oct 2026", "Nov 2026"],
  );
});

test("weekends are shaded from Saturday, including one cut off at the left edge, but not at Month zoom", () => {
  const { saturdays } = scale(dayOf("2026-11-29"), dayOf("2026-12-14"), "day");
  assert.deepEqual(saturdays, [dayOf("2026-11-28"), dayOf("2026-12-05"), dayOf("2026-12-12")]);
  assert.deepEqual(scale(dayOf("2026-11-29"), dayOf("2026-12-14"), "month").saturdays, []);
});

test("a day that is not a calendar day is refused", () => {
  assert.throws(() => dayOf("2026-02-30"), RangeError);
  assert.throws(() => dayOf("Nov 25"), RangeError);
});
