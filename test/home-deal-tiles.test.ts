import assert from "node:assert/strict";
import test from "node:test";
import {
  type BoardRules,
  comingUp,
  dealsAtAGlance,
  parseCriticalDates,
  prospectCount,
  reviewProgress,
  reviewWeek,
} from "../src/ui/home/deal-tiles.ts";

const rules: BoardRules = {
  ...(await import("../js/" + "deal-items.js")),
  ...(await import("../js/" + "deal-review-model.js")),
  ...(await import("../js/" + "pipeline-model.js")),
};

const TODAY = "2026-11-25";
const date = (id: string, due_on: string, deal_name = "Example Dental") => ({
  id,
  deal_id: `deal-${id}`,
  deal_name,
  kind: "Due diligence ends",
  due_on,
  done: false,
});
const read = (rows: unknown[]) => ({ schema_version: "calendar-critical-dates.v1", critical_dates: rows });

test("Coming up holds today through 14 days later, both included, soonest first", () => {
  const dates = parseCriticalDates(
    read([
      date("late", "2026-12-10"),
      date("past", "2026-11-24"),
      date("last", "2026-12-09"),
      date("today", TODAY),
      date("tomorrow-b", "2026-11-26", "Sample Vision"),
      date("tomorrow-a", "2026-11-26", "Example Dental"),
    ]),
  );
  assert.deepEqual(
    comingUp(dates, TODAY).map(({ id }) => id),
    ["today", "tomorrow-a", "tomorrow-b", "last"],
  );
});

test("Coming up leaves out done dates and refuses a malformed read", () => {
  assert.deepEqual(parseCriticalDates(read([{ ...date("done", TODAY), done: true }])), []);
  assert.throws(() => parseCriticalDates(read([{ ...date("bad", TODAY), due_on: "2026-11-25T00:00:00Z" }])));
  assert.throws(() => parseCriticalDates({ schema_version: "calendar-critical-dates.v0", critical_dates: [] }));
});

test("the Monday review week starts on the Monday holding today", () => {
  assert.equal(reviewWeek("2026-11-25"), "2026-11-23");
  assert.equal(reviewWeek("2026-11-23"), "2026-11-23");
  assert.equal(reviewWeek("2026-11-29"), "2026-11-23");
  assert.equal(reviewWeek("2026-11-30"), "2026-11-30");
});

test("Monday review progress counts marked items and prospects count once per party", () => {
  const items = [{ reviewed: { by: "joe", at: "2026-11-23T15:00:00Z" } }, { reviewed: null }, {}];
  assert.deepEqual(reviewProgress({ items }), { reviewed: 1, total: 3 });
  assert.equal(prospectCount({ prospects: [{ party_id: "p1" }, { party_id: "p2" }, { party_id: "p1" }] }), 2);
  assert.throws(() => prospectCount({ prospects: [{ name: "Sample Person" }] }));
});

const step = (owner: string, due_on: string) => ({
  id: `${owner}-${due_on}`,
  owner,
  due_on,
  description: "Call the landlord",
});
const deal = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: `Example ${id}`,
  owner: "joe",
  phase: "Research",
  operating_state: "active",
  attention: false,
  next_step_required: false,
  open_actions: [step("joe", "2026-12-01")],
  ...fields,
});

test("the board and Home share one Needs attention rule", () => {
  assert.deepEqual(rules.attentionReasons(deal("a", { open_actions: [step("joe", "2026-11-22")] }), TODAY), [
    "Step 3 days late",
  ]);
  assert.deepEqual(rules.attentionReasons(deal("b", { attention: true }), TODAY), ["Flagged by a partner"]);
  assert.deepEqual(rules.attentionReasons(deal("c", { open_actions: [step("dell", "2026-11-22")] }), TODAY), []);
});

test("Home counts Local Deals' open deals per phase, those needing attention, and those missing a next step", () => {
  const glance = dealsAtAGlance(
    {
      deals: [
        deal("late", { open_actions: [step("joe", "2026-11-22")] }),
        deal("flagged", { phase: "Legal", attention: true, next_step_required: true, open_actions: [] }),
        deal("quiet", { phase: "Legal" }),
        deal("parked", { operating_state: "parked", attention: true }),
        deal("national", { workspace_kind: "national_account", attention: true }),
        deal("closed", { phase: "Closed", next_step_required: true }),
      ],
    },
    TODAY,
    rules,
  );
  assert.equal(glance.open, 3);
  assert.deepEqual(
    glance.phases.filter(({ count }) => count).map(({ label, count }) => [label, count]),
    [
      ["Research", 1],
      ["Legal", 2],
    ],
  );
  assert.equal(glance.phases.length, 7);
  assert.deepEqual(
    glance.attention.map(({ id, reason, flagged, late }) => [id, reason, flagged, late]),
    [
      ["late", "Step 3 days late", false, true],
      ["flagged", "Flagged by a partner", true, false],
    ],
  );
  assert.equal(glance.missingNextStep, 1);
  assert.throws(() => dealsAtAGlance({ deals: "none" }, TODAY, rules));
});
