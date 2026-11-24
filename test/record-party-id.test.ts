import assert from "node:assert/strict";
import test from "node:test";
import { validRecordPayload } from "../js/workspace-business-model.js";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const party = "00000000-0000-4000-8000-000000000777";

for (const dataset of ["clients", "vendors"] as const) {
  test(`A ${dataset} drawer read loads with or without the party id`, () => {
    const read = directoryFixture(
      `http://demo.example/api/v1/business/${dataset}/00000000-0000-4000-8000-000000000001`,
    );
    const { record } = read;
    assert.ok(typeof record === "object" && record !== null);
    const withParty = (party_id: unknown) => ({ ...read, record: { ...record, party_id } });
    assert.equal(validRecordPayload(read, dataset), true, "without party_id");
    assert.equal(validRecordPayload(withParty(party), dataset), true, "with party_id");
    assert.equal(validRecordPayload(withParty("not-a-uuid"), dataset), false, "malformed party_id");
    assert.equal(validRecordPayload(withParty(42), dataset), false, "non-string party_id");
  });
}
