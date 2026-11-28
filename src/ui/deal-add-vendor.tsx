import { useEffect, useRef, useState } from "react";
import type { ClientDeal, DiagramClient, Role } from "./deal-diagram.tsx";
import {
  type BroughtBy,
  broughtBy,
  type FoundVendor,
  type RecordedSource,
  recordSource,
  refusal,
  type Saved,
  SourceChoices,
  type VendorDoors,
} from "./deal-vendor-menu.tsx";

interface Props {
  client: DiagramClient;
  deal: ClientDeal;
  doors: VendorDoors;
  // A save landed, or may have partly landed, so the diagram reads the deal again.
  saved: () => void;
}

export function AddVendor(props: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
        disabled={busy}
        ref={opener}
        onClick={() => setOpen(!open)}
      >
        + Add vendor
      </button>
      {open && <AddVendorForm {...props} close={close} busy={busy} setBusy={setBusy} />}
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

function AddVendorForm({
  client,
  deal,
  doors,
  saved,
  close,
  busy,
  setBusy,
}: Props & {
  close: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<FoundVendor | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [role, setRole] = useState("");
  const [by, setBy] = useState<BroughtBy | null>(null);
  const [problem, setProblem] = useState("");
  const [recorded, setRecorded] = useState<RecordedSource | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [correctionPending, setCorrectionPending] = useState(false);
  const correction = recorded && by && recorded.by !== by;
  const locked = busy || uncertain || Boolean(recorded);
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
  async function add() {
    if (busy || !vendor || !role || !by) return;
    setBusy(true);
    setProblem("");
    let source = recorded;
    if (source?.by !== by) {
      const result = await recordSource(doors, deal, client.id, vendor.id, by, source?.id);
      if (!result.ok) {
        setUncertain(Boolean(result.pending));
        setCorrectionPending(Boolean(correction && result.pending));
        setBusy(false);
        saved();
        setProblem(
          result.pending
            ? "Couldn’t confirm who was saved. Retry to check the earlier choice."
            : refusal(result.problem),
        );
        return;
      }
      source = result.introduction;
      setRecorded(source);
      setCorrectionPending(false);
      if (source && source.by !== by) {
        setBusy(false);
        setUncertain(false);
        saved();
        setProblem(`${broughtBy(source.by)} was saved as the source. Use the new choice to change it.`);
        return;
      }
    }
    const answer = await doors.add(deal.id, vendor.id, role).catch((): Saved => ({ ok: false, pending: true }));
    setBusy(false);
    saved();
    if (answer.ok) return close();
    setUncertain(Boolean(answer.pending));
    const message = answer.pending
      ? "Couldn’t confirm whether the vendor was put on the deal. Retry to check."
      : refusal(answer.problem);
    const landed = source ? ` ${vendor.name} is recorded as introduced by ${broughtBy(source.by)}.` : "";
    setProblem(message + landed);
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
        if (event.key !== "Escape" || busy) return;
        event.stopPropagation();
        close();
      }}
    >
      {vendor ? (
        <p className="deal-add-vendor-picked">
          <b>{vendor.name}</b>
          <button type="button" disabled={locked} onClick={() => setVendor(null)}>
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
        <select value={role} disabled={!roles || locked} onChange={(event) => setRole(event.target.value)}>
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
      <SourceChoices
        by={by}
        select={setBy}
        client={Boolean(deal.client_id)}
        unrecorded
        disabled={busy || correctionPending}
      />
      <span className="deal-vendor-menu-row">
        <button type="submit" disabled={busy || !vendor || !role || !by}>
          {correction ? "Use new choice" : uncertain ? "Retry" : "Add"}
        </button>
        <button type="button" disabled={busy} onClick={close}>
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
