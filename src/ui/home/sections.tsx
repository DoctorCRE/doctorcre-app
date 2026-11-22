import { Component, type ReactNode, useState } from "react";
import type { InboxItem } from "./inbox";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const completionFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
export const day = (date: Date) => dayFormat.format(date);

export function lateDays(due: string | null, today: string) {
  return due && due < today ? (Date.parse(today) - Date.parse(due)) / 86_400_000 : 0;
}

export function homeLateDays(item: InboxItem, today: string) {
  if (item.section !== "inbox" || !item.due_on) return 0;
  if (item.dashboard_tile) return item.days_late ?? 0;
  const dealOrVendor = item.deal_id || /^\/(?:deals\?[^#]*\bdeal=|vendors(?:[/?#]|$))/.test(item.open_url ?? "");
  return item.action_id && dealOrVendor ? lateDays(item.due_on, today) : 0;
}

export function completionLabel(item: InboxItem) {
  if (!item.completed_at) return "Done, time not recorded";
  const label = item.engine_marks && item.kind_label === "Reply draft" ? "Sent" : "Done";
  return `${label} ${completionFormat.format(new Date(item.completed_at))}`;
}

export const tilePreviewCount = 5;
export const cardKey = (item: InboxItem) => item.card_id ?? item.item_id;

export function dashboardCards(items: readonly InboxItem[], today = day(new Date())) {
  const reminders: InboxItem[] = [];
  const waiting: InboxItem[] = [];
  for (const item of items) {
    if (item.dashboard_tile) {
      (item.dashboard_tile === "reminders" ? reminders : waiting).push(item);
      continue;
    }
    if (item.auto_settled || item.source_state === "done") continue;
    const lead = !item.deal_id && /^\/(?:leads(?:[/?#]|$)|deals\?[^#]*\bprospect=)/.test(item.open_url ?? "");
    if (item.action_id && lead) continue;
    if (["working", "held", "snoozed"].includes(item.section)) waiting.push(item);
    else if (item.section === "inbox" && (!item.action_id || !item.due_on || item.due_on <= today))
      reminders.push(item);
  }
  return {
    reminders: reminders[0]?.dashboard_tile
      ? reminders
      : reminders.sort((a, b) => Number(homeLateDays(b, today) > 0) - Number(homeLateDays(a, today) > 0)),
    waiting,
  };
}

export function HomeTile({
  title,
  count,
  children,
  expanded,
  setExpanded,
}: {
  title: string;
  count: number;
  children: ReactNode;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}) {
  return (
    <section className="home-slice" aria-label={title}>
      <header>
        <h2 tabIndex={-1}>
          {title} <span>{count}</span>
        </h2>
        {count > tilePreviewCount && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : `See all ${count}`}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function retainOrder(previous: readonly InboxItem[], incoming: readonly InboxItem[]) {
  const remaining = new Map(incoming.map((item) => [cardKey(item), item]));
  return [
    ...previous.flatMap((old) => {
      const current = remaining.get(cardKey(old));
      remaining.delete(cardKey(old));
      return current ? [current] : [];
    }),
    ...remaining.values(),
  ];
}

export function CardTile({
  title,
  items,
  pinned,
  current,
  row,
  after = [],
  today,
}: {
  title: string;
  items: readonly InboxItem[];
  pinned?: InboxItem | null;
  current: string | undefined;
  row: (item: InboxItem) => ReactNode;
  after?: ReactNode[];
  today?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = items.length + after.length;
  const [order, setOrder] = useState({ incoming: items, pinned, cards: items });
  const changed = order.incoming !== items || order.pinned !== pinned;
  const preserve = pinned && !items.some((item) => cardKey(item) === cardKey(pinned));
  const visible = changed ? retainOrder(order.cards, preserve ? [...items, pinned] : items) : order.cards;
  if (changed) setOrder({ incoming: items, pinned, cards: visible });
  if (!visible.length && !after.length) return null;
  const shown = expanded
    ? visible
    : visible.filter(
        (item, index) =>
          index < tilePreviewCount || item.item_id === current || (pinned && cardKey(item) === cardKey(pinned)),
      );
  const regular: InboxItem[] = [];
  const late: InboxItem[] = [];
  for (const item of shown) {
    (today && homeLateDays(item, today) > 0 ? late : regular).push(item);
  }
  return (
    <HomeTile title={title} count={count} expanded={expanded} setExpanded={setExpanded}>
      {regular.map(row)}
      {expanded ? after : after.slice(0, Math.max(0, tilePreviewCount - items.length))}
      {late.length > 0 && (
        <section aria-label="Late">
          <h3 className="home-late">Late</h3>
          {late.map(row)}
        </section>
      )}
    </HomeTile>
  );
}

type Anchor = { node: Element; top: number };
export class HomeGrid extends Component<{ children: ReactNode; snapshot: unknown; calendar?: unknown }> {
  private grid: HTMLDivElement | null = null;

  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>): Anchor[] | null {
    if (!window.scrollY || (this.props.snapshot === previous.snapshot && this.props.calendar === previous.calendar))
      return null;
    const active = document.activeElement;
    if (active && this.grid?.contains(active)) return [{ node: active, top: active.getBoundingClientRect().top }];
    return Array.from(this.grid?.querySelectorAll(".inbox-row, .home-meeting") ?? []).flatMap((node) => {
      const { top, bottom } = node.getBoundingClientRect();
      return bottom > 0 && top < window.innerHeight ? [{ node, top }] : [];
    });
  }

  componentDidUpdate(_previous: Readonly<typeof this.props>, _state: unknown, anchors: Anchor[] | null) {
    const anchor = anchors?.find(({ node }) => node.isConnected);
    if (anchor) window.scrollBy({ top: anchor.node.getBoundingClientRect().top - anchor.top, behavior: "instant" });
  }

  render() {
    return (
      <div
        className="home-sections"
        ref={(node) => {
          this.grid = node;
        }}
      >
        {this.props.children}
      </div>
    );
  }
}
