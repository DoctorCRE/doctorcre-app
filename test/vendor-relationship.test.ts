import assert from "node:assert/strict";
import test from "node:test";
import { relationshipChange, type VendorRole, vendorRole } from "../src/ui/vendor-relationship.ts";

const building: VendorRole = { relationship_level: 1, disposition: null, disposition_reason: null, is_target: false };
const parked: VendorRole = { ...building, disposition: "parked", disposition_reason: "Slow to reply" };

test("Choosing a level saves only the level when no ruling stands", () => {
  assert.deepEqual(relationshipChange(building, { level: 2 }), { relationship_level: { from: 1, to: 2 } });
  assert.deepEqual(relationshipChange(building, { level: null }), { relationship_level: { from: 1, to: null } });
  assert.deepEqual(relationshipChange(building, { level: 1 }), {});
});

test("Choosing a level on a parked vendor lifts the ruling and its reason", () => {
  assert.deepEqual(relationshipChange(parked, { level: 1 }), {
    disposition: { from: "parked", to: null },
    disposition_reason: { from: "Slow to reply", to: null },
  });
});

test("Park and Avoid save the ruling with the reason as typed, trimmed", () => {
  assert.deepEqual(relationshipChange(building, { ruling: "avoid", reason: "  Poor service " }), {
    disposition: { from: null, to: "avoid" },
    disposition_reason: { from: null, to: "Poor service" },
  });
  assert.deepEqual(relationshipChange(parked, { ruling: "parked", reason: "Moved away" }), {
    disposition_reason: { from: "Slow to reply", to: "Moved away" },
  });
});

test("Want to meet turns the target flag on and off", () => {
  assert.deepEqual(relationshipChange(building, { wantToMeet: true }), { is_target: { from: false, to: true } });
  assert.deepEqual(relationshipChange({ ...building, is_target: true }, { wantToMeet: false }), {
    is_target: { from: true, to: false },
  });
});

test("A party read's vendor role reads as stored, and a party with none reads as null", () => {
  assert.deepEqual(
    vendorRole({ vendor: { relationship_level: 3, disposition: "avoid", disposition_reason: "Why", is_target: true } }),
    { relationship_level: 3, disposition: "avoid", disposition_reason: "Why", is_target: true },
  );
  assert.deepEqual(vendorRole({ vendor: { relationship_level: null, disposition: null } }), {
    relationship_level: null,
    disposition: null,
    disposition_reason: null,
    is_target: false,
  });
  assert.equal(vendorRole({ vendor: null }), null);
});
