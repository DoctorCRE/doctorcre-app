import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { dealCutover } from "./deal-cutover.ts";

type Row = {
  client_id: string;
  client_name: string;
  deal_id: string;
  deal_name: string;
  closed_on: string;
  anniversary_on: string;
  days_until: number;
  years: number;
};
type Snapshot = {
  schema_version: "client-anniversary-read.v1";
  state: "ready" | "empty" | "unavailable" | "needs_input";
  as_of: string;
  timezone: "America/Chicago";
  rows: (Row & { evidence_ref: string })[];
  coverage: { scanned: number; skipped_invalid: number; complete: boolean };
  next_offset: number | null;
};
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
  new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const label = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function isAnniversaryRow(v: unknown): v is Row & Record<string, unknown> {
  return (
    object(v) &&
    label(v.client_id) &&
    typeof v.client_name === "string" &&
    label(v.deal_id) &&
    typeof v.deal_name === "string" &&
    date(v.closed_on) &&
    date(v.anniversary_on) &&
    integer(v.days_until) &&
    v.days_until <= 30 &&
    integer(v.years) &&
    v.years >= 1
  );
}

function parseClientAnniversaries(v: unknown): Snapshot {
  if (
    !object(v) ||
    v.schema_version !== "client-anniversary-read.v1" ||
    v.timezone !== "America/Chicago" ||
    !date(v.as_of) ||
    !object(v.query) ||
    v.query.horizon_days !== 30 ||
    v.query.limit !== 20 ||
    v.query.offset !== 0 ||
    !Array.isArray(v.rows) ||
    v.rows.length > 20 ||
    !object(v.coverage)
  )
    throw Error("Anniversary response unavailable");
  const { scanned, skipped_invalid, complete } = v.coverage;
  const state = v.state;
  if (state !== "ready" && state !== "empty" && state !== "unavailable" && state !== "needs_input")
    throw Error("Anniversary state unavailable");
  if (
    !integer(scanned) ||
    scanned > 1001 ||
    !integer(skipped_invalid) ||
    skipped_invalid > scanned ||
    complete !== (state === "ready" || state === "empty") ||
    (state === "ready") !== v.rows.length > 0 ||
    !(v.next_offset === null || (v.next_offset === 20 && v.rows.length === 20))
  )
    throw Error("Anniversary coverage unavailable");
  const rows = v.rows.map((r: unknown) => {
    if (
      !isAnniversaryRow(r) ||
      !label(r.client_name) ||
      !label(r.deal_name) ||
      r.closed_on > String(v.as_of) ||
      !integer(r.deal_version) ||
      r.deal_version < 1 ||
      !integer(r.client_version) ||
      r.client_version < 1 ||
      !integer(r.party_version) ||
      r.party_version < 1 ||
      !["closed", "invoiced"].includes(String(r.phase)) ||
      r.outcome !== "won" ||
      r.evidence_ref !== `deal:${r.deal_id}@${r.deal_version}#closed_on`
    )
      throw Error("Anniversary row unavailable");
    return {
      client_id: r.client_id,
      client_name: r.client_name,
      deal_id: r.deal_id,
      deal_name: r.deal_name,
      closed_on: r.closed_on,
      anniversary_on: r.anniversary_on,
      days_until: r.days_until,
      years: r.years,
      evidence_ref: r.evidence_ref,
    };
  });
  const keys = rows.map((r) => `${r.anniversary_on}/${r.client_id}/${r.deal_id}/${r.closed_on}`);
  if (new Set(keys).size !== keys.length || keys.join() !== [...keys].sort().join())
    throw Error("Anniversary order unavailable");
  return {
    schema_version: v.schema_version,
    state,
    as_of: v.as_of,
    timezone: v.timezone,
    rows,
    coverage: { scanned, skipped_invalid, complete },
    next_offset: v.next_offset,
  };
}

async function fetchAnniversaries(path: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<Response> {
  const { fetchRead } = await sibling("./auto-refresh.mjs");
  const request = fetchImpl ?? (await sibling("./private-session.js")).sessionFetch;
  return fetchRead(
    path,
    { credentials: "same-origin", cache: "no-store", signal, headers: { accept: "application/json" } },
    { fetchImpl: request },
  );
}

async function readEngineAnniversaries(signal: AbortSignal): Promise<Row[]> {
  const response = await fetchAnniversaries("/api/engine/closing-anniversaries", signal);
  if (!response.ok) throw Error("Closing anniversaries unavailable");
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isAnniversaryRow)) throw Error("Anniversary response unavailable");
  return payload;
}

export { parseClientAnniversaries };
export function createClientAnniversariesClient({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
  return {
    async read({ signal }: { signal?: AbortSignal } = {}): Promise<Snapshot> {
      const response = await fetchAnniversaries(
        "/api/v1/intelligence/client-anniversary-read?horizon_days=30&limit=20&offset=0",
        signal,
        fetchImpl,
      );
      if (!response.ok && response.status !== 503) throw Error("Closing anniversaries unavailable");
      const payload: unknown = await response.json();
      if (!response.ok && (!object(payload) || payload.state !== "unavailable"))
        throw Error("Closing anniversaries unavailable");
      parseClientAnniversaries(payload);
      // Keep the producer evidence fields after validating the snapshot.
      return payload as Snapshot;
    },
  };
}

type AnniversaryRead = Snapshot | Row[];

type State =
  | { kind: "idle" | "loading" }
  | { kind: "refusal"; message: string }
  | { kind: "loaded"; value: AnniversaryRead };
type PanelProps = {
  load: (signal: AbortSignal) => Promise<AnniversaryRead>;
  fromEngine: boolean;
  cutover: ReturnType<typeof dealCutover>;
  win: Window | null;
  dispose: () => void;
};

function Panel({ load, fromEngine, cutover, win, dispose }: PanelProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const pending = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
  }, []);
  const reset = useCallback(() => {
    cancel();
    setState({ kind: "idle" });
  }, [cancel]);
  const open = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ kind: "loading" });
    try {
      const value = await load(controller.signal);
      if (pending.current === controller) setState({ kind: "loaded", value });
    } catch {
      if (pending.current === controller)
        setState({ kind: "refusal", message: "Closing anniversaries could not be loaded. Try again." });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [load]);
  useEffect(() => {
    win?.addEventListener("pagehide", dispose);
    win?.addEventListener("doctorcre-session-invalidated", dispose);
    void open();
    return () => {
      win?.removeEventListener("pagehide", dispose);
      win?.removeEventListener("doctorcre-session-invalidated", dispose);
      cancel();
    };
  }, [win, dispose, open, cancel]);
  const result = state.kind === "loaded" ? state.value : null;
  const snapshot = Array.isArray(result) ? null : result;
  const rows = Array.isArray(result)
    ? result.map((row) => ({ row, key: row.deal_id }))
    : snapshot?.rows.map((row) => ({ row, key: row.evidence_ref }));
  const empty = snapshot ? snapshot.state === "empty" : rows?.length === 0;
  return (
    <section aria-label="Closing anniversaries" style={{ overflowWrap: "anywhere" }}>
      {!fromEngine && !cutover && <h2>Closing anniversaries</h2>}
      {cutover && <p>Covers deals closed before {cutover.label}.</p>}
      <button
        type="button"
        className="action"
        aria-expanded={state.kind !== "idle"}
        aria-controls="anniversaryContent"
        onClick={() => {
          if (state.kind === "idle") void open();
          else reset();
        }}
      >
        {state.kind === "idle" ? "Show closing anniversaries" : "Hide closing anniversaries"}
      </button>
      <div
        id="anniversaryContent"
        hidden={state.kind === "idle"}
        aria-live="polite"
        aria-busy={state.kind === "loading"}
      >
        {!fromEngine && state.kind !== "idle" && (
          <p>
            {cutover
              ? "Upcoming anniversaries in the next 30 days."
              : "Next 30 days · America/Chicago calendar · First slice of at most 20. This is not a complete client census."}
          </p>
        )}
        {state.kind === "loading" && <p role="status">Loading closing anniversaries…</p>}
        {state.kind === "refusal" && (
          <>
            <p role="alert">{state.message}</p>
            <button type="button" className="action" onClick={() => void open()}>
              Retry closing anniversaries
            </button>
          </>
        )}
        {rows && (
          <>
            {empty && (
              <p>
                {fromEngine || cutover
                  ? "No closing anniversaries in the next 30 days."
                  : "No closing anniversaries in this slice."}
              </p>
            )}
            {snapshot?.state === "unavailable" && <p role="alert">Closing anniversaries are unavailable.</p>}
            {snapshot?.state === "needs_input" && <p role="alert">Closing anniversaries need input.</p>}
            {(snapshot?.state === "unavailable" || snapshot?.state === "needs_input") && (
              <button type="button" className="action" onClick={() => void open()}>
                Retry closing anniversaries
              </button>
            )}
            {snapshot && !cutover && (
              <p>
                As of {snapshot.as_of}. Scanned {snapshot.coverage.scanned}. Skipped invalid{" "}
                {snapshot.coverage.skipped_invalid}.
              </p>
            )}
            {snapshot && snapshot.next_offset !== null && (
              <p>
                {cutover
                  ? "Showing the next 20 closing anniversaries."
                  : "More anniversary rows exist. This first slice shows at most 20."}
              </p>
            )}
            <ol>
              {rows.map(({ row: r, key }) => (
                <li key={key}>
                  <a href={`/clients?record=${encodeURIComponent(r.client_id)}`}>
                    {r.client_name.trim() ? r.client_name : "Unnamed client"}
                  </a>
                  {" · "}
                  <a href={`/deals?deal=${encodeURIComponent(r.deal_id)}`}>
                    {r.deal_name.trim() ? r.deal_name : "Unnamed deal"}
                  </a>
                  <p>
                    Closed <time dateTime={r.closed_on}>{r.closed_on}</time>
                    {" · "}Anniversary <time dateTime={r.anniversary_on}>{r.anniversary_on}</time>
                    {" · "}
                    {r.years} years{" · "}
                    {r.days_until} days until
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

export function mountClientAnniversaries(host: HTMLElement, { load }: Partial<Pick<PanelProps, "load">> = {}) {
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    flushSync(() => root.unmount());
  };
  const document = host.ownerDocument;
  const fromEngine = document.documentElement.getAttribute("data-partner-sign-in") === "engine";
  const cutover = fromEngine ? null : dealCutover(document);
  const read =
    load ?? (fromEngine ? readEngineAnniversaries : (signal) => createClientAnniversariesClient().read({ signal }));
  flushSync(() =>
    root.render(
      <Panel load={read} fromEngine={fromEngine} cutover={cutover} win={document.defaultView} dispose={dispose} />,
    ),
  );
  return { dispose };
}
