import assert from "node:assert/strict";
import test from "node:test";
import { recordSections } from "../js/workspace-business-model.js";

const contactStatus = (dataset: "vendors" | "clients", state: string) =>
  recordSections(dataset, { contact_state: state })
    .flatMap((section) => section.fields)
    .find((field) => field.key === "contact_state")?.text;

test("Contact status reads as the plain label for vendors and clients", () => {
  for (const dataset of ["vendors", "clients"] as const) {
    assert.equal(contactStatus(dataset, "active"), "Active");
    assert.equal(contactStatus(dataset, "paused"), "Paused");
    assert.equal(contactStatus(dataset, "do_not_contact"), "Do not contact");
  }
});
