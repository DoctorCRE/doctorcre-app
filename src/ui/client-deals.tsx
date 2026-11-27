import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type ClientDeal, DealDiagram, type DiagramClient } from "./deal-diagram.tsx";

type Deals = { state: "loading" } | { state: "failed" } | { state: "ready"; deals: ClientDeal[] };
interface Props {
  client: DiagramClient;
  load: (signal: AbortSignal) => Promise<ClientDeal[]>;
  // The opened view paints here, and the table beside it steps aside while it has content.
  stage: HTMLElement;
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

function OpenedDeal({ client, deal, close }: { client: DiagramClient; deal: ClientDeal; close: () => void }) {
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
      <DealDiagram client={client} deal={deal} large />
    </section>
  );
}

function ClientDeals({ client, load, stage }: Props) {
  const [deals, setDeals] = useState<Deals>({ state: "loading" });
  const [opened, setOpened] = useState<string | null>(null);
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
            <DealDiagram client={client} deal={deal} />
          </article>
        ))}
      {openedDeal && createPortal(<OpenedDeal client={client} deal={openedDeal} close={close} />, stage)}
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
