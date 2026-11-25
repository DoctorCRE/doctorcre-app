import assert from "node:assert/strict";
import test from "node:test";
import { splitSignature } from "../src/ui/home/email-signature.ts";

test("contact lines under a sign-off and name fold into the signature", () => {
  const body = [
    "Can you send the east suite plan?",
    "",
    "Best regards,",
    "Pat Example",
    "Example Realty Group",
    "P: (555) 010-0100 | F: 555.010.0101",
    "pat@example.test",
  ].join("\n");
  assert.deepEqual(splitSignature(body), {
    text: "Can you send the east suite plan?\n\nBest regards,\nPat Example",
    signature: "Example Realty Group\nP: (555) 010-0100 | F: 555.010.0101\npat@example.test",
  });
});

test("a sign-off with no contact lines or with a postscript stays as written", () => {
  for (const body of [
    "Sounds good.\n\nThanks,\nPat",
    "Sounds good.\n\nThanks,\nPat\nExample Realty Group",
    "Sounds good.\n\nThanks,\nPat\nP: 555-010-0100\nPS: call me at 555-010-0100 tomorrow.",
    "Call 555-010-0100 when you land.",
  ])
    assert.deepEqual(splitSignature(body), { text: body, signature: null });
});
