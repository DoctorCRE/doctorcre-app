import assert from "node:assert/strict";
import test from "node:test";
import {
  DROP_CATEGORIES,
  dropCategoryForItem,
  dropCategoryForKey,
  parseDropReasons,
} from "../src/ui/home/drop-reasons.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const item = (overrides: Record<string, unknown> = {}) => ({
  item_id: `next_action:${id(1)}`,
  source_type: "next_action",
  kind_label: "Task",
  ...overrides,
});

test("DROP_CATEGORIES covers all eight engine drop-reason categories", () => {
  assert.deepEqual(
    new Set(Object.values(DROP_CATEGORIES)),
    new Set([
      "next_step",
      "filing",
      "phase_move",
      "lead",
      "call_note",
      "reply_draft",
      "checklist_reminder",
      "tour_feedback",
    ]),
  );
  assert.equal(dropCategoryForKey("unknown_kind"), null);
  assert.equal(dropCategoryForKey("toString"), null);
  assert.equal(dropCategoryForKey(null), null);
});

test("dropCategoryForItem maps Reminders, Inbox, update, draft, and suggestion rows via the table", () => {
  assert.equal(dropCategoryForItem(item()), "next_step");
  assert.equal(
    dropCategoryForItem(
      item({ item_id: `capture_post_call_action:${id(2)}`, source_type: "capture_post_call_action" }),
    ),
    "next_step",
  );
  assert.equal(
    dropCategoryForItem(
      item({
        item_id: `notification:${id(3)}`,
        source_type: "notification",
        kind: "update",
        kind_label: "Update",
      }),
    ),
    "checklist_reminder",
  );
  assert.equal(
    dropCategoryForItem(
      item({
        item_id: `notification:${id(4)}`,
        source_type: "notification",
        kind: "tour_feedback",
        kind_label: "Tour feedback",
      }),
    ),
    "tour_feedback",
  );
  assert.equal(
    dropCategoryForItem(
      item({
        item_id: `reply_draft:${id(5)}`,
        source_type: "email_proposal",
        kind_label: "Reply draft",
        reply_draft_id: id(5),
        reply_draft_status: "pending",
        suggestions: [{ id: id(6), kind: "file_to_deal" }],
      }),
    ),
    "reply_draft",
  );
  assert.equal(
    dropCategoryForItem(
      item({
        item_id: `reply_draft:${id(7)}`,
        source_type: "email_proposal",
        kind_label: "Reply draft",
        reply_draft_id: id(7),
        reply_draft_status: "failed",
      }),
    ),
    "reply_draft",
  );
  for (const [proposalKind, expected] of [
    ["next_step", "next_step"],
    ["file_to_deal", "filing"],
    ["possible_new_deal", "filing"],
    ["phase_move", "phase_move"],
    ["new_lead", "lead"],
    ["email_lead", "lead"],
    ["lead_stage_move", "lead"],
    ["log_call", "call_note"],
  ] as const) {
    assert.equal(
      dropCategoryForItem(
        item({
          item_id: `suggestion:${id(8)}`,
          source_type: "email_proposal",
          kind_label: "Suggestion",
          suggestions: [{ id: id(8), kind: proposalKind }],
        }),
      ),
      expected,
      proposalKind,
    );
  }
  assert.equal(
    dropCategoryForItem(
      item({
        item_id: `suggestion:${id(9)}`,
        source_type: "email_proposal",
        kind_label: "Suggestion",
      }),
    ),
    null,
  );
});

test("parseDropReasons validates category, trims, deduplicates, and caps at five", () => {
  assert.deepEqual(
    parseDropReasons(
      {
        category: "next_step",
        reasons: [
          " Already handled ",
          "",
          "already handled",
          "Not needed",
          "Duplicate",
          "Not ours to do",
          "Fifth",
          "Sixth",
        ],
      },
      "next_step",
    ),
    ["Already handled", "Not needed", "Duplicate", "Not ours to do", "Fifth"],
  );
  assert.deepEqual(parseDropReasons({ category: "filing", reasons: ["Spam"] }, "next_step"), []);
  assert.deepEqual(parseDropReasons(null, "next_step"), []);
});
