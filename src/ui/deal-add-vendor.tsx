import { useEffect, useRef, useState } from "react";
import { centralToday } from "./central-time.ts";
import type { ClientDeal, DiagramClient, Role } from "./deal-diagram.tsx";
import { type FoundVendor, refusal, type Saved, type VendorDoors } from "./deal-vendor-menu.tsx";

type BroughtBy = ClientDeal["owner"] | "unrecorded";
const BROUGHT_BY: [BroughtBy, string][] = [
  ["dell", "Dell"],
  ["joe", "Joe"],
  ["unrecorded", "Not recorded"],
];

interface Props {
  client: DiagramClient;
  deal: ClientDeal;
  doors: VendorDoors;
  // A save landed, or may have partly landed, so the diagram reads the deal again.
  saved: () => void;
}

export function AddVendor(props: Props) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  return (
    <>
      <button
        type="button"
        className="client-deal-add"
        aria-expanded={open}
        ref={opener}
        onClick={() => setOpen(!open)}
      >
        + Add vendor
      </button>
      {open && <AddVendorForm {...props} close={close} />}
    </>
  );
}

function useVendorSearch(doors: VendorDoors, query: string, skip: Set<string>) {
  const [found, setFound] = useState<FoundVendor[] | null>(null);
  const [failed, setFailed] = useState(false);
  const term = query.trim();
  useEffect(() => {
    setFound(null);
    setFailed(false);
    if (!term) return;
    const controller = new AbortController();
    doors.findVendors(term, controller.signal).then(
      (vendors) => controller.signal.aborted || setFound(vendors),
      () => controller.signal.aborted || setFailed(true),
    );
    return () => controller.abort();
  }, [doors, term]);
  return { found: found?.filter((vendor) => !skip.has(vendor.id)) ?? null, failed };
}

function AddVendorForm({ client, deal, doors, saved, close }: Props & { close: () => void }) {
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<FoundVendor | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [role, setRole] = useState("");
  const [by, setBy] = useState<BroughtBy | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // A vendor whose introduction already landed, so trying again never records it twice.
  const introduced = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  // A vendor already on this deal, or introduced for it, is changed from its own box.
  const [onDeal] = useState(
    () => new Set([...deal.vendors.map((v) => v.party_id), ...deal.introductions.map((i) => i.vendor_id)]),
  );
  const { found, failed } = useVendorSearch(doors, vendor ? "" : query, onDeal);
  useEffect(() => {
    if (!vendor) search.current?.focus();
  }, [vendor]);
  useEffect(() => {
    const controller = new AbortController();
    doors.roles(controller.signal).then(
      (list) => controller.signal.aborted || setRoles(list),
      () => controller.signal.aborted || setProblem("The roles couldn't load. Try again."),
    );
    return () => controller.abort();
  }, [doors]);
  async function save(picked: FoundVendor, brought: BroughtBy): Promise<Saved> {
    if (brought !== "unrecorded" && introduced.current !== picked.id) {
      const introduction = await doors.introduce({
        vendor_id: picked.id,
        introduced_by: brought,
        introduced_party_id: client.id,
        introduced_on: centralToday(new Date()),
        deal_id: deal.id,
      });
      if (!introduction.ok) return introduction;
      introduced.current = picked.id;
    }
    return doors.add(deal.id, picked.id, role);
  }
  async function add() {
    if (!vendor || !role || !by) return;
    setBusy(true);
    setProblem("");
    const answer = await save(vendor, by).catch((): Saved => ({ ok: false }));
    setBusy(false);
    saved();
    if (answer.ok) return close();
    const landed = introduced.current === vendor.id ? ` ${vendor.name} is recorded as introduced, not yet on the deal.` : "";
    setProblem(`${refusal(answer.problem)}${landed}`);
  }
  return (
    <form
      className="deal-add-vendor"
      aria-label={`Add a vendor to ${deal.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
    >
      {vendor ? (
        <p className="deal-add-vendor-picked">
          <b>{vendor.name}</b>
          <button type="button" onClick={() => setVendor(null)}>
            Change
          </button>
        </p>
      ) : (
        <label>
          Find a vendor
          <input type="search" value={query} ref={search} onChange={(event) => setQuery(event.target.value)} />
        </label>
      )}
      {!vendor && (found || failed) && (
        <ul className="deal-add-vendor-found">
          {failed && <li>Vendors couldn't load. Try again.</li>}
          {found?.length === 0 && <li>No vendor by that name.</li>}
          {found?.map((match) => (
            <li key={match.id}>
              <button type="button" onClick={() => setVendor(match)}>
                {match.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        Role
        <select value={role} disabled={!roles} onChange={(event) => setRole(event.target.value)}>
          <option value="" disabled>
            {roles ? "Pick a role" : "Loading roles…"}
          </option>
          {roles?.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Who brought them in</legend>
        {BROUGHT_BY.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={by === key} onClick={() => setBy(key)}>
            {label}
          </button>
        ))}
      </fieldset>
      <span className="deal-vendor-menu-row">
        <button type="submit" disabled={busy || !vendor || !role || !by}>
          Add
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </span>
      {problem && (
        <p className="deal-vendor-menu-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
