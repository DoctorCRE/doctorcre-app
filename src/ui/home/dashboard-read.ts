import { type InboxItem, object, parseEngineDashboardCard } from "./inbox";

const dashboardTiles = ["reminders", "waiting"] as const;
type DashboardCard = Record<string, unknown> & { card_id: string; item_id: string };
const unavailable = "Reminders and waiting items unavailable.";

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
  const response: Response = await sessionFetch("/api/engine/home/inbox?view=dashboard", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 404) return null;
  const answer: unknown = await response.json().catch(() => null);
  if (
    response.status === 400 &&
    object(answer) &&
    answer.error === "unregistered_operation_fields" &&
    Array.isArray(answer.fields) &&
    answer.fields.length === 1 &&
    answer.fields[0] === "view"
  )
    return null;
  if (!response.ok || !object(answer)) throw Error(unavailable);
  if (!("reminders" in answer) && !("waiting" in answer)) return null;
  if (answer.ok !== true || answer.schema_version !== "home-inbox.v5") throw Error(unavailable);
  const reminders = cards(answer.reminders);
  const waiting = cards(answer.waiting);
  const all = [...reminders, ...waiting];
  if (
    new Set(all.map((card) => card.card_id)).size !== all.length ||
    new Set(all.map((card) => card.item_id)).size !== all.length
  )
    throw Error(unavailable);
  return { ...answer, reminders, waiting };
}

export async function readDashboard(signal: AbortSignal) {
  const groups = await readDashboardGroups(signal);
  if (!groups) return null;
  const items = dashboardTiles.flatMap((tile) =>
    groups[tile].map((item): InboxItem => {
      const parsed = parseEngineDashboardCard(item, groups);
      return { ...parsed, dashboard_tile: tile };
    }),
  );
  return { grouped: true as const, engine_marks: true as const, items };
}
