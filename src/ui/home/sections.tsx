import { Component, type ReactNode, useState, useSyncExternalStore } from "react";
import { pageScroller } from "../../../js/touch-layout.js";
import type { HomeTileName, InboxItem } from "./inbox";

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
// A stacked list tile on a phone previews this many rows above See all.
const phonePreviewCount = 4;
export const cardKey = (item: InboxItem) => item.card_id ?? item.item_id;
const waitingSections: readonly InboxItem["section"][] = ["working", "held", "snoozed"];

/** The whole instruction when a reminder's heading is that instruction, or the start of it cut with "…". */
export function wholeInstruction(title: string, why: string | undefined) {
  if (!why) return null;
  const cut = title.endsWith("…") && why.startsWith(title.slice(0, -1).trimEnd());
  return cut || why === title ? why : null;
}

export function tileOf(item: InboxItem): HomeTileName {
  if (item.dashboard_tile) return item.dashboard_tile;
  if (waitingSections.includes(item.section)) return "waiting";
  return item.action_id && item.presentation?.primaryAction !== "Review completion" ? "reminders" : "inbox";
}

export function dashboardCards(items: readonly InboxItem[], today = day(new Date())) {
  const tiles: Record<HomeTileName, InboxItem[]> = { reminders: [], inbox: [], waiting: [] };
  for (const item of items) {
    if (!item.dashboard_tile) {
      if (item.auto_settled || item.source_state === "done") continue;
      const lead = !item.deal_id && /^\/(?:leads(?:[/?#]|$)|deals\?[^#]*\bprospect=)/.test(item.open_url ?? "");
      if (item.action_id && lead) continue;
      const due = !item.action_id || !item.due_on || item.due_on <= today;
      if (item.section === "inbox" ? !due : !waitingSections.includes(item.section)) continue;
    }
    tiles[tileOf(item)].push(item);
  }
  return tiles;
}

const groups = ["Late", "Today", "No date", "folded"] as const;
type ReminderGroup = (typeof groups)[number];
// Reminders 15 or more days late fold into one line under the rest.
function reminderGroup(item: InboxItem): ReminderGroup {
  const late = item.days_late ?? 0;
  if (late >= 15) return "folded";
  if (late) return "Late";
  return item.due_on ? "Today" : "No date";
}
const byGroup = (a: InboxItem, b: InboxItem) =>
  groups.indexOf(reminderGroup(a)) - groups.indexOf(reminderGroup(b)) || (b.days_late ?? 0) - (a.days_late ?? 0);

const stacked = "(max-width: 999px)";
/** Below three columns Home is one scrolling page. */
export function useStacked() {
  return useSyncExternalStore(
    (change) => {
      const media = matchMedia(stacked);
      media.addEventListener("change", change);
      return () => media.removeEventListener("change", change);
    },
    () => matchMedia(stacked).matches,
  );
}

export function HomeTile({
  title,
  count,
  detail,
  children,
  expanded,
  setExpanded,
  preview = tilePreviewCount,
}: {
  title: string;
  count: number;
  detail?: string | undefined;
  children: ReactNode;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  preview?: number;
}) {
  return (
    <section className="home-slice" aria-label={title}>
      <header>
        <h2 tabIndex={-1}>
          {title} <span>{detail ? `${count} · ${detail}` : count}</span>
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
  grouped = false,
}: {
  title: string;
  items: readonly InboxItem[];
  pinned?: InboxItem | null;
  current: string | undefined;
  row: (item: InboxItem) => ReactNode;
  after?: ReactNode[];
  grouped?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const isStacked = useStacked();
  const preview = isStacked ? phonePreviewCount : Number.POSITIVE_INFINITY;
  const count = items.length + after.length;
  const [order, setOrder] = useState({ incoming: items, pinned, cards: items });
  const changed = order.incoming !== items || order.pinned !== pinned;
  const preserve = pinned && !items.some((item) => cardKey(item) === cardKey(pinned));
  const visible = changed ? retainOrder(order.cards, preserve ? [...items, pinned] : items) : order.cards;
  if (changed) setOrder({ incoming: items, pinned, cards: visible });
  if (!visible.length && !after.length) return null;
  const ordered = grouped ? [...visible].sort(byGroup) : visible;
  const kept = (item: InboxItem) => item.item_id === current || (pinned && cardKey(item) === cardKey(pinned));
  const shown = expanded ? ordered : ordered.filter((item, index) => index < preview || kept(item));
  const inGroup = (group: ReminderGroup) => shown.filter((item) => grouped && reminderGroup(item) === group);
  const folded = inGroup("folded");
  const late = visible.filter((item) => grouped && reminderGroup(item) === "Late").length;
  return (
    <HomeTile
      title={title}
      count={count}
      detail={late ? `${late} late` : undefined}
      expanded={expanded}
      setExpanded={setExpanded}
      preview={preview}
    >
      {grouped
        ? groups.slice(0, 3).map((group) => {
            const rows = inGroup(group);
            return (
              rows.length > 0 && (
                <section key={group} aria-label={group}>
                  <h3 className={group === "Late" ? "home-group home-late" : "home-group"}>{group}</h3>
                  {rows.map(row)}
                </section>
              )
            );
          })
        : shown.map(row)}
      {folded.length > 0 &&
        (unfolded || folded.some(kept) ? (
          <section aria-label="More than two weeks late">
            <h3 className="home-group home-late">More than two weeks late</h3>
            {folded.map(row)}
          </section>
        ) : (
          <button type="button" className="home-fold" onClick={() => setUnfolded(true)}>
            {folded.length} more than two weeks late
          </button>
        ))}
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
    return Array.from(this.grid?.querySelectorAll(".inbox-row, .home-today-row") ?? []).flatMap((node) => {
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
