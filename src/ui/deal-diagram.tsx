import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Partner = "joe" | "dell";
interface Vendor {
  id: string;
  name: string;
  role: string;
}
interface IntroducedVendor extends Vendor {
  chosen: boolean;
}
export interface DealDiagram {
  client: string;
  owner: Partner;
  referredBy: Vendor[];
  introducedBy: Partial<Record<Partner, IntroducedVendor[]>>;
  clientBrought: IntroducedVendor[];
  notRecorded: Vendor[];
}

type Mark = "chosen" | "introduced" | "onDeal";
const WORD: Record<Mark, string> = { chosen: "Chosen", introduced: "Introduced", onDeal: "On the deal" };
type Line = "chosen" | "plain" | "dashed";
const PARTNER_NAME: Record<Partner, string> = { joe: "Joe", dell: "Dell" };

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
  const caption = (
    <>
      {vendor.role} · <span className="deal-diagram-word">{WORD[mark]}</span>
    </>
  );
  return (
    <Box tone={mark} lead={<Glyph mark={mark} />} name={vendor.name} caption={caption} trail={trail} boxRef={boxRef} />
  );
}

function Branch({ line, children }: { line: Line; children: ReactNode }) {
  return <li data-line={line}>{children}</li>;
}

// Introduced vendors nobody chose sit stacked like a solitaire pile until a partner fans them out.
function Vendors({ vendors }: { vendors: IntroducedVendor[] }) {
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
            aria-label={`Show all ${passed.length} introduced vendors, starting with ${top.name}, ${top.role}, introduced`}
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

function PartnerBranch({ partner, label, vendors }: { partner: Partner; label: string; vendors: IntroducedVendor[] }) {
  const lead = (
    <span className="deal-diagram-initial" aria-hidden="true">
      {PARTNER_NAME[partner][0]}
    </span>
  );
  return (
    <Branch line="plain">
      <Box tone="person" lead={lead} name={PARTNER_NAME[partner]} caption={label} />
      {vendors.length > 0 && (
        <ul>
          <Vendors vendors={vendors} />
        </ul>
      )}
    </Branch>
  );
}

function DealDiagramView({ diagram }: { diagram: DealDiagram }) {
  const { client, owner, referredBy, introducedBy, clientBrought, notRecorded } = diagram;
  const other: Partner = owner === "joe" ? "dell" : "joe";
  const otherIntroduced = introducedBy[other] ?? [];
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
              caption={`${vendor.role} · Referred this client`}
            />
          </Branch>
        ))}
        <PartnerBranch partner={owner} label="Deal owner" vendors={introducedBy[owner] ?? []} />
        {otherIntroduced.length > 0 && <PartnerBranch partner={other} label="Introduced" vendors={otherIntroduced} />}
        <Vendors vendors={clientBrought} />
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

export function mountDealDiagram(host: HTMLElement, diagram: DealDiagram) {
  const root = createRoot(host);
  flushSync(() => root.render(<DealDiagramView diagram={diagram} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
