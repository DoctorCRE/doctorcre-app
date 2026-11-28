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

test("same-day payments show each date once", () => {
  const sameDay = { sent_on: "2026-11-02", paid_on: "2026-11-20" };
  const invoice = { trigger: "lease_signed" as const, triggered_on: "2026-11-01", payments: [sameDay, sameDay] };
  assert.equal(text(dealInvoiceHtml(invoice, words)), "Invoice Invoice paid on 2026-11-20");
  const sent = {
    ...invoice,
    payments: [
      { ...sameDay, paid_on: null },
      { ...sameDay, paid_on: null },
    ],
  };
  assert.equal(text(dealInvoiceHtml(sent, words)), "Invoice Triggered 2026-11-01 Sent 2026-11-02 Paid Not yet");
});

test("a partly paid deal shows its paid day under Paid, not the paid line", () => {
  const invoice = {
    trigger: "lease_signed" as const,
    triggered_on: "2026-10-01",
    payments: [
      { sent_on: "2026-10-02", paid_on: "2026-10-30" },
      { sent_on: "2026-10-02", paid_on: null },
    ],
  };
  assert.equal(text(dealInvoiceHtml(invoice, words)), "Invoice Triggered 2026-10-01 Sent 2026-10-02 Paid 2026-10-30");
});

test("a deal of no known type names no trigger and still shows the marks", () => {
  const html = dealInvoiceHtml({ trigger: null, triggered_on: null, payments: [] }, words);
  assert.equal(text(html), "Invoice Triggered Not yet Sent Not yet Paid Not yet");
});

test("People lists every party by role in the owner's order, never the partners", () => {
  const parties = [
    { role: "listing_agent", name: "Lee Listing", party_id: "p5" },
    { role: "referring_agent", name: "Rae Referrer", party_id: "p4" },
    { role: "support", name: "Dell", party_id: "p6", actor: "dell" },
    { role: "landlord_rep", name: "Avery Broker", party_id: "p3" },
    { role: "attorney", name: "Example Law", party_id: "p2" },
    { role: "client_contact", name: "Dr. Example", party_id: "p1" },
    { role: "attorney", name: "Example Law", party_id: "p2" },
  ];
  assert.deepEqual(dealPeople({ client_id: "c1", client_name: "Example Clinic" }, parties), [
    { name: "Example Clinic", role: "Client", href: "/clients?record=c1" },
    { name: "Dr. Example", role: "Client contact", href: "/relationships?node=party:p1" },
    { name: "Avery Broker", role: "Landlord's broker", href: "/vendors?record=p3" },
    { name: "Example Law", role: "Attorney", href: "/vendors?record=p2" },
    { name: "Rae Referrer", role: "Referring agent", href: "/relationships?node=party:p4" },
    { name: "Lee Listing", role: "Listing side", href: "/relationships?node=party:p5" },
  ]);
});

test("a person with no party id on the read stays plain text", () => {
  assert.deepEqual(dealPeople({}, [{ role: "referring_agent", name: "Rae Referrer" }]), [
    { name: "Rae Referrer", role: "Referring agent", href: "" },
  ]);
});
