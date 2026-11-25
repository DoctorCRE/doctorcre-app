import assert from "node:assert/strict";
import test from "node:test";
import { splitSignature } from "../src/ui/home/email-signature.ts";

const contacts = "P: (555) 010-0100 | F: 555.010.0101";

test("a trailing block of contact lines under a sign-off and name folds", () => {
  const body = [
    "Can you send the east suite plan?",
    "",
    "Best regards,",
    "Pat Example",
    "Senior Broker, Example Realty Group",
    "100 Main St, Suite 200",
    "Austin, TX 78701",
    contacts,
    "pat@example.test",
    "www.example.test",
  ].join("\n");
  assert.deepEqual(splitSignature(body, "Pat Example"), {
    text: "Can you send the east suite plan?\n\nBest regards,\nPat Example",
    signature: [
      "Senior Broker, Example Realty Group",
      "100 Main St, Suite 200",
      "Austin, TX 78701",
      contacts,
      "pat@example.test",
      "www.example.test",
    ].join("\n"),
  });
});

test("a signature with no sign-off folds below the name line", () => {
  const body =
    "The lease is signed.\n\nPat Example\nExample Realty Group\n555-010-0100 (o)\n555-010-0101 (f)\nexamplerealty.com";
  assert.deepEqual(splitSignature(body, null), {
    text: "The lease is signed.\n\nPat Example",
    signature: "Example Realty Group\n555-010-0100 (o)\n555-010-0101 (f)\nexamplerealty.com",
  });
});

test("a one-line body folds the contact details after the last sentence and the sender's name", () => {
  const signature = `Senior Broker, Example Realty Group 100 Main St, Suite 200 Austin, TX 78701 ${contacts} pat@example.test`;
  for (const signedOff of ["Thanks, Pat Example", "Thanks again, Pat", "Pat Example"])
    assert.deepEqual(
      splitSignature(`Hi Joe, Can you send the east suite plan? ${signedOff} ${signature}`, "Pat Example"),
      {
        text: `Hi Joe, Can you send the east suite plan? ${signedOff}`,
        signature,
      },
    );
});

test("a one-line body folds the name too when it isn't the sender's", () => {
  assert.deepEqual(splitSignature(`The lease is signed. Thanks, Robert Example ${contacts}`, "Rob Example"), {
    text: "The lease is signed. Thanks,",
    signature: `Robert Example ${contacts}`,
  });
});

test("text a person wrote never folds", () => {
  for (const body of [
    "Hi Joe,\nThanks!\nQuick update on the lease.\nThe landlord's agent is Sam, 555-123-4567.\nHe can tour Tuesday.\nRob",
    "Lease attached.\n\nThanks,\nRob\n\nAlso the TI number is in the attached, call 555-123-4567 if questions.",
    "Sounds good.\n\nThanks,\nPat\nP: 555-010-0100\nPS: call me at 555-010-0100 tomorrow.",
    "Sounds good.\n\nThanks,\nPat\nExample Realty Group",
    "Sounds good.\n\nThanks,\nPat\nP: 555-010-0100",
    "Sounds good.\n\nThanks,\nPat",
    "Call 555-010-0100 when you land.",
    "Call me at 555-010-0100 or email pat@example.test.",
    "Can you reach Sam at 555-010-0100 or Lee at 555-010-0101?",
    `Sounds good. Thanks, Pat ${contacts} PS: the keys are under the mat.`,
    `Pat Example ${contacts} Can you confirm Tuesday?`,
  ])
    assert.deepEqual(splitSignature(body, "Pat Example"), { text: body, signature: null });
});
