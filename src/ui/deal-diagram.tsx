import { createContext, type ReactNode, type Ref, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Partner = "joe" | "dell";
interface Role {
  role: string;
  label: string;
}
// One deal of the engine's client deals read, GET /api/engine/clients/{id}/deals.
export interface ClientDeal {
  id: string;
  name: string;
  phase: string | null;
  phase_label: string | null;
  open: boolean;
  closed_on: string | null;
  owner: Partner;
  vendors: { party_id: string; name: string; roles: Role[]; introduction_id: string | null }[];
  introductions: {
    id: string;
    vendor_id: string;
    vendor_name: string;
    made_by: "vendor" | "team";
    introduced_by: Partner | null;
    introduced_party_id: string;
    introduced_party_name: string;
    introduced_on: string | null;
    note: string | null;
    chosen: boolean;
  }[];
}

interface Vendor {
  id: string;
  name: string;
  role: string | null;
  chosen: boolean;
  introducedOn: string | null;
}
interface Referral extends Vendor {
  referred: string;
}
type Introducer = Partner | "unrecorded";
export interface DiagramClient {
  id: string;
  name: string;
}

function treeOf(client: DiagramClient, deal: ClientDeal) {
  const roles = new Map(deal.vendors.map((v) => [v.party_id, v.roles.map((r) => r.label).join(", ")]));
  const vendor = (id: string, name: string, chosen: boolean, introducedOn: string | null = null): Vendor => ({
    id,
    name,
    role: roles.get(id) ?? null,
    chosen,
    introducedOn,
  });
  const referredBy = new Map<string, Referral>();
  const introducedFor = new Map<Introducer, Map<string, Vendor>>();
  for (const intro of deal.introductions) {
    const box = vendor(intro.vendor_id, intro.vendor_name, intro.chosen, intro.introduced_on);
    if (intro.made_by === "vendor") {
      const referred = intro.introduced_party_id === client.id ? "this client" : intro.introduced_party_name;
      referredBy.set(box.id, { ...box, referred });
      continue;
    }
    const by = intro.introduced_by ?? "unrecorded";
    introducedFor.set(by, (introducedFor.get(by) ?? new Map()).set(box.id, box));
  }
  const list = (by: Introducer) => [...(introducedFor.get(by)?.values() ?? [])];
  return {
    referredBy: [...referredBy.values()],
    introducedFor: list,
    notRecorded: deal.vendors.filter((v) => v.introduction_id === null).map((v) => vendor(v.party_id, v.name, true)),
  };
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dated = (verb: string, on: string | null) => on && `${verb} ${DAY.format(new Date(on))}`;

// The opened view: dates under each name, and every introduced vendor laid out.
const Large = createContext(false);

type Mark = "chosen" | "introduced" | "onDeal";
const WORD: Record<Mark, string> = { chosen: "Chosen", introduced: "Introduced", onDeal: "On the deal" };
type Line = "chosen" | "plain" | "dashed";
const INTRODUCER_NAME: Record<Introducer, string> = { joe: "Joe", dell: "Dell", unrecorded: "Not recorded" };
const withRole = (role: string | null, word: ReactNode) => (
  <>
    {role && `${role} · `}
    {word}
  </>
);

function Glyph({ mark }: { mark: Mark | "referred" }) {
  return (
    <svg className="deal-diagram-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {mark === "introduced" ? (
        <circle cx="8" cy="8" r="6" />
      ) : mark === "referred" ? (
        <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
      ) : (
        <>
          <circle cx="8" cy="8" r="7" className="deal-diagram-fill" />
          <path d="m5 8.2 2 2 4-4.2" />
        </>
      )}
    </svg>
  );
}

interface BoxProps {
  tone: string;
  lead: ReactNode;
  name: string;
  caption: ReactNode;
  detail?: string | null | undefined;
  trail?: ReactNode;
  boxRef?: Ref<HTMLDivElement> | undefined;
}

function Box({ tone, lead, name, caption, detail, trail, boxRef }: BoxProps) {
  return (
    <div className="deal-diagram-box" data-tone={tone} ref={boxRef} tabIndex={boxRef ? -1 : undefined}>
      {lead}
      <span className="deal-diagram-text">
        <b>{name}</b>
        <span>{caption}</span>
        {detail && <span className="deal-diagram-date">{detail}</span>}
      </span>
      {trail}
    </div>
  );
}

function VendorBox({
  vendor,
  mark,
  trail,
  boxRef,
}: {
  vendor: Vendor;
  mark: Mark;
  trail?: ReactNode;
  boxRef?: Ref<HTMLDivElement> | undefined;
}) {
  const caption = withRole(vendor.role, <span className="deal-diagram-word">{WORD[mark]}</span>);
  const detail = useContext(Large) ? dated("Introduced", vendor.introducedOn) : null;
  return (
    <Box
      tone={mark}
      lead={<Glyph mark={mark} />}
      name={vendor.name}
      caption={caption}
      detail={detail}
      trail={trail}
      boxRef={boxRef}
    />
  );
}

function Branch({ line, children }: { line: Line; children: ReactNode }) {
  return <li data-line={line}>{children}</li>;
}

// Introduced vendors nobody chose sit stacked like a solitaire pile until a partner fans them out.
function Vendors({ vendors }: { vendors: Vendor[] }) {
  const [fanned, setFanned] = useState(useContext(Large));
  const chosen = vendors.filter((vendor) => vendor.chosen);
  const passed = vendors.filter((vendor) => !vendor.chosen);
  const [top] = passed;
  const stacked = top && passed.length > 1 && !fanned;
  const pile = useRef<HTMLButtonElement>(null);
  const firstFanned = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  // The button a partner pressed unmounts, so hand focus to the control that replaces it.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (fanned ? firstFanned : pile).current?.focus();
  }, [fanned]);
  const toggle = (next: boolean) => {
    moveFocus.current = true;
    setFanned(next);
  };
  return (
    <>
      {chosen.map((vendor) => (
        <Branch key={vendor.id} line="chosen">
          <VendorBox vendor={vendor} mark="chosen" />
        </Branch>
      ))}
      {stacked ? (
        <Branch line="plain">
          <button
            type="button"
            className="deal-diagram-pile"
            data-depth={Math.min(passed.length - 1, 2)}
            aria-expanded="false"
            aria-label={`Show all ${passed.length} introduced vendors, starting with ${[top.name, top.role, "introduced"].filter(Boolean).join(", ")}`}
            ref={pile}
            onClick={() => toggle(true)}
          >
            <VendorBox
              vendor={top}
              mark="introduced"
              trail={<span className="deal-diagram-count">+{passed.length - 1}</span>}
            />
          </button>
        </Branch>
      ) : (
        passed.map((vendor, index) => (
          <Branch key={vendor.id} line="plain">
            <VendorBox vendor={vendor} mark="introduced" boxRef={index === 0 ? firstFanned : undefined} />
          </Branch>
        ))
      )}
      {fanned && passed.length > 1 && (
        <li data-line="plain" className="deal-diagram-restack">
          <button type="button" aria-expanded="true" onClick={() => toggle(false)}>
            Stack the {passed.length} introduced
          </button>
        </li>
      )}
    </>
  );
}

function IntroducerBranch({ by, label, vendors }: { by: Introducer; label: string; vendors: Vendor[] }) {
  const lead = by !== "unrecorded" && (
    <span className="deal-diagram-initial" aria-hidden="true">
      {INTRODUCER_NAME[by][0]}
    </span>
  );
  return (
    <Branch line="plain">
      <Box tone="person" lead={lead} name={INTRODUCER_NAME[by]} caption={label} />
      {vendors.length > 0 && (
        <ul>
          <Vendors vendors={vendors} />
        </ul>
      )}
    </Branch>
  );
}

interface DiagramProps {
  client: DiagramClient;
  deal: ClientDeal;
}

export function DealDiagram({ client, deal, large = false }: DiagramProps & { large?: boolean }) {
  const { referredBy, introducedFor, notRecorded } = treeOf(client, deal);
  const others = (["joe", "dell", "unrecorded"] as const).filter((by) => by !== deal.owner);
  return (
    <Large.Provider value={large}>
      <div className="deal-diagram" data-size={large ? "large" : undefined}>
        <Box tone="client" lead={null} name={client.name} caption="Client" />
        <ul>
          {referredBy.map((vendor) => (
            <Branch key={vendor.id} line="plain">
              <Box
                tone="person"
                lead={<Glyph mark="referred" />}
                name={vendor.name}
                caption={withRole(vendor.role, `Referred ${vendor.referred}`)}
                detail={large ? dated("Referred", vendor.introducedOn) : null}
              />
            </Branch>
          ))}
          <IntroducerBranch by={deal.owner} label="Deal owner" vendors={introducedFor(deal.owner)} />
          {others.map(
            (by) =>
              introducedFor(by).length > 0 && (
                <IntroducerBranch key={by} by={by} label="Introduced" vendors={introducedFor(by)} />
              ),
          )}
          {notRecorded.length > 0 && (
            <li data-line="dashed" className="deal-diagram-junction">
              <span>Brought in by: not recorded</span>
              <ul data-line="dashed">
                {notRecorded.map((vendor) => (
                  <Branch key={vendor.id} line="dashed">
                    <VendorBox vendor={vendor} mark="onDeal" />
                  </Branch>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
    </Large.Provider>
  );
}

export function mountDealDiagram(host: HTMLElement, props: DiagramProps) {
  const root = createRoot(host);
  flushSync(() => root.render(<DealDiagram {...props} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
