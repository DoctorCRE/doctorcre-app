import assert from "node:assert/strict";
import test from "node:test";
import {
  type BoardRules,
  comingUp,
  dealsAtAGlance,
  parseCriticalDates,
  reviewCounts,
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

test("the Deals heading counts the Monday review's own items, so its parts add up to the review total", () => {
  const deal = (state: string, workspace_kind: string, operating_state: string, reviewed: unknown = null) => ({
    deal_id: "d",
    state,
    workspace_kind,
    operating_state,
    reviewed,
  });
  const items = [
    deal("open", "team", "active", { by: "joe", at: "2026-11-23T15:00:00Z" }),
    deal("open", "team", "active"),
    deal("open", "team", "parked"),
    deal("open", "national_account", "active"),
    deal("open", "national_account", "parked"),
    deal("lost", "team", "active"),
    deal("closed", "national_account", "active"),
    { party_id: "p", state: "open", reviewed: null },
    { party_id: "p", state: "dropped", reviewed: null },
  ];
  assert.deepEqual(reviewCounts({ items }), {
    open: 2,
    parked: 1,
    national: 2,
    prospects: 1,
    closed: 2,
    dropped: 1,
    reviewed: 1,
    total: 9,
  });
  assert.throws(() => reviewCounts({ items: [null] }));
});

const deal = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: `Example ${id}`,
  owner: "joe",
  phase: "Research",
  attention: null,
  open_actions: [{ id: `step-${id}`, owner: "joe", due_on: "2026-11-01", description: "Call the landlord" }],
  ...fields,
});

test("Home lists the deals the engine says need attention, with the board's reason", () => {
  const reason = "A next step is late.";
  const board = {
    deals: [
      deal("a", { attention: { reason, since: "2026-11-02" } }),
      deal("b", { attention: true }),
      deal("c", { attention: { reason: " ", since: "2026-11-02" } }),
      deal("d"),
    ],
  };
  assert.deepEqual(dealsAtAGlance(board, rules).attention, [{ id: "a", name: "Example a", reason }]);
  assert.equal(rules.attentionReason(deal("b", { attention: true })), null, "a stored flag is not attention");
});
