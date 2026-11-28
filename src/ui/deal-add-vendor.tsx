import { useEffect, useRef, useState } from "react";
import type { ClientDeal, Role } from "./deal-diagram.tsx";
import {
  type BroughtBy,
  broughtBy,
  type FoundVendor,
  refusal,
  SourceChoices,
  sourceOf,
  type VendorActions,
  type VendorDoors,
} from "./deal-vendor-menu.tsx";

interface Props {
  deal: ClientDeal;
  doors: VendorDoors;
  actions: VendorActions;
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
  deal,
  doors,
  actions,
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
  const recorded = sourceOf(deal.introductions.find((i) => i.vendor_id === vendor?.id));
  const phase = vendor ? actions.phase(vendor.id) : "ready";
  const correction = recorded && by && recorded.by !== by;
  const roleLocked = busy || phase !== "ready";
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
    const pickedRole = roles?.find((row) => row.role === role);
    if (roleLocked || !vendor || !pickedRole || !by) return;
    setBusy(true);
    setProblem("");
    if ((recorded?.by ?? "unrecorded") !== by) {
      const result = await actions.setSource(vendor, by, recorded ?? undefined);
      if (!result.ok) {
        setBusy(false);
        setProblem(result.pending ? "Check who was saved before trying again." : refusal(result.problem));
        return;
      }
    }
    if (deal.vendors.some((row) => row.party_id === vendor.id && row.roles.some((r) => r.role === role))) {
      setBusy(false);
      return close();
    }
    const answer = await actions.add(vendor, pickedRole);
    setBusy(false);
    if (answer.ok) return close();
    const message = answer.pending
      ? "Check whether the vendor was put on the deal before trying again."
      : refusal(answer.problem);
    const landed = by === "unrecorded" ? "" : ` ${vendor.name} is recorded as introduced by ${broughtBy(by)}.`;
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
          <button type="button" disabled={roleLocked || Boolean(recorded)} onClick={() => setVendor(null)}>
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
        <select value={role} disabled={!roles || roleLocked} onChange={(event) => setRole(event.target.value)}>
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
      <SourceChoices by={by} select={setBy} client={Boolean(deal.client_id)} unrecorded disabled={roleLocked} />
      <span className="deal-vendor-menu-row">
        <button type="submit" disabled={roleLocked || !vendor || !role || !by}>
          {correction ? "Use new choice" : "Add"}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </span>
      {phase === "checking" && (
        <p role="status">
          Checking the save…{" "}
          <button type="button" onClick={actions.refresh}>
            Check again
          </button>
        </p>
      )}
      {recorded && <p>Recorded as introduced by {broughtBy(recorded.by)}.</p>}
      {problem && (
        <p className="deal-vendor-menu-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
