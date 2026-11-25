import assert from "node:assert/strict";
import test from "node:test";
import { readableNetwork } from "../js/relationship-network-model.js";

const node = (name: string, kind = "contact", ref?: string) => ({
  id: `party:${name}`,
  name,
  kind,
  ...(ref ? { ref } : {}),
});

test("placeholder names say what they are and follow the named records", () => {
  const { nodes } = readableNetwork({
    nodes: [
      node("(new practice, moving north)"),
      node("demo-site.com"),
      node("4410", "client"),
      node("V-CPA-901", "vendor"),
      node("C-042"),
      node("Demo Coded Dental", "client", "C-042"),
      node("Dr. Demo Lee"),
      node("120 Demo Main"),
    ],
    edges: [],
    suggestions: [],
  });
  assert.deepEqual(
    nodes.map(({ name, unnamed }) => (unnamed ? `${name} *` : name)),
    [
      "Demo Coded Dental",
      "Demo Coded Dental",
      "Dr. Demo Lee",
      "120 Demo Main",
      "Unnamed contact (new practice, moving north) *",
      "Unnamed contact (demo-site.com) *",
      "Unnamed client (4410) *",
      "An old record *",
    ],
  );
});

test("an old code in a note reads as its record's name, else as an old record", () => {
  const { edges, suggestions } = readableNetwork({
    nodes: [node("Demo Coded Dental", "client", "C-042")],
    edges: [{ summary: "Met C-042 off I-10.", detail: null }],
    suggestions: [{ reason: "Knows C-042 and L-777.", detail: "V-SUP-123 offered." }],
  });
  assert.deepEqual(edges, [{ summary: "Met Demo Coded Dental off I-10.", detail: null }]);
  assert.deepEqual(suggestions, [
    { reason: "Knows Demo Coded Dental and an old record.", detail: "an old record offered." },
  ]);
});
