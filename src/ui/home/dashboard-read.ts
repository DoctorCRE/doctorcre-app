import { type HomeTileName, type InboxItem, object, parseEngineDashboardCard } from "./inbox";

const dashboardTiles: readonly HomeTileName[] = ["reminders", "inbox", "waiting"];
type DashboardCard = Record<string, unknown> & { card_id: string; item_id: string };
const unavailable = "Reminders and Inbox unavailable.";

function isDashboardCard(item: unknown): item is DashboardCard {
  return (
    object(item) &&
    typeof item.card_id === "string" &&
    Boolean(item.card_id.trim()) &&
    typeof item.item_id === "string" &&
    Boolean(item.item_id.trim())
  );
}

function cards(group: unknown): DashboardCard[] {
  if (
    !object(group) ||
    !Array.isArray(group.items) ||
    group.count !== group.items.length ||
    !group.items.every(isDashboardCard)
  )
    throw Error(unavailable);
  return group.items;
}

export async function readDashboardGroups(signal: AbortSignal) {
  const { sessionFetch } = await import(new URL("./private-session.js", import.meta.url).href);
  const response: Response = await sessionFetch("/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok || !object(answer) || answer.ok !== true || answer.schema_version !== "home-inbox.v6")
    throw Error(unavailable);
  const reminders = cards(answer.reminders);
  const inbox = cards(answer.inbox);
  const waiting = cards(answer.waiting);
  const all = [...reminders, ...inbox, ...waiting];
  if (
    new Set(all.map((card) => card.card_id)).size !== all.length ||
    new Set(all.map((card) => card.item_id)).size !== all.length
  )
    throw Error(unavailable);
  return { ...answer, reminders, inbox, waiting };
}

export async function readDashboard(signal: AbortSignal) {
  const groups = await readDashboardGroups(signal);
  const items = dashboardTiles.flatMap((tile) =>
    groups[tile].map((item): InboxItem => {
      const parsed = parseEngineDashboardCard(item, groups);
      return { ...parsed, dashboard_tile: tile };
    }),
  );
  return { grouped: true as const, engine_marks: true as const, items };
}
