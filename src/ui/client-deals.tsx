import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type ClientDeal, DealDiagram, type DiagramClient, type VendorMenu } from "./deal-diagram.tsx";
import { DealVendorMenu, eachRole, type Removal, refusal, type Saved, type VendorDoors } from "./deal-vendor-menu.tsx";

type Deals = { state: "loading" } | { state: "failed" } | { state: "ready"; deals: ClientDeal[] };
interface Props {
  client: DiagramClient;
  load: (signal: AbortSignal) => Promise<ClientDeal[]>;
  // The opened view paints here, and the table beside it steps aside while it has content.
  stage: HTMLElement;
  // Present when the partner can change who is on a deal; without it the vendor boxes are labels.
  doors?: VendorDoors | null;
}
// Undo after a removal stays this long (ruling 98).
const UNDO_MS = 3_000;

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const dealState = (deal: ClientDeal) =>
  deal.open || !deal.closed_on ? deal.phase_label : `Closed ${MONTH.format(new Date(deal.closed_on))}`;

function DealTitle({ deal }: { deal: ClientDeal }) {
  return (
    <>
      <a href={`/deals?deal=${encodeURIComponent(deal.id)}`} title={deal.name}>
        {deal.name}
      </a>
      {dealState(deal) && <span>{dealState(deal)}</span>}
    </>
  );
}

type Removed = Removal & { problem?: string };
// Each removal keeps its own Undo window, so a second removal never drops the first's Undo.
function Undo({
  removed,
  expire,
  undo,
}: {
  removed: Removed;
  expire: (r: Removed) => void;
  undo: (r: Removed) => void;
}) {
  useEffect(() => {
    if (removed.problem) return;
    // eslint-disable-next-line no-restricted-syntax -- One Undo window per removal, cleared when it ends or unmounts.
    const timer = window.setTimeout(() => expire(removed), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removed, expire]);
  return (
    <p className="client-deal-undo" role="status">
      {removed.problem ?? `Removed ${removed.vendor.name} from ${removed.deal.name}.`}{" "}
      <button type="button" onClick={() => undo(removed)}>
        Undo
      </button>
    </p>
  );
}

type Opened = { client: DiagramClient; deal: ClientDeal; menu: VendorMenu | null; close: () => void };
function OpenedDeal({ client, deal, menu, close }: Opened) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus(), []);
  return (
    <section className="client-deal-opened" aria-label={deal.name}>
      <header className="client-deal-head">
        <DealTitle deal={deal} />
        <button
          type="button"
          className="client-deal-control"
          aria-label="Back to the table"
          ref={closeButton}
          onClick={close}
        >
          ×
        </button>
      </header>
      <DealDiagram client={client} deal={deal} menu={menu} large />
    </section>
  );
}

function ClientDeals({ client, load, stage, doors = null }: Props) {
  const [deals, setDeals] = useState<Deals>({ state: "loading" });
  const [opened, setOpened] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const reread = useRef<AbortController | null>(null);
  useEffect(() => () => reread.current?.abort(), []);
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const loading = deals.state === "loading";
  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    load(controller.signal).then(
      (list) => controller.signal.aborted || setDeals({ state: "ready", deals: list }),
      () => controller.signal.aborted || setDeals({ state: "failed" }),
    );
    return () => controller.abort();
  }, [load, loading]);
  // After a save the diagrams read the client's deals again, in place, so a box changes state without a blank.
  function refresh() {
    reread.current?.abort();
    const controller = new AbortController();
    reread.current = controller;
    load(controller.signal).then(
      (list) => controller.signal.aborted || setDeals({ state: "ready", deals: list }),
      () => {},
    );
  }
  const forget = useCallback((gone: Removed) => setRemoved((now) => now.filter((r) => r !== gone)), []);
  async function undo(gone: Removed) {
    if (!doors) return;
    const { deal, vendor } = gone;
    forget(gone);
    const answer = await eachRole(vendor.roles, (role) => doors.add(deal.id, vendor.id, role)).catch(
      (): Saved => ({ ok: false }),
    );
    if (!answer.ok)
      setRemoved((now) => [...now, { ...gone, problem: `${vendor.name} wasn't put back. ${refusal(answer.problem)}` }]);
    refresh();
  }
  const menuFor = (deal: ClientDeal): VendorMenu | null =>
    doors &&
    ((vendor, close) => (
      <DealVendorMenu
        deal={deal}
        vendor={vendor}
        doors={doors}
        close={close}
        reread={refresh}
        saved={(removal) => {
          if (removal) setRemoved((now) => [...now, removal]);
          refresh();
        }}
      />
    ));
  if (deals.state === "loading" || (deals.state === "ready" && deals.deals.length === 0)) return null;
  const openedDeal = deals.state === "ready" ? deals.deals.find((deal) => deal.id === opened) : undefined;
  const close = () => {
    setOpened(null);
    if (opened) openers.current.get(opened)?.focus();
  };
  return (
    <>
      <h3>Deals</h3>
      {deals.state === "failed" && (
        <p className="record-note">
          Couldn't load deals.{" "}
          <button type="button" className="client-deals-retry" onClick={() => setDeals({ state: "loading" })}>
            Try again
          </button>
        </p>
      )}
      {deals.state === "ready" &&
        deals.deals.map((deal) => (
          <article key={deal.id} className="client-deal">
            <header className="client-deal-head">
              <DealTitle deal={deal} />
              <button
                type="button"
                className="client-deal-control client-deal-open"
                aria-label={`Open ${deal.name} large`}
                aria-expanded={opened === deal.id}
                ref={(node) => {
                  if (node) openers.current.set(deal.id, node);
                  else openers.current.delete(deal.id);
                }}
                onClick={() => setOpened(deal.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
                </svg>
              </button>
            </header>
            {removed
              .filter((r) => r.deal.id === deal.id)
              .map((r) => (
                <Undo key={r.vendor.id} removed={r} expire={forget} undo={undo} />
              ))}
            <DealDiagram client={client} deal={deal} menu={menuFor(deal)} />
          </article>
        ))}
      {openedDeal &&
        createPortal(<OpenedDeal client={client} deal={openedDeal} menu={menuFor(openedDeal)} close={close} />, stage)}
    </>
  );
}

export function mountClientDeals(host: HTMLElement, props: Props) {
  const root = createRoot(host);
  const render = (next: Props) => flushSync(() => root.render(<ClientDeals {...next} />));
  render(props);
  return {
    update: (client: DiagramClient) => render({ ...props, client }),
    dispose: () => flushSync(() => root.unmount()),
  };
}
