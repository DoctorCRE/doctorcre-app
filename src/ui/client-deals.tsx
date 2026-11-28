import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AddVendor } from "./deal-add-vendor.tsx";
import { type ClientDeal, DealDiagram, type DiagramClient, type VendorMenu } from "./deal-diagram.tsx";
import { DealVendorMenu, eachRole, type Removal, refusal, type Saved, type VendorDoors } from "./deal-vendor-menu.tsx";

type Read<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };
export interface CardSectionProps<T> {
  subject: DiagramClient;
  load: (signal: AbortSignal) => Promise<T>;
  // The opened view paints here, and the table beside it steps aside while it has content.
  stage: HTMLElement;
  // Present when the partner can change who is on a deal; without it the vendor boxes are labels.
  doors?: VendorDoors | null;
}
// Undo after a removal stays this long (ruling 98).
const UNDO_MS = 3_000;

// One read per card open; retry starts the next.
export function useRead<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [read, setRead] = useState<Read<T>>({ state: "loading" });
  const loading = read.state === "loading";
  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => controller.signal.aborted || setRead({ state: "ready", value }),
      () => controller.signal.aborted || setRead({ state: "failed" }),
    );
    return () => controller.abort();
  }, [load, loading]);
  const reread = useRef<AbortController | null>(null);
  useEffect(() => () => reread.current?.abort(), []);
  // Reads again in place, keeping what is on screen, so a box changes state without a blank.
  const refresh = () => {
    reread.current?.abort();
    const controller = new AbortController();
    reread.current = controller;
    load(controller.signal).then(
      (value) => controller.signal.aborted || setRead({ state: "ready", value }),
      () => {},
    );
  };
  return [read, () => setRead({ state: "loading" }), refresh] as const;
}

export function OpenControl({
  label,
  expanded,
  opener,
  open,
}: {
  label: string;
  expanded: boolean;
  opener: Ref<HTMLButtonElement>;
  open: () => void;
}) {
  return (
    <button
      type="button"
      className="client-deal-control client-deal-open"
      aria-label={label}
      aria-expanded={expanded}
      ref={opener}
      onClick={open}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
      </svg>
    </button>
  );
}

export function OpenedFrame({
  label,
  title,
  close,
  children,
}: {
  label: string;
  title: ReactNode;
  close: () => void;
  children: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus(), []);
  return (
    <section className="client-deal-opened" aria-label={label}>
      <header className="client-deal-head">
        {title}
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
      {children}
    </section>
  );
}

export function mountCardSection<T>(
  host: HTMLElement,
  Section: (props: CardSectionProps<T>) => ReactNode,
  props: CardSectionProps<T>,
) {
  const root = createRoot(host);
  const render = (next: CardSectionProps<T>) => flushSync(() => root.render(<Section {...next} />));
  render(props);
  return {
    update: (subject: DiagramClient) => render({ ...props, subject }),
    dispose: () => flushSync(() => root.unmount()),
  };
}

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

function ClientDeals({ subject: client, load, stage, doors = null }: CardSectionProps<ClientDeal[]>) {
  const [read, retry, refresh] = useRead(load);
  const [opened, setOpened] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const openers = useRef(new Map<string, HTMLButtonElement>());
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
        client={client.id}
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
  if (read.state === "loading" || (read.state === "ready" && read.value.length === 0)) return null;
  const deals = read.state === "ready" ? read.value : [];
  const openedDeal = deals.find((deal) => deal.id === opened);
  const close = () => {
    setOpened(null);
    if (opened) openers.current.get(opened)?.focus();
  };
  return (
    <>
      <h3>Deals</h3>
      {read.state === "failed" && (
        <p className="record-note">
          Couldn't load deals.{" "}
          <button type="button" className="client-deals-retry" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      {deals.map((deal) => (
        <article key={deal.id} className="client-deal">
          <header className="client-deal-head">
            <DealTitle deal={deal} />
            <OpenControl
              label={`Open ${deal.name} large`}
              expanded={opened === deal.id}
              opener={(node) => {
                if (node) openers.current.set(deal.id, node);
                else openers.current.delete(deal.id);
              }}
              open={() => setOpened(deal.id)}
            />
          </header>
          {removed
            .filter((r) => r.deal.id === deal.id)
            .map((r) => (
              <Undo key={r.vendor.id} removed={r} expire={forget} undo={undo} />
            ))}
          <DealDiagram client={client} deal={deal} menu={menuFor(deal)} />
          {doors && <AddVendor client={client} deal={deal} doors={doors} saved={refresh} />}
        </article>
      ))}
      {openedDeal &&
        createPortal(
          <OpenedFrame label={openedDeal.name} title={<DealTitle deal={openedDeal} />} close={close}>
            <DealDiagram client={client} deal={openedDeal} menu={menuFor(openedDeal)} large />
          </OpenedFrame>,
          stage,
        )}
    </>
  );
}

export const mountClientDeals = (host: HTMLElement, props: CardSectionProps<ClientDeal[]>) =>
  mountCardSection(host, ClientDeals, props);
