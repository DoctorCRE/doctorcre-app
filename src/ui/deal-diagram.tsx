import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
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
}
type Introducer = Partner | "unrecorded";

function treeOf(deal: ClientDeal) {
  const roles = new Map(deal.vendors.map((v) => [v.party_id, v.roles.map((r) => r.label).join(", ")]));
  const vendor = (id: string, name: string, chosen: boolean): Vendor => ({
    id,
    name,
    role: roles.get(id) ?? null,
    chosen,
  });
  const referredBy = new Map<string, Vendor>();
  const introducedBy = new Map<Introducer, Map<string, Vendor>>();
  for (const intro of deal.introductions) {
    const box = vendor(intro.vendor_id, intro.vendor_name, intro.chosen);
    if (intro.made_by === "vendor") {
      referredBy.set(box.id, box);
      continue;
    }
    const by = intro.introduced_by ?? "unrecorded";
    introducedBy.set(by, (introducedBy.get(by) ?? new Map()).set(box.id, box));
  }
  const list = (by: Introducer) => [...(introducedBy.get(by)?.values() ?? [])];
  return {
    referredBy: [...referredBy.values()],
    introducedBy: list,
    notRecorded: deal.vendors.filter((v) => v.introduction_id === null).map((v) => vendor(v.party_id, v.name, true)),
  };
}

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
  trail?: ReactNode;
  boxRef?: Ref<HTMLDivElement> | undefined;
}

function Box({ tone, lead, name, caption, trail, boxRef }: BoxProps) {
  return (
    <div className="deal-diagram-box" data-tone={tone} ref={boxRef} tabIndex={boxRef ? -1 : undefined}>
      {lead}
      <span className="deal-diagram-text">
        <b>{name}</b>
        <span>{caption}</span>
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
  return (
    <Box tone={mark} lead={<Glyph mark={mark} />} name={vendor.name} caption={caption} trail={trail} boxRef={boxRef} />
  );
}

function Branch({ line, children }: { line: Line; children: ReactNode }) {
  return <li data-line={line}>{children}</li>;
}

// Introduced vendors nobody chose sit stacked like a solitaire pile until a partner fans them out.
function Vendors({ vendors }: { vendors: Vendor[] }) {
  const [fanned, setFanned] = useState(false);
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

function DealDiagramView({ client, deal }: { client: string; deal: ClientDeal }) {
  const { referredBy, introducedBy, notRecorded } = treeOf(deal);
  const others = (["joe", "dell", "unrecorded"] as const).filter((by) => by !== deal.owner);
  return (
    <div className="deal-diagram">
      <Box tone="client" lead={null} name={client} caption="Client" />
      <ul>
        {referredBy.map((vendor) => (
          <Branch key={vendor.id} line="plain">
            <Box
              tone="person"
              lead={<Glyph mark="referred" />}
              name={vendor.name}
              caption={withRole(vendor.role, "Referred this client")}
            />
          </Branch>
        ))}
        <IntroducerBranch by={deal.owner} label="Deal owner" vendors={introducedBy(deal.owner)} />
        {others.map(
          (by) =>
            introducedBy(by).length > 0 && (
              <IntroducerBranch key={by} by={by} label="Introduced" vendors={introducedBy(by)} />
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
  );
}

export function mountDealDiagram(host: HTMLElement, props: { client: string; deal: ClientDeal }) {
  const root = createRoot(host);
  flushSync(() => root.render(<DealDiagramView {...props} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
