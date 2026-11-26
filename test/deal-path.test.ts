import assert from "node:assert/strict";
import test from "node:test";
import { dealPathHtml, pathQuestionHtml, todosByPhase } from "../src/ui/deal-path.ts";

const item = (id: string, status = "not_recorded") => ({ id, label: id, status, due_on: null, source: {} });
const checklist = {
  schema_version: "deal-checklist.v1",
  phases: [
    { id: "legal", label: "Legal / lease", items: [item("contract_draft"), item("critical-date:x", "upcoming")] },
    { id: "invoice", label: "Invoice", items: [item("invoice_recorded", "complete")] },
  ],
};
const phases = [
  { slug: "legal", label: "Legal" },
  { slug: "closed", label: "Closed" },
];
const view = {
  phases,
  current: "legal",
  checklist,
  today: "2026-11-25",
  canMove: true,
  receiptHtml: "",
  focusedItem: null,
};

test("Invoice's to-dos go under Closed and critical dates stay in their own row", () => {
  const byPhase = todosByPhase(checklist);
  assert.deepEqual(
    byPhase?.get("legal")?.map((todo) => todo.id),
    ["contract_draft"],
  );
  assert.deepEqual(
    byPhase?.get("closed")?.map((todo) => todo.id),
    ["invoice_recorded"],
  );
  assert.equal(todosByPhase({ schema_version: "deal-checklist.v2", phases: [] }), null);
});

test("only phases other than the current one ask to move, and only when moves are allowed", () => {
  assert.deepEqual(
    [...dealPathHtml(view).matchAll(/data-path-phase="(\w+)"/g)].map((m) => m[1]),
    ["closed"],
  );
  assert.doesNotMatch(dealPathHtml({ ...view, canMove: false }), /data-path-phase/);
  assert.match(dealPathHtml({ ...view, checklist: null }), /Checklist is unavailable/);
  assert.doesNotMatch(dealPathHtml({ ...view, checklist: null }), /Nothing listed/);
});

test("an unavailable or changed checklist reports unavailable instead of Nothing listed", () => {
  for (const state of ["unavailable", "source_changed"]) {
    const empty = { schema_version: "deal-checklist.v1", template_state: state, phases: [] };
    assert.equal(todosByPhase(empty), null);
    const html = dealPathHtml({ ...view, checklist: empty });
    assert.match(html, /Checklist is unavailable/);
    assert.doesNotMatch(html, /Nothing listed/);
  }
  const unknownType = {
    schema_version: "deal-checklist.v1",
    template_state: "deal_type_unknown",
    phases: checklist.phases,
  };
  assert.ok(todosByPhase(unknownType)?.get("legal")?.length === 1);
  const withoutTodos = dealPathHtml({ ...view, checklist: null, showTodos: false });
  assert.doesNotMatch(withoutTodos, /Checklist is unavailable|Nothing listed/);
});

test("the move question asks no next step; Closed asks the outcome", () => {
  const move = pathQuestionHtml({ slug: "legal", label: "Legal" }, "2026-11-25");
  assert.deepEqual(
    [...move.matchAll(/name="(\w+)"/g)].map((m) => m[1]),
    ["reason"],
  );
  const close = pathQuestionHtml({ slug: "closed", label: "Closed" }, "2026-11-25");
  assert.deepEqual(
    [...close.matchAll(/name="(\w+)"/g)].map((m) => m[1]),
    ["outcome", "outcome", "closedOn", "wonValue", "lostReason"],
  );
});
