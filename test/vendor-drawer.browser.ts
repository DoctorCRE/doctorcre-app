import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/vendor-drawer";
await mkdir(shots, { recursive: true });
const vendorId = "00000000-0000-4000-8000-000000000001";
// The old read lists the person under their party id, not the vendor row's id.
const partyId = "00000000-0000-4000-8000-000000000301";

// A person vendor, as production sends one: listed under their own contacts, no deal history yet.
function personVendor(url: string, contactId: string) {
  const payload = directoryFixture(url);
  // The fixture is declared as a loose record; a detail read carries one vendor record.
  const record = payload.record as (Record<string, unknown> & { relationship: object }) | undefined;
  if (!record) return payload;
  const contact = { phone: "(555) 010-0100", cell: "(555) 010-0199", email: "demo.vendor@example.test" };
  Object.assign(record, contact, {
    party_kind: "person",
    name: "Demo Vendor Person",
    territory: "Demo South",
    contact_state: "active",
    relationship: {
      ...record.relationship,
      deals_referred: 0,
      deals_worked: 0,
      won: 0,
      lost: 0,
      win_rate: null,
      last_contacted_at: null,
      last_contact_note: null,
    },
    people: [
      {
        company: { id: "00000000-0000-4000-8000-000000000201", name: "Demo Equities" },
        contact: { id: contactId, name: "Demo Vendor Person", ...contact },
        office: null,
        research: { status: "not_researched", finding_id: null, observed_at: null, expires_on: null },
      },
    ],
  });
  return payload;
}

for (const [width, height, read, contactId] of [
  [1280, 800, "next", vendorId],
  [1440, 900, "next", vendorId],
  [390, 844, "next", vendorId],
  [1280, 800, "old", partyId],
] as const)
  test(`a person vendor's drawer shows each fact once at ${width} on the ${read} read`, async (t) => {
    const server = await startFixtureServer();
    t.after(() => server.stop());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route("https://**", (r) => r.abort());
    await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: personVendor(r.request().url(), contactId) }));
    await page.goto(`${server.url}/vendors?record=${vendorId}`);
    const panel = page.locator("#recordPanel");
    await panel.getByRole("region", { name: "Vendor contacts" }).waitFor();
    await page.screenshot({ path: `${shots}/vendor-drawer-${width}-${read}.png` });
    const drawer = await panel.evaluate((node) => ({
      labels: [...node.querySelectorAll("dt")].map((dt) => dt.textContent?.trim()),
      contactStatus: [...node.querySelectorAll(".record-field")]
        .find((field) => field.querySelector("dt")?.textContent === "Contact status")
        ?.querySelector("dd")?.textContent,
      emptySections: [...node.querySelectorAll(".record-section")].filter((section) => !section.textContent?.trim())
        .length,
      // The next section's top border already closes the contact list.
      closingLine: getComputedStyle(node.querySelector(".vendor-contacts > li:last-child") ?? node).borderBottomWidth,
    }));
    for (const label of ["Territory", "Phone", "Mobile", "Email"])
      assert.equal(drawer.labels.filter((text) => text === label).length, 1, `${label} shows once: ${drawer.labels}`);
    assert.equal(drawer.contactStatus, "Active", "contact status reads as a plain label");
    assert.equal(drawer.emptySections, 0, "no empty section draws its dividers");
    assert.equal(drawer.closingLine, "0px", "no second divider under the last contact");
  });
