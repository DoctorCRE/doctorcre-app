import assert from "node:assert/strict";
import test from "node:test";
import { validRecordPayload } from "../js/workspace-business-model.js";
import { linkRecordNames } from "../src/ui/record-links.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

test("A client drawer read loads when it carries record links", () => {
  const read = directoryFixture("http://demo.example/api/v1/business/clients/00000000-0000-4000-8000-000000000001");
  const { record } = read;
  assert.ok(typeof record === "object" && record !== null);
  const withLinks = (record_links: unknown) => ({ ...read, record: { ...record, record_links } });
  assert.equal(validRecordPayload(withLinks([]), "clients"), true, "empty record_links");
  assert.equal(
    validRecordPayload(
      withLinks([{ text: "Example Deal", url: "/deals/00000000-0000-4000-8000-000000000002" }]),
      "clients",
    ),
    true,
    "one record link",
  );
});

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

test("a name shared by two records stays text while other names still link", () => {
  const shared = [
    { text: "Example Dental", url: "/relationships?node=lead:l1" },
    { text: "Example Dental", url: "/relationships?node=party:p1" },
    { text: "Example Dental", url: "/relationships?node=lead:l1" },
    { text: "Dr. Pat", url: "/relationships?node=party:p3" },
    { text: "Dr. Pat", url: "/relationships?node=party:p3" },
  ];
  assert.equal(
    linkRecordNames("Example Dental met Dr. Pat", shared),
    'Example Dental met <a href="/relationships?node=party:p3">Dr. Pat</a>',
  );
});
