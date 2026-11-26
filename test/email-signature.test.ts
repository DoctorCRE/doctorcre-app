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

test("a signature with no sign-off folds below the sender's name line", () => {
  const body =
    "The lease is signed.\n\nPat Example\nExample Realty Group\n555-010-0100 (o)\n555-010-0101 (f)\nexamplerealty.com";
  assert.deepEqual(splitSignature(body, "Pat Example"), {
    text: "The lease is signed.\n\nPat Example",
    signature: "Example Realty Group\n555-010-0100 (o)\n555-010-0101 (f)\nexamplerealty.com",
  });
});

test("a one-line body folds the contact details after the last sentence and the sender's name", () => {
  const address = "100 Main St, Suite 200 Austin, TX 78701";
  const signature = `${address} ${contacts} pat@example.test`;
  for (const [signedOff, folded] of [
    ["Thanks, Pat Example Senior Broker, Example Realty Group", signature],
    ["Thanks again, Pat Senior Broker, Example Realty Group", signature],
    ["Pat Example", `Senior Broker, Example Realty Group ${signature}`],
  ])
    assert.deepEqual(
      splitSignature(`Hi Joe, Can you send the east suite plan? ${signedOff} ${folded}`, "Pat Example"),
      { text: `Hi Joe, Can you send the east suite plan? ${signedOff}`, signature: folded },
    );
});

test("a one-line body keeps every word after the sign-off up to the first contact detail", () => {
  const signature = "555-010-0100 sender@example.test";
  for (const [sender, text] of [
    ["Rob Example", "Thanks, Robert"],
    ["Rob Example", "The lease is signed. Thanks, Robert Example"],
    ["Pat Example", "Done. Thanks, Patricia"],
    ["Pat Example", "Best, Pat Q. Example VP"],
    ["Pat Example", "Thanks, Pat Example-Smith"],
  ] as const)
    assert.deepEqual(splitSignature(`${text} ${signature}`, sender), { text, signature });
  assert.equal(splitSignature(`Thanks, Pat Example | ${signature}`, "Pat Example").text, "Thanks, Pat Example");
  assert.deepEqual(splitSignature(`The lease is signed. Thanks, Robert Example ${contacts}`, "Rob Example"), {
    text: "The lease is signed. Thanks, Robert Example",
    signature: contacts,
  });
});

test("words before the sender's name stay visible in a one-line body", () => {
  const signature = "Example Realty 555-010-0100 pat@example.test";
  for (const said of ["Approved.", "Thanks for the tour today. Confirmed."])
    assert.deepEqual(splitSignature(`${said} Pat Example ${signature}`, "Pat Example"), {
      text: `${said} Pat Example`,
      signature,
    });
});

test("an instruction with a phone number stays visible above the sign-off and name", () => {
  for (const said of [
    "CALL SAM AT 555-010-0101 ABOUT THE KEYS.",
    "The keys are with the front desk.\nCall Sam at 555-010-0101.",
  ])
    assert.deepEqual(splitSignature(`${said}\n\nThanks,\nPat\n555-010-0100\npat@example.test`, "Pat Example"), {
      text: `${said}\n\nThanks,\nPat`,
      signature: "555-010-0100\npat@example.test",
    });
  assert.deepEqual(
    splitSignature(
      "The keys are with the front desk. Call Sam at 555-010-0101. Pat Example 555-010-0100 pat@example.test",
      "Pat Example",
    ),
    {
      text: "The keys are with the front desk. Call Sam at 555-010-0101. Pat Example",
      signature: "555-010-0100 pat@example.test",
    },
  );
});

test("a typed address above the sign-off stays whole", () => {
  const body =
    "The new address is below.\n\n123 Main St, Suite 200\nAustin, TX 78701\n\nThanks,\nPat\n555-010-0100\npat@example.test";
  assert.deepEqual(splitSignature(body, "Pat Example"), {
    text: "The new address is below.\n\n123 Main St, Suite 200\nAustin, TX 78701\n\nThanks,\nPat",
    signature: "555-010-0100\npat@example.test",
  });
});

test("a sign-off in Spanish, French or German keeps the name visible", () => {
  for (const [said, signedOff] of [
    ["Ya firmamos el contrato.", "Saludos,\nPat"],
    ["Le bail est signé.", "Cordialement, Pat Example"],
    ["Der Vertrag ist unterschrieben.", "Mit freundlichen Grüßen\nPat Example"],
  ])
    for (const gap of [" ", "\n\n"])
      assert.deepEqual(splitSignature(`${said}${gap}${signedOff}\n555-010-0100\npat@example.test`, "Pat Example"), {
        text: `${said}${gap}${signedOff}`,
        signature: "555-010-0100\npat@example.test",
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
    "CALL SAM AT 555-010-0101 OR EMAIL sam@example.test",
    "The keys are with the front desk. Call Sam at 555-010-0101 or Lee at 555-010-0102.",
    "Meet Tuesday At 3 p.m. Room 4B 555-010-0101 lee@example.test",
    "The new address is below.\n\n123 Main St, Suite 200\nAustin, TX 78701\n555-010-0100\npat@example.test",
  ])
    assert.deepEqual(splitSignature(body, "Pat Example"), { text: body, signature: null });
});

// Shape seen on a bank's mail: a social line, a table-cell signature with Unicode hyphens, then a legal notice and a banner.
const bankSignature = [
  "Pat Example",
  ",",
  "SVP/Example Market President",
  "100 Example Coast Pkwy, Suite 106",
  ",",
  "Exampleton",
  ",",
  "FL",
  "30000",
  "D:",
  "(555) 010‑0100",
  "C:",
  "(555) 010‑0101",
  "E:",
  "pat@example.test",
  "NMLS# 000000",
].join("\n");
const legalFooter =
  "Notice: This communication is intended only for the person or entity to whom it is addressed. If you received this in error, please reply and delete it.\n\nExample Bank | Share Portal – click to send documents securely.";

test("a signature with Unicode-hyphen phones and a legal notice under it folds with the notice", () => {
  const body = `What's the story on this building?\n\nFollow us\n${bankSignature}\n${legalFooter}`;
  assert.deepEqual(splitSignature(body, "Pat Example"), {
    text: "What's the story on this building?\n\nFollow us\nPat Example",
    signature: `${bankSignature.slice("Pat Example\n".length)}\n${legalFooter}`,
  });
});

test("a legal notice with no signature above it stays visible", () => {
  const body = `Please review the attached lease.\n${legalFooter}`;
  assert.deepEqual(splitSignature(body, "Pat Example"), { text: body, signature: null });
});
