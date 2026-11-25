import assert from "node:assert/strict";
import test from "node:test";
import { ownerPresentation, recordSections } from "../js/workspace-business-model.js";

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

test("A client or vendor's owner reads as the partner's first name", () => {
  for (const dataset of ["vendors", "clients"] as const) {
    const owner = recordSections(dataset, { owner_label: "Avery Example" })
      .flatMap((section) => section.fields)
      .find((field) => field.key === "owner_label");
    assert.equal(owner?.text, "Avery");
  }
  assert.equal(ownerPresentation({ owner_label: "Avery Example" }).text, "Avery");
  assert.equal(ownerPresentation({ owner_label: null }).text, "Not recorded");
});
