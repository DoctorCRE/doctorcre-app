type Payment = { sent_on: string | null; paid_on: string | null };
export type DealInvoice = {
  trigger: "lease_signed" | "purchase_closed" | null;
  triggered_on: string | null;
  payments: Payment[];
};
/** A deal read party: `actor` is set for the partners, who are never listed under People. */
type Party = { role: string; name: string; party_id?: string; actor?: string | null };
export type PeopleDeal = { client_id?: string | null; client_name?: string | null };
type Person = { name: string; role: string; href: string };

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const GOES_OUT = { lease_signed: "the lease is signed", purchase_closed: "the purchase closes" } as const;
const ROLES: Record<string, string> = {
  landlord_rep: "Landlord's broker",
  listing_agent: "Listing side",
  listing_side: "Listing side",
};
// Every role a party plays on a deal that is not a vendor's; anything else is a vendor.
const NOT_VENDOR = [
  "client_contact",
  "referring_agent",
  "listing_agent",
  "listing_side",
  "property_owner",
  "investor",
  "capital_partner",
];

function roleLabel(role: string): string {
  const words = ROLES[role] ?? role.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** People in the owner's order: client, client contact, vendors, referring agent, listing side, then any other party. */
function rank(role: string): number {
  if (role === "client_contact") return 0;
  if (!NOT_VENDOR.includes(role)) return 1;
  if (role === "referring_agent") return 2;
  return role === "listing_agent" || role === "listing_side" ? 3 : 4;
}

export function dealPeople(deal: PeopleDeal, parties: readonly Party[]): Person[] {
  const client = deal.client_name?.trim();
  const people: Person[] = client
    ? [
        {
          name: client,
          role: "Client",
          href: deal.client_id ? `/clients?record=${encodeURIComponent(deal.client_id)}` : "",
        },
      ]
    : [];
  const seen = new Set<string>();
  const listed = parties
    .filter((party) => !party.actor && party.name.trim())
    .map((party, order) => ({ party, order, place: rank(party.role) }))
    .sort((left, right) => left.place - right.place || left.order - right.order);
  for (const { party, place } of listed) {
    const person = {
      name: party.name.trim(),
      role: roleLabel(party.role),
      href: place === 1 && party.party_id ? `/vendors?record=${encodeURIComponent(party.party_id)}` : "",
    };
    const key = `${person.name}|${person.role}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(person);
  }
  return people;
}

function isParty(value: unknown): value is Party {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    typeof value.role === "string" &&
    "name" in value &&
    typeof value.name === "string"
  );
}

export function dealPeopleHtml(deal: PeopleDeal, parties: unknown): string {
  const rows = dealPeople(deal, Array.isArray(parties) ? parties.filter(isParty) : [])
    .map(({ name, role, href }) => {
      const label = `<span class="deal-person-name">${esc(name)}</span> <span class="deal-person-role">${esc(role)}</span>`;
      return `<li>${href ? `<a href="${esc(href)}">${label}</a>` : label}</li>`;
    })
    .join("");
  return `<section class="deal-side-tile deal-people" aria-labelledby="deal-people-heading"><h2 id="deal-people-heading">People</h2>${
    rows ? `<ul>${rows}</ul>` : "<p>No one recorded on this deal.</p>"
  }</section>`;
}

function isInvoice(value: unknown): value is DealInvoice {
  return typeof value === "object" && value !== null && "payments" in value && Array.isArray(value.payments);
}

/** The three marks, or one line before any happens or once every payment is in. */
export function dealInvoiceHtml(invoice: unknown, dateWords: (day: string) => string): string {
  if (!isInvoice(invoice)) return "";
  const { trigger, triggered_on, payments } = invoice;
  // Payments invoiced or paid on the same day show that day once.
  const days = (key: keyof Payment) =>
    [...new Set(payments.map((payment) => payment[key]).filter((day): day is string => !!day))].sort();
  const paid = days("paid_on");
  const sent = days("sent_on");
  const head = (line: string) =>
    `<section class="deal-side-tile deal-invoice" aria-labelledby="deal-invoice-heading"><h2 id="deal-invoice-heading">Invoice</h2>${line}`;
  if (payments.length && payments.every((payment) => payment.paid_on))
    return `${head(`<p>Invoice paid on ${esc(dateWords(paid.at(-1) ?? ""))}</p>`)}</section>`;
  const waiting = !triggered_on && !sent.length;
  const mark = (label: string, days: string[]) =>
    `<div><dt>${label}</dt>${days.length ? days.map((day) => `<dd>${esc(dateWords(day))}</dd>`).join("") : "<dd>Not yet</dd>"}</div>`;
  const line = waiting && trigger ? `<p>Goes out when ${GOES_OUT[trigger]}</p>` : "";
  return `${head(line)}<dl class="deal-invoice-marks">${mark("Triggered", triggered_on ? [triggered_on] : [])}${mark("Sent", sent)}${mark("Paid", paid)}</dl></section>`;
}
