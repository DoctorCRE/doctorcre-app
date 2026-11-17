import test from "node:test";
import assert from "node:assert/strict";

import { noteText } from "../js/pipeline-model.js";

import { noteEntries } from '../js/local-deals-model.js';


test("a plain sentence passes through unchanged", () => {
  assert.equal(noteText("Send the redlines to counsel"), "Send the redlines to counsel");
  assert.equal(noteText("  Call Dr. Patel  "), "Call Dr. Patel");
});

test("a Python dict repr yields its sentence", () => {
  assert.equal(noteText("{'text': 'Send the redlines to counsel', 'at': '2026-09-28T14:00:00Z'}"), "Send the redlines to counsel");
  assert.equal(noteText(`{'text': "Landlord's counsel has the lease", 'by': 'joe'}`), "Landlord's counsel has the lease");
  assert.equal(noteText("{'at': '2026-09-28', 'text': 'It\\'s with legal'}"), "It's with legal");
});

test("a JSON-shaped string yields its sentence", () => {
  assert.equal(noteText('{"text": "Review the estoppel", "at": "2026-09-28"}'), "Review the estoppel");
  assert.equal(noteText('{"note": "Waiting on the SNDA"}'), "Waiting on the SNDA");
});

test("an object yields its sentence", () => {
  assert.equal(noteText({ text: "Countersign the LOI", at: "2026-09-28" }), "Countersign the LOI");
  assert.equal(noteText({ body: "Title commitment received" }), "Title commitment received");
  assert.equal(noteText({ text: { text: "Nested sentence" } }), "Nested sentence");
});

test("a dict or object with no sentence renders as nothing, never as raw braces", () => {
  assert.equal(noteText("{}"), "");
  assert.equal(noteText({}), "");
  assert.equal(noteText("{'at': '2026-09-28'}"), "");
  assert.equal(noteText(null), "");
  assert.equal(noteText(undefined), "");
});

test("an empty list, as a value or as text, carries no sentence", () => {
  assert.equal(noteText("[]"), "");
  assert.equal(noteText(" [ ] "), "");
  assert.equal(noteText([]), "");
});

test("a list of notes, as a value or as text, reads as its sentences", () => {
  assert.equal(noteText("[{'date': '2026-07-31', 'text': 'Sent the survey'}, {'date': '2026-08-02', 'text': 'Client replied'}]"), "Sent the survey; Client replied");
  assert.equal(noteText('[{"text": "Sent the survey"}]'), "Sent the survey");
  assert.equal(noteText([{ text: "Sent the survey" }, "Client replied"]), "Sent the survey; Client replied");
});

test("a Python list of quoted strings reads as those strings", () => {
  assert.equal(noteText("['Sent survey', 'Called back']"), "Sent survey; Called back");
  assert.equal(noteText(`["It's signed", 'Called back']`), "It's signed; Called back");
  assert.equal(noteText("[{'text': 'a'}, 'loose']"), "a; loose");
});

test("a bracketed note it cannot fully read prints as written", () => {
  assert.equal(noteText("['a'] then more]"), "['a'] then more]");
  assert.equal(noteText("[{'date': '2026-07-31'}, 'loose']"), "[{'date': '2026-07-31'}, 'loose']");
  assert.equal(noteText('[{"date": "2026-07-31"}]'), '[{"date": "2026-07-31"}]');
  assert.equal(noteText("[{'text': 'Sent the survey'}, {'text': 'Client rep"), "[{'text': 'Sent the survey'}, {'text': 'Client rep");
});

test("a Python repr's escapes read back as the characters they stand for", () => {
  assert.equal(noteText(String.raw`[{'date': '2026-07-31', 'text': 'Call\r\nback'}]`), "Call\r\nback");
  assert.equal(noteText(String.raw`[{'text': 'a\x01b c\U000e0001d\\e\'f"'}]`), "a\x01b c\u{e0001}d\\e'f\"");
  assert.equal(noteText(String.raw`['It\'s "x"']`), `It's "x"`);
});

test("a note with an escape Python never writes prints as written", () => {
  assert.equal(noteText(String.raw`[{'text': 'a\qb'}]`), String.raw`[{'text': 'a\qb'}]`);
  assert.equal(noteText(String.raw`['a\x0']`), String.raw`['a\x0']`);
  assert.equal(noteText(String.raw`{'text': 'a\qb'}`), String.raw`{'text': 'a\qb'}`);
});

test("a JSON list never drops a string item that reads as no sentence", () => {
  assert.equal(noteText(`["{'date': '2026-07-31'}", "Called back"]`), `["{'date': '2026-07-31'}", "Called back"]`);
  assert.equal(noteText('["", "Called back"]'), "Called back");
});

test("square brackets inside an ordinary sentence are left alone", () => {
  assert.equal(noteText("[Draft] send the LOI"), "[Draft] send the LOI");
});

test("braces inside an ordinary sentence are left alone", () => {
  assert.equal(noteText("Use the {client} template"), "Use the {client} template");
});

test("editable deal detail preserves normalized note summaries and originals", () => {
  const entries = noteEntries({ thread: [{ id: 'demo-note', actor: 'dell', text: "{'text': 'Counsel replied'}" }] });
  assert.equal(entries[0].summary, 'Counsel replied');
  assert.equal(entries[0].original, 'Counsel replied');
  assert.deepEqual(noteEntries({ thread: [{ text: '{}' }] }), []);
});
