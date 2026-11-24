import assert from "node:assert/strict";
import test from "node:test";
import { validRecordPayload } from "../js/workspace-business-model.js";
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
