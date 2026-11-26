import assert from "node:assert/strict";
import test from "node:test";
import {
  arrowPath,
  dayOf,
  labelLayout,
  MIN_BAR_WIDTH,
  scale,
  shortDate,
  spanBox,
  spentWidth,
  weekdayDate,
  yearOf,
} from "../src/ui/timeline-scale.ts";

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

test("spanBox places a bar on its days and enforces the minimum visible width", () => {
  const origin = dayOf("2026-11-01");
  assert.deepEqual(spanBox(dayOf("2026-11-10"), dayOf("2026-11-16"), origin, 12), { left: 108, width: 72 });
  assert.deepEqual(spanBox(dayOf("2026-11-10"), dayOf("2026-11-10"), origin, 12), { left: 108, width: MIN_BAR_WIDTH });
});

test("spentWidth stops on today's midpoint and clamps for past and future spans", () => {
  const today = dayOf("2026-11-25");
  assert.equal(spentWidth(dayOf("2026-11-16"), 252, today, 12), 114);
  assert.equal(spentWidth(dayOf("2026-11-01"), 120, today, 12), 120);
  assert.equal(spentWidth(dayOf("2026-12-01"), 120, today, 12), 0);
});

test("labelLayout keeps a name inside only when the whole text fits, and shows metadata only when it fits after the name", () => {
  assert.deepEqual(labelLayout(90, 0, 84), { outside: true, showMeta: false });
  assert.deepEqual(labelLayout(108, 0, 120), { outside: true, showMeta: false });
  assert.deepEqual(labelLayout(108, 0, 124), { outside: false, showMeta: false });
  assert.deepEqual(labelLayout(100, 60, 180), { outside: false, showMeta: false });
  assert.deepEqual(labelLayout(100, 60, 192), { outside: false, showMeta: true });
  assert.deepEqual(labelLayout(100, 60, 100), { outside: true, showMeta: false });
});

test("arrowPath draws a forward right-angle route with rounded corners and an open head", () => {
  const forward = arrowPath({ x: 100, y: 17 }, { x: 160, y: 51 }, 34);
  assert.equal(forward.backRoute, false);
  assert.match(forward.path, /^M100 17H105Q110 17 110 22V46Q110 51 115 51H158\.5M154 47L158\.5 51L154 55$/);
});

test("arrowPath uses a back route when the target starts at or left of the drop column", () => {
  const sameX = arrowPath({ x: 200, y: 51 }, { x: 200, y: 85 }, 34);
  assert.equal(sameX.backRoute, true);
  assert.match(sameX.path, /^M200 51H205Q210 51 210 56V63Q210 68 205 68H191Q186 68 186 73V80Q186 85 191 85H198\.5/);
  assert.ok(sameX.path.endsWith("M194 81L198.5 85L194 89"));

  const atRisk = arrowPath({ x: 300, y: 51 }, { x: 240, y: 119 }, 34);
  assert.equal(atRisk.backRoute, true);
  assert.ok(atRisk.path.includes("H231Q226 68 226 73"), "travels left along the row divider to enter from the left");
  assert.ok(atRisk.path.endsWith("M234 115L238.5 119L234 123"));

  const tight = arrowPath({ x: 100, y: 17 }, { x: 118, y: 51 }, 34);
  assert.equal(tight.backRoute, true);
  assert.ok(tight.path.includes("H105Q100 34"), "keeps a non-inverted back-leg when target is just past exit");
});

test("shortDate and weekdayDate format calendar days in plain words and include the year only when it differs", () => {
  const ref = yearOf(dayOf("2026-11-25"));
  assert.equal(shortDate(dayOf("2026-12-07"), ref), "Dec 7");
  assert.equal(shortDate(dayOf("2027-03-06"), ref), "Mar 6, 2027");
  assert.equal(weekdayDate(dayOf("2026-12-03"), ref), "Thu, Dec 3");
  assert.equal(weekdayDate(dayOf("2027-03-22"), ref), "Mon, Mar 22, 2027");
});
