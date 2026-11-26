import assert from "node:assert/strict";
import test from "node:test";
import { ended, type Meeting, meetingRows, nextChange, nowLine } from "../src/ui/home/today-lines.ts";

const today = "2026-11-03";
const meeting = (key: string, start: string, end: string, extra: Partial<Meeting> = {}): Meeting => ({
  key,
  title: `Meeting ${key}`,
  start: `${today}T${start}:00-06:00`,
  end: `${today}T${end}:00-06:00`,
  ...extra,
});
const at = (time: string) => Date.parse(`${today}T${time}:00-06:00`);
const ids = (rows: { id: string }[]) => rows.map(({ id }) => id);

test("Today's meetings run in time order with all-day ones first and other days left out", () => {
  const rows = meetingRows(
    {
      items: [
        meeting("c", "14:00", "15:00"),
        meeting("a", "09:00", "09:45"),
        meeting("d", "00:00", "23:59", { all_day: true }),
        { ...meeting("x", "09:00", "10:00"), start: "2026-11-04T09:00:00-06:00", end: "2026-11-04T10:00:00-06:00" },
      ],
      reviews: [],
    },
    today,
    0,
    [],
  );
  assert.deepEqual(ids(rows), ["d", "a", "c"]);
});

test("The current-time line sits before the first meeting that has not started", () => {
  const rows = meetingRows(
    {
      items: [meeting("a", "09:00", "09:45"), meeting("b", "11:30", "12:00"), meeting("c", "14:00", "15:00")],
      reviews: [],
    },
    today,
    0,
    [],
  );
  assert.equal(nowLine(rows, at("08:00")), 0);
  assert.equal(nowLine(rows, at("11:45")), 2, "a meeting in progress stays above the line");
  assert.equal(nowLine(rows, at("16:00")), 3);
  assert.equal(nextChange(rows, at("09:10")), at("09:45"));
});

test("A meeting is ended once its end passes, and an all-day one never is", () => {
  assert.equal(ended(meeting("a", "09:00", "09:45"), at("09:44")), false);
  assert.equal(ended(meeting("a", "09:00", "09:45"), at("09:45")), true);
  assert.equal(ended(meeting("d", "00:00", "01:00", { all_day: true }), at("16:00")), false);
});

test("A review with no calendar row shows, and an answered meeting stays after Outlook drops it", () => {
  const review = { ...meeting("r", "08:00", "08:30"), key: "r" };
  const first = meetingRows({ items: [meeting("a", "09:00", "09:45")], reviews: [review] }, today, 0, []);
  assert.deepEqual(ids(first), ["r", "a"]);
  const listed = meetingRows({ items: [meeting("r", "08:00", "08:30")], reviews: [] }, today, 1, first);
  assert.deepEqual(ids(listed), ["r"], "the review's row stays while the calendar still lists it");
  const dropped = meetingRows({ items: [], reviews: [] }, today, 2, listed);
  assert.deepEqual(ids(dropped), ["r"], "the answered meeting stays through the day");
  assert.deepEqual(ids(meetingRows({ items: [], reviews: [] }, "2026-11-04", 3, dropped)), []);
});
