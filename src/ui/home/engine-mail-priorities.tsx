import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { hasEngineReview, matchesProposal } from "./engine-review.ts";
import { type InboxItem, object } from "./inbox.tsx";
import { takeEarlyMailPriorities } from "./mail-priorities-client";

const received = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Chicago",
});
const due = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
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
  const seen = new Set<string>();
  const items = value.items.flatMap((row: unknown) => {
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
      typeof row.proposal_id === "string" &&
      row.reply_draft_id === null &&
      (row.item_id.startsWith("suggestion:") || row.item_id.startsWith("reply_draft:"))
        ? row.proposal_id
        : null;
    const draft =
      typeof row.reply_draft_id === "string" &&
      row.proposal_id === null &&
      row.item_id === `reply_draft:${row.reply_draft_id}`;
    if (!proposal && !draft) throw invalid();
    const conversation =
      typeof row.conversation_id === "string"
        ? `conversation:${row.conversation_id}`
        : `email:${row.source_activity.id}`;
    if (seen.has(conversation)) return [];
    seen.add(conversation);
    return [
      {
        item_id: row.item_id,
        base_version: row.base_version,
        proposal,
        conversation,
        sender: typeof row.sender === "string" ? row.sender : "Sender unavailable",
        subject: typeof row.subject === "string" ? row.subject : "Subject unavailable",
        suggestion: typeof row.suggestion === "string" ? row.suggestion : "",
        dueOn: typeof row.due_on === "string" && Number.isFinite(Date.parse(row.due_on)) ? row.due_on : null,
        happenedAt: row.source_activity.happened_at,
      },
    ];
  });
  return { items, more: value.more };
}

export function EngineMailPriorities({
  items,
  locked,
  review,
}: {
  items: readonly InboxItem[];
  locked: boolean;
  review(item: InboxItem, opener: HTMLButtonElement, proposal?: string): void;
}) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const early = takeEarlyMailPriorities();
    early?.controller.abort();
    early?.detach();
  }, []);
  const query = useQuery({
    queryKey: ["home-mail-priorities", items.map((item) => [item.item_id, item.base_version])],
    queryFn: ({ signal }) => readPriorities(signal),
    enabled: expanded,
  });
  return (
    <section className="home-panel" aria-label="Mail priorities" aria-busy={expanded && query.isFetching}>
      <h2>Mail priorities</h2>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide mail priorities" : "Show mail priorities"}
      </button>
      {expanded && (
        <>
          {query.isPending && <p role="status">Loading mail priorities…</p>}
          {query.isError && <p role="status">Mail priorities unavailable.</p>}
          {query.data && (
            <>
              {!query.data.items.length && <p role="status">No mail priorities right now.</p>}
              {query.data.more && <p>Showing the 25 most urgent.</p>}
              <ol>
                {query.data.items.map((row) => {
                  const match = items.find(
                    (item) =>
                      item.item_id === row.item_id &&
                      item.base_version === row.base_version &&
                      hasEngineReview(item) &&
                      (!row.proposal || matchesProposal(item, row.proposal)),
                  );
                  return (
                    <li key={row.conversation}>
                      <button
                        type="button"
                        disabled={locked || !match}
                        onClick={(event) => {
                          if (match) review(match, event.currentTarget, row.proposal ?? undefined);
                        }}
                      >
                        {row.sender} · {row.subject}
                      </button>
                      <p>{row.suggestion}</p>
                      <time dateTime={row.happenedAt}>{received.format(new Date(row.happenedAt))} Central</time>
                      {row.dueOn && (
                        <p>
                          Due <time dateTime={row.dueOn}>{due.format(new Date(row.dueOn))}</time>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {!query.isPending && (
            <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              Refresh mail priorities
            </button>
          )}
        </>
      )}
    </section>
  );
}
