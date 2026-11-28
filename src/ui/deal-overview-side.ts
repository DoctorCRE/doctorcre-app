type Payment = { sent_on: string | null; paid_on: string | null };
export type DealInvoice = {
  trigger: "lease_signed" | "purchase_closed" | null;
  triggered_on: string | null;
  payments: Payment[];
};
type Vendor = {
  role?: string;
  party_id?: string;
  company?: { name?: string } | null;
  contact?: { name?: string } | null;
};
export type PeopleDeal = { client_id?: string | null; client_name?: string | null; vendors?: Vendor[] };
type Person = { name: string; role: string; href: string };

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const ROLES: Record<string, string> = { landlord_rep: "Landlord's broker" };
const GOES_OUT = { lease_signed: "the lease is signed", purchase_closed: "the purchase closes" } as const;

function roleLabel(role = ""): string {
  const words = ROLES[role] ?? role.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Vendor";
}

export function dealPeople(deal: PeopleDeal): Person[] {
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
  for (const vendor of deal.vendors ?? []) {
    const name = vendor.contact?.name?.trim() || vendor.company?.name?.trim();
    const role = roleLabel(vendor.role);
    const key = `${name}|${role}`.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    people.push({ name, role, href: vendor.party_id ? `/vendors?record=${encodeURIComponent(vendor.party_id)}` : "" });
  }
  return people;
}

export function dealPeopleHtml(deal: PeopleDeal): string {
  const rows = dealPeople(deal)
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
  const paid = payments.map((payment) => payment.paid_on).filter((day): day is string => !!day);
  const sent = payments.map((payment) => payment.sent_on).filter((day): day is string => !!day);
  const head = (line: string) =>
    `<section class="deal-side-tile deal-invoice" aria-labelledby="deal-invoice-heading"><h2 id="deal-invoice-heading">Invoice</h2>${line}`;
  if (payments.length && paid.length === payments.length)
    return `${head(`<p>Invoice paid on ${esc(dateWords([...paid].sort().at(-1) ?? ""))}</p>`)}</section>`;
  const waiting = !triggered_on && !sent.length;
  const mark = (label: string, days: string[]) =>
    `<div><dt>${label}</dt>${days.length ? days.map((day) => `<dd>${esc(dateWords(day))}</dd>`).join("") : "<dd>Not yet</dd>"}</div>`;
  const line = waiting && trigger ? `<p>Goes out when ${GOES_OUT[trigger]}</p>` : "";
  return `${head(line)}<dl class="deal-invoice-marks">${mark("Triggered", triggered_on ? [triggered_on] : [])}${mark("Sent", sent)}${mark("Paid", paid)}</dl></section>`;
}
