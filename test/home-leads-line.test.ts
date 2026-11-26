import assert from "node:assert/strict";
import test from "node:test";
import { leadBadgeCounts } from "../js/leads-model.js";

const lead = (id: string, extra: Record<string, unknown> = {}) => ({ id, stage: "new", suppressed: false, ...extra });
const quiet = (subject_id: string, days_overdue: number, ref: string | null = null) => ({
  subject_type: "lead",
  subject_id,
  ref,
  days_overdue,
});

test("Home counts the leads that carry the Leads board's New from email and Follow-up late badges", () => {
  const leads = [
    lead("a", { new_from_email: true }),
    lead("b", { new_from_email: true, stage: "archived" }),
    lead("c", { new_from_email: true, is_deal: true }),
    lead("d", { registry_ref: "L-1" }),
    lead("e"),
  ];
  const proposals = [
    quiet("a", 3),
    quiet("other", 2, "L-1"),
    quiet("e", 0),
    quiet("b", 5),
    { ...quiet("x", 9), subject_type: "vendor" },
  ];
  assert.deepEqual(leadBadgeCounts(leads, proposals), { newFromEmail: 1, followUpsLate: 2 });
});
