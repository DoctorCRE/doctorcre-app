import assert from "node:assert/strict";
import test from "node:test";
import {
  canSnoozeTo,
  monthDays,
  monthStart,
  snoozeNextWeek,
  snoozeTomorrow,
  snoozeUntil,
  weekday,
} from "../src/ui/home/snooze-times.ts";

const at = (iso: string) => new Date(iso);

test("Tomorrow is the next Central day at 8:00 AM, even late in the Central evening", () => {
  assert.equal(snoozeUntil(snoozeTomorrow(at("2026-11-26T15:00:00Z"))), "2026-11-27T14:00:00.000Z");
  assert.equal(snoozeUntil(snoozeTomorrow(at("2026-11-27T05:30:00Z"))), "2026-11-27T14:00:00.000Z");
});

test("Tomorrow across the spring-forward night returns at 8:00 AM daylight time", () => {
  assert.equal(snoozeUntil(snoozeTomorrow(at("2027-03-13T18:00:00Z"))), "2027-03-14T13:00:00.000Z");
});

test("Next week is the coming Monday at 8:00 AM Central", () => {
  assert.equal(snoozeNextWeek(at("2026-11-26T15:00:00Z")), "2026-11-30");
  assert.equal(snoozeNextWeek(at("2026-11-29T20:00:00Z")), "2026-12-07", "Sunday skips tomorrow's Monday");
  assert.equal(snoozeNextWeek(at("2026-11-30T15:00:00Z")), "2026-12-07", "Monday means the following Monday");
  assert.equal(snoozeNextWeek(at("2026-12-01T04:00:00Z")), "2026-12-07", "Monday 10 PM Central, Tuesday in UTC");
  assert.equal(snoozeUntil(snoozeNextWeek(at("2026-10-29T15:00:00Z"))), "2026-11-02T14:00:00.000Z", "after fall-back");
});

test("A day can be picked only while its 8:00 AM is still ahead", () => {
  const now = at("2026-11-26T15:00:00Z");
  assert.equal(canSnoozeTo("2026-11-25", now), false);
  assert.equal(canSnoozeTo("2026-11-26", now), false);
  assert.equal(canSnoozeTo("2026-11-26", at("2026-11-26T13:00:00Z")), true);
  assert.equal(canSnoozeTo("2026-11-27", now), true);
});

test("A month holds every day and knows the weekday of its first", () => {
  const november = monthDays(monthStart("2026-11-26"));
  assert.equal(november.length, 30);
  assert.equal(weekday(november[0] ?? ""), 0, "Nov 1, 2026 is a Sunday");
  const february = monthDays(monthStart("2026-11-26", 3));
  assert.deepEqual([february[0], february.at(-1)], ["2027-02-01", "2027-02-28"]);
  assert.equal(weekday("2027-02-01"), 1);
  assert.equal(monthStart("2026-12-31", 1), "2027-01-01");
  assert.equal(monthStart("2027-01-15", -1), "2026-12-01");
});
