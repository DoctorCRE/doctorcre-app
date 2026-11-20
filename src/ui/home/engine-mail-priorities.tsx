import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { hasEngineReview, matchesProposal } from "./engine-review.ts";
import { type InboxItem, object } from "./inbox.tsx";
import { takeEarlyMailPriorities } from "./mail-priorities-client";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const invalid = () => Error("Mail priorities unavailable");

async function readPriorities(signal: AbortSignal) {
  const [{ sessionFetch }, { readWithDeadline }] = await Promise.all([
    sibling("./private-session.js"),
    sibling("./current-read.mjs"),
  ]);
  const value: unknown = await readWithDeadline(
    async (bounded: AbortSignal) => {
      const response: Response = await sessionFetch("/api/v1/intelligence/mail-needs-partner?limit=25", {
        signal: bounded,
        credentials: "same-origin",
      });
      return response.ok ? response.json() : null;
    },
    { signal, timeoutMs: 10000 },
  );
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "home-mail-priorities.v1" ||
    !Array.isArray(value.items) ||
    value.items.length > 25 ||
    typeof value.more !== "boolean"
  )
    throw invalid();
  const items = value.items.map((row: unknown) => {
    if (
      !object(row) ||
      typeof row.item_id !== "string" ||
      typeof row.base_version !== "string" ||
      !object(row.source_activity) ||
      row.source_activity.kind !== "email" ||
      typeof row.source_activity.id !== "string" ||
      typeof row.source_activity.happened_at !== "string" ||
      !Number.isFinite(Date.parse(row.source_activity.happened_at))
    )
      throw invalid();
    const proposal =
      row.kind !== "reply_draft" &&
      typeof row.proposal_id === "string" &&
      row.reply_draft_id === null &&
      row.item_id.startsWith("suggestion:")
        ? row.proposal_id
        : null;
    const draft =
      row.kind === "reply_draft" &&
      typeof row.reply_draft_id === "string" &&
      row.proposal_id === null &&
      row.item_id === `reply_draft:${row.reply_draft_id}`;
    if (!proposal && !draft) throw invalid();
    return { item_id: row.item_id, base_version: row.base_version, proposal };
  });
  return { items, more: value.more };
}

export function useEngineMailPriorities(items: readonly InboxItem[], enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const early = takeEarlyMailPriorities();
    early?.controller.abort();
    early?.detach();
  }, [enabled]);
  const query = useQuery({
    queryKey: ["home-mail-priorities", items.map((item) => [item.item_id, item.base_version])],
    queryFn: ({ signal }) => readPriorities(signal),
    enabled,
  });
  const ranks = new Map<string, number>();
  if (enabled) {
    query.data?.items.forEach((row, rank) => {
      const card = items.find((item) => item.item_id === row.item_id && item.base_version === row.base_version);
      if (card?.section === "inbox" && hasEngineReview(card) && (!row.proposal || matchesProposal(card, row.proposal)))
        ranks.set(card.item_id, rank);
    });
  }
  const rank = (item: InboxItem) => ranks.get(item.item_id) ?? 25;
  return {
    ordered: ranks.size ? [...items].sort((a, b) => rank(a) - rank(b)) : items,
    count: ranks.size,
    query,
  };
}

export function EngineMailPriorities({ count, query }: ReturnType<typeof useEngineMailPriorities>) {
  return (
    <section className="home-panel" aria-label="Mail priorities" aria-busy={query.isFetching}>
      <h2>Mail priorities</h2>
      {query.isPending && <p role="status">Loading mail priorities…</p>}
      {query.isError && <p role="status">Mail priorities unavailable.</p>}
      {query.isSuccess && !count && <p role="status">No mail priorities right now.</p>}
      {query.data?.more && <p>More conversations are in your inbox.</p>}
      {!query.isPending && (
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh mail priorities
        </button>
      )}
    </section>
  );
}
