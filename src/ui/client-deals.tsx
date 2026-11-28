import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AddVendor } from "./deal-add-vendor.tsx";
import {
  type ClientDeal,
  DealDiagram,
  type DiagramClient,
  type Introduction,
  type Role,
  type VendorMenu,
} from "./deal-diagram.tsx";
import {
  DealVendorMenu,
  eachRole,
  type FoundVendor,
  type LinkPhase,
  recordSource,
  refusal,
  type Saved,
  type VendorActions,
  type VendorDoors,
  VendorSaveStatus,
} from "./deal-vendor-menu.tsx";

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

type Undo = { roles: Role[] } & ({ kind: "offer" } | { kind: "restore"; problem?: string });

function missingRoles(link: Link, undo: Undo) {
  return undo.roles.filter((role) => !link.party?.roles.some((row) => row.role === role.role));
}

function LinkNotice({
  link,
  deal,
  check,
  restore,
}: {
  link: Link;
  deal: ClientDeal;
  check: () => void;
  restore: () => void;
}) {
  const { phase, undo, name } = link;
  if (phase !== "ready") {
    if (!undo && (link.party || link.introductions.length || phase === "saving")) return null;
    return (
      <div className="client-deal-undo">
        <span>{name}</span>
        <VendorSaveStatus phase={phase} check={check} />
      </div>
    );
  }
  if (!undo) return null;
  const canRestore = missingRoles(link, undo).length > 0;
  const message = canRestore
    ? undo.kind === "offer"
      ? `Removed ${name} from ${deal.name}.`
      : (undo.problem ?? `${name} still has roles to put back.`)
    : `${name} was put back.`;
  return (
    <p className="client-deal-undo" role="status">
      {message}
      {canRestore && (
        <>
          {" "}
          <button type="button" onClick={restore}>
            Undo
          </button>
        </>
      )}
    </p>
  );
}

type LinkValue = {
  introductions: Introduction[];
  party: ClientDeal["vendors"][number] | null;
};
type Link = LinkValue & {
  deal: string;
  vendor: string;
  name: string;
  acknowledged: number;
  phase: LinkPhase;
  undo: Undo | null;
};
type SaveFailed = Extract<Saved, { ok: false }>;
const linkKey = (deal: string, vendor: string) => JSON.stringify([deal, vendor]);

function readLink(deal: ClientDeal | undefined, vendor: string): LinkValue {
  return {
    introductions: deal?.introductions.filter((row) => row.vendor_id === vendor) ?? [],
    party: deal?.vendors.find((row) => row.party_id === vendor) ?? null,
  };
}

function applyLinks(deal: ClientDeal, links: ReadonlyMap<string, Link>): ClientDeal {
  const tracked = [...links.values()].filter((link) => link.deal === deal.id);
  if (!tracked.length) return deal;
  const introductions = new Map(deal.introductions.map((row) => [row.id, row]));
  const vendors = new Map(deal.vendors.map((row) => [row.party_id, row]));
  for (const link of tracked) {
    const ids = new Set(link.introductions.map((row) => row.id));
    for (const [id, row] of introductions) {
      if (row.vendor_id === link.vendor && !ids.has(id)) introductions.delete(id);
    }
    for (const row of link.introductions) introductions.set(row.id, { ...row, chosen: Boolean(link.party) });
    if (link.party) vendors.set(link.vendor, { ...link.party, introduction_id: link.introductions.at(-1)?.id ?? null });
    else vendors.delete(link.vendor);
  }
  return { ...deal, introductions: [...introductions.values()], vendors: [...vendors.values()] };
}

// The Clients island is loaded once per page. Closing a card only removes its subscriber.
let linkSequence = 0;
let sessionLinks = new Map<string, Link>();
const linkListeners = new Set<() => void>();
const settledListeners = new Set<() => void>();
const subscribeLinks = (listener: () => void) => {
  linkListeners.add(listener);
  return () => {
    linkListeners.delete(listener);
  };
};
const getLinks = () => sessionLinks;
function publishLinks(next: Map<string, Link>) {
  sessionLinks = next;
  for (const listener of linkListeners) listener();
}
function updateLink(key: string, link: Link) {
  publishLinks(new Map(sessionLinks).set(key, link));
}

function expireUndo(key: string, undo: Undo) {
  // eslint-disable-next-line no-restricted-syntax -- An independent window for each acknowledged removal.
  window.setTimeout(() => {
    const link = sessionLinks.get(key);
    if (link?.undo === undo) updateLink(key, { ...link, undo: null });
  }, UNDO_MS);
}

function useDealLinks(load: CardSectionProps<ClientDeal[]>["load"]) {
  const links = useSyncExternalStore(subscribeLinks, getLinks);
  const loadDeals = useCallback(
    async (signal: AbortSignal) => {
      const started = ++linkSequence;
      const deals = await load(signal).catch((error: unknown) => {
        if (!signal.aborted) {
          const next = new Map(sessionLinks);
          let changed = false;
          for (const [key, link] of next) {
            if (link.phase !== "checking" || started <= link.acknowledged) continue;
            next.set(key, { ...link, phase: "unconfirmed" });
            changed = true;
          }
          if (changed) publishLinks(next);
        }
        throw error;
      });
      if (signal.aborted) return deals;
      const next = new Map(sessionLinks);
      let changed = false;
      for (const [key, link] of next) {
        if ((link.phase !== "ready" && link.phase !== "checking") || started <= link.acknowledged) continue;
        const deal = deals.find((row) => row.id === link.deal);
        if (!deal) continue;
        next.set(key, { ...link, ...readLink(deal, link.vendor), acknowledged: started, phase: "ready" });
        changed = true;
      }
      if (changed) publishLinks(next);
      return deals;
    },
    [load],
  );
  const [read, reload, refresh] = useRead(loadDeals);
  const refreshAfterSave = useEffectEvent(() => refresh());
  useEffect(() => {
    const settled = () => refreshAfterSave();
    settledListeners.add(settled);
    return () => {
      settledListeners.delete(settled);
    };
  }, []);

  function check(deal: string, vendor: string) {
    const key = linkKey(deal, vendor);
    const link = sessionLinks.get(key);
    if (!link || (link.phase !== "unconfirmed" && link.phase !== "checking")) return;
    updateLink(key, { ...link, acknowledged: ++linkSequence, phase: "checking" });
    refresh();
  }

  async function write<T extends Saved>(
    deal: ClientDeal,
    vendor: FoundVendor,
    save: () => Promise<T>,
    apply: (link: Link, answer: T | SaveFailed) => Partial<Link>,
    restoring?: Undo,
  ): Promise<Saved> {
    const key = linkKey(deal.id, vendor.id);
    const before = sessionLinks.get(key) ?? {
      ...readLink(deal, vendor.id),
      deal: deal.id,
      vendor: vendor.id,
      name: vendor.name,
      acknowledged: 0,
      phase: "ready",
      undo: null,
    };
    if (before.phase !== "ready") return { ok: false, problem: { error: "vendor_save_in_progress" } };
    const saving: Link = { ...before, phase: "saving", undo: restoring ?? before.undo };
    updateLink(key, saving);
    // eslint-disable-next-line no-restricted-syntax -- A single 10-second display timer is cleared when the write settles.
    const deadline = window.setTimeout(() => {
      const link = sessionLinks.get(key);
      if (link) updateLink(key, { ...link, phase: "slow" });
    }, 10_000);
    const answer = await save()
      .catch((): SaveFailed => ({ ok: false, pending: true }))
      .finally(() => window.clearTimeout(deadline));
    const unconfirmed = !answer.ok && answer.pending;
    const current = sessionLinks.get(key) ?? saving;
    const next: Link = {
      ...current,
      ...apply(current, answer),
      acknowledged: ++linkSequence,
      phase: unconfirmed ? "unconfirmed" : "ready",
    };
    updateLink(key, next);
    if (next.undo?.kind === "offer" && next.undo !== current.undo) expireUndo(key, next.undo);
    if (!unconfirmed) for (const listener of settledListeners) listener();
    return answer;
  }

  const deals = read.state === "ready" ? read.value.map((deal) => applyLinks(deal, links)) : [];
  return { read, deals, reload, check, write, links };
}

function withRoles(link: Link, roles: Role[]): Pick<LinkValue, "party"> {
  return {
    party: {
      party_id: link.vendor,
      name: link.name,
      introduction_id: link.party?.introduction_id ?? null,
      roles: [...(link.party?.roles.filter((row) => !roles.some((role) => role.role === row.role)) ?? []), ...roles],
    },
  };
}

function ClientDeals({ subject: client, load, stage, doors = null }: CardSectionProps<ClientDeal[]>) {
  const { read, deals, reload, check, write, links } = useDealLinks(load);
  const actionsFor = (deal: ClientDeal, doors: VendorDoors): VendorActions => ({
    phase: (vendor) => links.get(linkKey(deal.id, vendor))?.phase ?? "ready",
    check: (vendor) => check(deal.id, vendor),
    setSource: (vendor, by, replaces) =>
      write(
        deal,
        vendor,
        () => recordSource(doors, deal, client.id, vendor.id, by, replaces),
        (link, answer) => {
          if (!answer.ok) return {};
          const introductions = link.introductions.filter((row) => row.id !== replaces?.id);
          const source = answer.introduction;
          if (source)
            introductions.push({
              id: source.id,
              ...(source.version && { version: source.version }),
              vendor_id: vendor.id,
              vendor_name: vendor.name,
              made_by: source.by === "client" ? "client" : "team",
              introduced_by: source.by === "client" ? null : source.by,
              introduced_on: source.on,
              introduced_party_id: source.party,
              introduced_party_name: source.party === client.id ? client.name : (deal.client_name ?? client.name),
              note: null,
              removable: true,
              chosen: Boolean(link.party),
            });
          return { introductions };
        },
      ),
    removeIntroduction: (vendor, intro) =>
      write(
        deal,
        vendor,
        () => doors.removeIntroduction(intro),
        (link, answer) => (answer.ok ? { introductions: link.introductions.filter((row) => row.id !== intro.id) } : {}),
      ),
    add: (vendor, role) =>
      write(
        deal,
        vendor,
        () => doors.add(deal.id, vendor.id, role.role),
        (link, answer) => (answer.ok ? withRoles(link, [role]) : {}),
      ),
    remove: (vendor) =>
      write(
        deal,
        vendor,
        () => eachRole(vendor.roles, (role) => doors.remove(deal.id, vendor.id, role.role)),
        (_link, answer) => (answer.ok ? { party: null, undo: { kind: "offer", roles: vendor.roles } } : {}),
      ),
  });
  function restore(deal: ClientDeal, vendorId: string) {
    const link = sessionLinks.get(linkKey(deal.id, vendorId));
    if (!doors || !link?.undo || link.phase !== "ready") return;
    const missing = missingRoles(link, link.undo);
    if (!missing.length) return;
    const restoring: Undo = { kind: "restore", roles: link.undo.roles };
    void write(
      deal,
      { id: vendorId, name: link.name },
      () => eachRole(missing, (role) => doors.add(deal.id, vendorId, role.role)),
      (current, answer) => {
        if (answer.ok) return { ...withRoles(current, missing), undo: null };
        const restored = missing.slice(0, answer.done ?? 0);
        return {
          ...(restored.length && withRoles(current, restored)),
          undo: answer.pending
            ? restoring
            : { ...restoring, problem: `${link.name} wasn't put back. ${refusal(answer.problem)}` },
        };
      },
      restoring,
    );
  }
  const [opened, setOpened] = useState<string | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const menuFor = (deal: ClientDeal): VendorMenu | null =>
    doors &&
    ((vendor, close) => (
      <DealVendorMenu deal={deal} vendor={vendor} doors={doors} close={close} actions={actionsFor(deal, doors)} />
    ));
  if (read.state === "loading" || (read.state === "ready" && read.value.length === 0)) return null;
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
          <button type="button" className="client-deals-retry" onClick={reload}>
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
          {[...links.values()]
            .filter((link) => link.deal === deal.id)
            .map((link) => (
              <LinkNotice
                key={link.vendor}
                link={link}
                deal={deal}
                check={() => check(deal.id, link.vendor)}
                restore={() => restore(deal, link.vendor)}
              />
            ))}
          <DealDiagram client={client} deal={deal} menu={menuFor(deal)} />
          {doors && <AddVendor deal={deal} doors={doors} actions={actionsFor(deal, doors)} />}
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
