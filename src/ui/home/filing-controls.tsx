import { useEffect, useState } from "react";
import type { FilingChoice } from "./engine-review.ts";
import { object } from "./inbox.tsx";

export type FilingDestination = { deal_id: string } | { vendor_id: string };
type FileEmail = (destination: FilingDestination, reason?: string) => void;
type RecordOption = { id: string; name: string };
type Targets = { rows: RecordOption[]; pages: number };
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

async function readTargets(
  kind: FilingChoice["kind"],
  query: string,
  page: number,
  signal: AbortSignal,
): Promise<Targets> {
  let rows: unknown;
  let pages = 1;
  if (kind === "deal") {
    const { createClient } = await sibling("./client.js");
    const client = await createClient("live", { docContext: false });
    const board: unknown = await client.getBoard({ workspace: "all", signal });
    rows = object(board) ? board.deals : null;
  } else {
    const [{ sessionFetch }, { defaultQuery, listRequestUrl }] = await Promise.all([
      sibling("./private-session.js"),
      sibling("./workspace-business-model.js"),
    ]);
    const response: Response = await sessionFetch(listRequestUrl({ ...defaultQuery("vendors"), q: query, page }), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw Error("Vendor records unavailable.");
    const payload: unknown = await response.json();
    if (!object(payload) || typeof payload.page_count !== "number" || !Number.isSafeInteger(payload.page_count))
      throw Error("Vendor records unavailable.");
    ({ rows, page_count: pages } = payload);
  }
  if (!Array.isArray(rows)) throw Error("Filing destinations unavailable.");
  return {
    rows: rows.flatMap((row: unknown) =>
      object(row) && typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [],
    ),
    pages,
  };
}

function FilingPicker({ kind, file }: { kind: FilingChoice["kind"]; file: FileEmail }) {
  const [search, setSearch] = useState("");
  const [request, setRequest] = useState({ query: "", page: 1 });
  const [targets, setTargets] = useState<Targets | "unavailable" | null>(null);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const label = kind === "deal" ? "Deal" : "Vendor";
  useEffect(() => {
    const controller = new AbortController();
    void readTargets(kind, request.query, request.page, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setTargets(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTargets("unavailable");
      });
    return () => controller.abort();
  }, [kind, request]);

  function load(query: string, page: number) {
    setTargets(null);
    setSelected("");
    setRequest({ query, page });
  }
  const rows = targets && targets !== "unavailable" ? targets.rows : [];
  const options =
    kind === "deal" ? rows.filter(({ name }) => name.toLowerCase().includes(search.trim().toLowerCase())) : rows;
  const canFile = options.some(({ id }) => id === selected);
  return (
    <div>
      <label>
        {label} name{" "}
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setSelected("");
          }}
          onKeyDown={(event) => {
            if (kind === "vendor" && event.key === "Enter") {
              event.preventDefault();
              load(search.trim(), 1);
            }
          }}
        />
      </label>
      {kind === "vendor" && (
        <button type="button" onClick={() => load(search.trim(), 1)}>
          Search vendors
        </button>
      )}
      {targets === null ? (
        <p role="status">Loading {kind}s…</p>
      ) : targets === "unavailable" ? (
        <p role="status">
          Could not load {kind}s.{" "}
          <button type="button" onClick={() => load(request.query, request.page)}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <label>
            {label}{" "}
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setReason("");
              }}
              disabled={!options.length}
            >
              <option value="">{options.length ? `Select a ${kind}` : `No ${kind}s found`}</option>
              {options.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {request.page > 1 && (
            <button type="button" onClick={() => load(request.query, request.page - 1)}>
              Previous page
            </button>
          )}
          {request.page < targets.pages && (
            <button type="button" onClick={() => load(request.query, request.page + 1)}>
              Next page
            </button>
          )}
          {kind === "deal" && canFile && (
            <label>
              Reason if correcting the filing
              <input value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
            </label>
          )}
          <button
            type="button"
            disabled={!canFile}
            onClick={() => {
              if (!canFile) return;
              if (kind === "deal") file({ deal_id: selected }, reason.trim());
              else file({ vendor_id: selected });
            }}
          >
            File email
          </button>
        </>
      )}
    </div>
  );
}

export function FilingControls({
  choices,
  file,
  dismiss,
}: {
  choices: FilingChoice[];
  file: FileEmail;
  dismiss(): void;
}) {
  const [kind, setKind] = useState<FilingChoice["kind"] | null>(null);
  const active = choices.find((choice) => choice.kind === kind);
  return (
    <>
      <div className="inbox-actions">
        {choices.map((choice) => (
          <button
            key={choice.kind}
            type="button"
            aria-expanded={kind === choice.kind}
            onClick={() => setKind(kind === choice.kind ? null : choice.kind)}
          >
            {choice.label}
          </button>
        ))}
        <button type="button" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      {active && <FilingPicker key={active.kind} kind={active.kind} file={file} />}
    </>
  );
}
