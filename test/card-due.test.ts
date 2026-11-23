import assert from "node:assert/strict";
import test from "node:test";
import { cardDueLabel } from "../src/ui/card-due.ts";

test("a board card names its due day plainly and marks today and late", () => {
  assert.deepEqual(cardDueLabel("2026-11-23", "2026-11-23"), { text: "Due today", tone: "today" });
  assert.deepEqual(cardDueLabel("2026-11-18", "2026-11-23"), { text: "Due Nov 18", tone: "late" });
  assert.deepEqual(cardDueLabel("2026-12-04", "2026-11-23"), { text: "Due Dec 4", tone: "" });
  assert.deepEqual(cardDueLabel("2027-01-05", "2026-11-23"), { text: "Due Jan 5, 2027", tone: "" });
});
