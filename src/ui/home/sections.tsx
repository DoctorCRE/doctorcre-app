import { Component, type ReactNode, useState } from "react";
import { pageScroller } from "../../../js/touch-layout.js";
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
});
export const day = (date: Date) => dayFormat.format(date);

export function lateDays(due: string | null, today: string) {
  return due && due < today ? (Date.parse(today) - Date.parse(due)) / 86_400_000 : 0;
}

export function completionLabel(item: InboxItem) {
  if (!item.completed_at) return "Done, time not recorded";
  const label = item.engine_marks && item.kind_label === "Reply draft" ? "Sent" : "Done";
  return `${label} ${completionFormat.format(new Date(item.completed_at))}`;
}

export const tilePreviewCount = 5;
// The wide Reminders column fits eight compact cards on a laptop screen.
export const reminderPreviewCount = 8;
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
    ...withoutRepeats(
      reminders[0]?.dashboard_tile
        ? reminders
        : reminders.sort((a, b) => Number(Boolean(b.days_late)) - Number(Boolean(a.days_late))),
    ),
    waiting,
  };
}

// Jobs can save the same meeting follow-up on a record more than once; Home shows it once.
const meetingFollowUp = /^Follow up on the [A-Z][a-z]{2} \d{1,2} meeting: /;
const repeatKey = (item: InboxItem) =>
  item.engine_marks && item.source_type === "next_action" && meetingFollowUp.test(item.title)
    ? JSON.stringify([item.title, item.deal_id, item.context_label])
    : null;

function withoutRepeats(cards: readonly InboxItem[]) {
  const leads = new Map<string, InboxItem>();
  const repeats = new Map<string, InboxItem[]>();
  const reminders = cards.filter((item) => {
    const key = repeatKey(item);
    const lead = key && leads.get(key);
    if (key && !lead) leads.set(key, item);
    if (!lead) return true;
    repeats.set(cardKey(lead), [...(repeats.get(cardKey(lead)) ?? []), item]);
    return false;
  });
  return { reminders, repeats };
}

export function HomeTile({
  title,
  count,
  children,
  expanded,
  setExpanded,
  preview = tilePreviewCount,
}: {
  title: string;
  count: number;
  children: ReactNode;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  preview?: number;
}) {
  return (
    <section className="home-slice" aria-label={title}>
      <header>
        <h2 tabIndex={-1}>
          {title} <span>{count}</span>
        </h2>
        {count > preview && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : `See all ${count}`}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

/** A tile's shape while its read is in flight: a title bar and three card rows. */
export function PlaceholderTile() {
  return (
    <div className="home-slice home-placeholder" aria-hidden="true">
      <header>
        <span className="skeleton-line short" />
      </header>
      {[0, 1, 2].map((row) => (
        <div className="home-placeholder-row" key={row}>
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
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
  showLate = false,
  preview = tilePreviewCount,
}: {
  title: string;
  items: readonly InboxItem[];
  pinned?: InboxItem | null;
  current: string | undefined;
  row: (item: InboxItem) => ReactNode;
  after?: ReactNode[];
  showLate?: boolean;
  preview?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = items.length + after.length;
  const [order, setOrder] = useState({ incoming: items, pinned, cards: items });
  const changed = order.incoming !== items || order.pinned !== pinned;
  const preserve = pinned && !items.some((item) => cardKey(item) === cardKey(pinned));
  const visible = changed ? retainOrder(order.cards, preserve ? [...items, pinned] : items) : order.cards;
  if (changed) setOrder({ incoming: items, pinned, cards: visible });
  if (!visible.length && !after.length) return null;
  const isLate = (item: InboxItem) => showLate && Boolean(item.days_late);
  const ordered = [...visible.filter(isLate), ...visible.filter((item) => !isLate(item))];
  const shown = expanded
    ? ordered
    : ordered.filter(
        (item, index) => index < preview || item.item_id === current || (pinned && cardKey(item) === cardKey(pinned)),
      );
  const late = shown.filter(isLate);
  return (
    <HomeTile title={title} count={count} expanded={expanded} setExpanded={setExpanded} preview={preview}>
      {late.length > 0 && (
        <section aria-label="Late">
          <h3 className="home-late">Late</h3>
          {late.map(row)}
        </section>
      )}
      {shown.filter((item) => !isLate(item)).map(row)}
      {expanded ? after : after.slice(0, Math.max(0, preview - items.length))}
    </HomeTile>
  );
}

type Anchor = { node: Element; top: number };
export class HomeGrid extends Component<{ children: ReactNode; snapshot: unknown; calendar?: unknown }> {
  private grid: HTMLDivElement | null = null;

  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>): Anchor[] | null {
    if (
      !pageScroller().scrollTop ||
      (this.props.snapshot === previous.snapshot && this.props.calendar === previous.calendar)
    )
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
    if (anchor)
      pageScroller().scrollBy({ top: anchor.node.getBoundingClientRect().top - anchor.top, behavior: "instant" });
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
