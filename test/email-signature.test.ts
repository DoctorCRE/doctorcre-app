import assert from "node:assert/strict";
import test from "node:test";
import { splitSignature } from "../src/ui/home/email-signature.ts";

test("a trailing block of contact lines under a sign-off and name folds", () => {
  const body = [
    "Can you send the east suite plan?",
    "",
    "Best regards,",
    "Pat Example",
    "Senior Broker, Example Realty Group",
    "100 Main St, Suite 200",
    "Austin, TX 78701",
    "P: (555) 010-0100 | F: 555.010.0101",
    "pat@example.test",
    "www.example.test",
  ].join("\n");
  assert.deepEqual(splitSignature(body), {
    text: "Can you send the east suite plan?\n\nBest regards,\nPat Example",
    signature: [
      "Senior Broker, Example Realty Group",
      "100 Main St, Suite 200",
      "Austin, TX 78701",
      "P: (555) 010-0100 | F: 555.010.0101",
      "pat@example.test",
      "www.example.test",
    ].join("\n"),
  });
});

test("text a person wrote never folds", () => {
  for (const body of [
    "Hi Joe,\nThanks!\nQuick update on the lease.\nThe landlord's agent is Sam, 555-123-4567.\nHe can tour Tuesday.\nRob",
    "Lease attached.\n\nThanks,\nRob\n\nAlso the TI number is in the attached, call 555-123-4567 if questions.",
    "Sounds good.\n\nThanks,\nPat\nP: 555-010-0100\nPS: call me at 555-010-0100 tomorrow.",
    "Sounds good.\n\nThanks,\nPat\nExample Realty Group",
    "Sounds good.\n\nThanks,\nPat",
    "Call 555-010-0100 when you land.",
  ])
    assert.deepEqual(splitSignature(body), { text: body, signature: null });
});
