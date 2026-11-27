import assert from "node:assert/strict";
import test from "node:test";
import { recordSections } from "../js/workspace-business-model.js";

const contactStatus = (dataset: "vendors" | "clients", state: string) =>
  recordSections(dataset, { contact_state: state })
    .flatMap((section) => section.fields)
    .find((field) => field.key === "contact_state")?.text;

test("Contact status reads as the plain label for vendors and clients", () => {
  for (const dataset of ["vendors", "clients"] as const) {
    assert.equal(contactStatus(dataset, "paused"), "Paused");
    assert.equal(contactStatus(dataset, "do_not_contact"), "Do not contact");
  }
  assert.equal(contactStatus("clients", "active"), "Active");
});

test("A vendor's card shows Contact status only when it is not Active, and never Stage or Disposition", () => {
  const fields = recordSections("vendors", {
    contact_state: "active",
    recorded_stage: "warm",
    recorded_disposition: "parked",
  }).flatMap((section) => section.fields);
  assert.equal(fields.find((field) => field.key === "contact_state")?.known, false);
  assert.deepEqual(
    fields.filter((field) => ["recorded_stage", "recorded_disposition"].includes(field.key)),
    [],
  );
});

test("A client or vendor's owner reads as the partner's first name", () => {
  for (const dataset of ["vendors", "clients"] as const) {
    const owner = recordSections(dataset, { owner_label: "Avery Example" })
      .flatMap((section) => section.fields)
      .find((field) => field.key === "owner_label");
    assert.equal(owner?.text, "Avery");
  }
});
