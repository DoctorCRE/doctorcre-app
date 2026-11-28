import assert from "node:assert/strict";
import test from "node:test";
import { dealInvoiceHtml, dealPeople } from "../src/ui/deal-overview-side.ts";

const words = (day: string) => day;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("before the trigger, Invoice says when it goes out and shows no amounts", () => {
  const html = dealInvoiceHtml({ trigger: "lease_signed", triggered_on: null, payments: [] }, words);
  assert.equal(text(html), "Invoice Goes out when the lease is signed Triggered Not yet Sent Not yet Paid Not yet");
  assert.doesNotMatch(html, /\$/);
});

test("once every payment is in, Invoice is one paid line on the last payment's day", () => {
  const invoice = {
    trigger: "purchase_closed" as const,
    triggered_on: "2026-10-01",
    payments: [
      { sent_on: "2026-10-02", paid_on: "2026-11-28" },
      { sent_on: "2026-10-02", paid_on: "2026-11-03" },
    ],
  };
  assert.equal(text(dealInvoiceHtml(invoice, words)), "Invoice Invoice paid on 2026-11-28");
});

test("a deal read without an invoice shows no Invoice tile", () => {
  assert.equal(dealInvoiceHtml(undefined, words), "");
});

test("People names the client, then each vendor once with a plain role", () => {
  const vendor = {
    role: "landlord_rep",
    party_id: "v1",
    company: { name: "Example Realty" },
    contact: { name: "Avery" },
  };
  const people = dealPeople({ client_id: "c1", client_name: "Example Clinic", vendors: [vendor, vendor] });
  assert.deepEqual(people, [
    { name: "Example Clinic", role: "Client", href: "/clients?record=c1" },
    { name: "Avery", role: "Landlord's broker", href: "/vendors?record=v1" },
  ]);
});
