import { useEffect, useRef, useState } from "react";
import { type ClientDeal, dated, type Role, type Vendor } from "./deal-diagram.tsx";

// `done` counts the roles a multi-role save had already landed when it stopped.
export type Saved = { ok: true } | { ok: false; problem?: { error?: string }; done?: number };
export interface FoundVendor {
  id: string;
  name: string;
}
// A partner's introduction of the client to a vendor, for the deal it led to.
interface NewIntroduction {
  vendor_id: string;
  introduced_by: ClientDeal["owner"];
  introduced_party_id: string;
  introduced_on: string;
  deal_id: string;
}
// The engine's deal party and introduction doors and the vendor card, as the page reaches them.
export interface VendorDoors {
  add(deal: string, party: string, role: string): Promise<Saved>;
  introduce(introduction: NewIntroduction): Promise<Saved>;
  findVendors(query: string, signal: AbortSignal): Promise<FoundVendor[]>;
  remove(deal: string, party: string, role: string): Promise<Saved>;
  // Every vendor category, the roles a vendor can hold on a deal.
  roles(signal: AbortSignal): Promise<Role[]>;
  vendorHref(party: string): string;
  openVendor(party: string): void;
}
export interface Removal {
  deal: ClientDeal;
  vendor: Vendor;
}

const PARTNER = { joe: "Joe", dell: "Dell" } as const;
const REFUSALS: Record<string, string> = {
  not_found: "That vendor isn't on this deal anymore.",
  database_refused_the_statement: "The database turned this down. They may already be on the deal in that role.",
};

export function refusal(problem: { error?: string } = {}) {
  return REFUSALS[problem.error ?? ""] ?? "This wasn't saved. Try again.";
}

// Sends one save per role, stopping at the first refusal.
export async function eachRole(roles: Role[], save: (role: string) => Promise<Saved>): Promise<Saved> {
  // eslint-disable-next-line no-restricted-syntax -- Only one save per role the vendor holds on this deal, no retries.
  for (const [done, { role }] of roles.entries()) {
    const saved = await save(role);
    if (!saved.ok) return { ...saved, done };
  }
  return { ok: true };
}

function introduced({ introduction }: Vendor) {
  if (!introduction) return "Brought in by: not recorded";
  const who = introduction.introduced_by ? PARTNER[introduction.introduced_by] : "the team";
  return `${dated("Introduced", introduction.introduced_on) || "Introduced"} by ${who}.`;
}

type Step = { at: "menu" } | { at: "role"; roles: Role[] | null; role: string } | { at: "confirm" };

interface Props {
  deal: ClientDeal;
  vendor: Vendor;
  doors: VendorDoors;
  close: () => void;
  // A save landed; a removal carries what Undo puts back.
  saved: (removal?: Removal) => void;
  // A save failed after some of it may have landed, so the diagram reads the deal again.
  reread: () => void;
}

export function DealVendorMenu({ deal, vendor, doors, close, saved, reread }: Props) {
  const [step, setStep] = useState<Step>({ at: "menu" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const picking = step.at === "role";
  // Each step, and the roles arriving, hands focus to its first control.
  const focusKey = picking ? `role:${Boolean(step.roles)}` : step.at;
  useEffect(() => {
    if (focusKey) panel.current?.querySelector<HTMLElement>("select:enabled, button, a")?.focus();
  }, [focusKey]);
  useEffect(() => {
    if (!picking) return;
    const controller = new AbortController();
    doors.roles(controller.signal).then(
      (roles) => controller.signal.aborted || setStep((now) => (now.at === "role" ? { ...now, roles } : now)),
      () => controller.signal.aborted || setProblem("The roles couldn't load. Try again."),
    );
    return () => controller.abort();
  }, [doors, picking]);
  async function run(save: () => Promise<Saved>, removal?: Removal) {
    setBusy(true);
    setProblem("");
    const answer = await save().catch((): Saved => ({ ok: false }));
    setBusy(false);
    if (!answer.ok) {
      reread();
      return setProblem(
        `${refusal(answer.problem)}${answer.done ? ` ${answer.done} of ${vendor.roles.length} roles were removed.` : ""}`,
      );
    }
    close();
    saved(removal);
  }
  const onDeal = vendor.roles.length > 0;
  const role = vendor.roles.map((r) => r.label).join(", ");
  return (
    <div
      className="deal-vendor-menu"
      role="dialog"
      aria-label={`${vendor.name} on ${deal.name}`}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
    >
      <p className="deal-vendor-menu-who">
        {vendor.name}
        {role && ` · ${role}`}
        <span>{introduced(vendor)}</span>
        {vendor.introduction?.note && <q>{vendor.introduction.note}</q>}
      </p>
      {step.at === "menu" && (
        <>
          {!vendor.chosen && (
            <button type="button" onClick={() => setStep({ at: "role", roles: null, role: "" })}>
              Mark chosen
            </button>
          )}
          <a
            href={doors.vendorHref(vendor.id)}
            onClick={(event) => {
              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              doors.openVendor(vendor.id);
            }}
          >
            Open {vendor.name}
          </a>
          {onDeal && (
            <button type="button" onClick={() => setStep({ at: "confirm" })}>
              Remove from this deal
            </button>
          )}
        </>
      )}
      {step.at === "role" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => doors.add(deal.id, vendor.id, step.role));
          }}
        >
          <label>
            Chosen as
            <select
              value={step.role}
              disabled={!step.roles}
              onChange={(event) => setStep({ ...step, role: event.target.value })}
            >
              <option value="" disabled>
                {step.roles ? "Pick a role" : "Loading roles…"}
              </option>
              {step.roles?.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <span className="deal-vendor-menu-row">
            <button type="submit" disabled={busy || !step.role}>
              Mark chosen
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {step.at === "confirm" && (
        <>
          <p>
            Remove {vendor.name} from {deal.name}?
          </p>
          <span className="deal-vendor-menu-row">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => eachRole(vendor.roles, (r) => doors.remove(deal.id, vendor.id, r)), { deal, vendor })
              }
            >
              Remove
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </span>
        </>
      )}
      {problem && (
        <p className="deal-vendor-menu-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
