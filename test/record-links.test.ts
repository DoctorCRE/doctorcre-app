import assert from "node:assert/strict";
import test from "node:test";
import { linkRecordNames } from "../src/ui/record-links.ts";

const links = [
  { text: "Example Dental", url: "/relationships?node=party:p1" },
  { text: "Example Dental Group", url: "/relationships?node=party:p2" },
  { text: "Dr. Pat <Example>", url: "/relationships?node=party:p3" },
];

test("each named record opens its record and the rest of the note stays escaped", () => {
  assert.equal(
    linkRecordNames("Called Example Dental & Dr. Pat <Example> about <b>rent</b>.", links),
    'Called <a href="/relationships?node=party:p1">Example Dental</a> &amp; <a href="/relationships?node=party:p3">Dr. Pat &lt;Example&gt;</a> about &lt;b&gt;rent&lt;/b&gt;.',
  );
});

test("a longer name wins over a name it contains, and a name inside a word stays text", () => {
  assert.equal(
    linkRecordNames("Example Dental Group and Example Dentalworks", links),
    '<a href="/relationships?node=party:p2">Example Dental Group</a> and Example Dentalworks',
  );
});

test("without record links the note is only escaped", () => {
  const missing = [
    undefined,
    null,
    [],
    [{ text: "Example Dental", url: "javascript:alert(1)" }],
    [{ text: "", url: "/relationships?node=party:p1" }],
  ];
  for (const value of missing) assert.equal(linkRecordNames("Example Dental <i>", value), "Example Dental &lt;i&gt;");
});
