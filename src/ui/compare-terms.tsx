import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

// The engine's Compare terms read: offer rounds and signed lease versions on deals in one market.
const TERMS = {
  rent_per_sf_yr: { label: "Rent", money: true, unit: "/sf/yr" },
  nnn_per_sf_yr: { label: "NNN", money: true, unit: "/sf/yr" },
  ti_per_sf: { label: "TI", money: true, unit: "/sf" },
  free_rent_months: { label: "Free rent", money: false, unit: " months" },
  term_months: { label: "Term", money: false, unit: " months" },
  escalation_pct: { label: "Escalation", money: false, unit: "% a year" },
} as const;
type Term = keyof typeof TERMS;
const STAGES = { round: "Offer round", lease: "Signed lease" } as const;
type Stage = keyof typeof STAGES;
type Row = {
  deal_id: string;
  deal_name: string;
  property: { id: string; name: string | null; address: string };
  stage: Stage;
  number: number;
  recorded_on: string | null;
  term: Term;
  value: number;
  expense_structure: string | null;
  superseded: boolean;
  documents: { id: string; name: string }[];
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type Options = { request: Request; market?: string | null };
type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: Row[]; asOf: string };

const isText = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRow = (row: unknown): row is Row =>
  isRecord(row) &&
  isText(row.deal_id) &&
  isText(row.deal_name) &&
  isRecord(row.property) &&
  isText(row.property.address) &&
  Object.hasOwn(STAGES, String(row.stage)) &&
  Number.isSafeInteger(row.number) &&
  (row.recorded_on === null || isText(row.recorded_on)) &&
  Object.hasOwn(TERMS, String(row.term)) &&
  Number.isFinite(row.value) &&
  (row.expense_structure === null || isText(row.expense_structure)) &&
  typeof row.superseded === "boolean" &&
  Array.isArray(row.documents) &&
  row.documents.every((document) => isRecord(document) && isText(document.id) && isText(document.name));

export function parseCompareTerms(value: unknown): Row[] | null {
  return isRecord(value) &&
    value.schema_version === "compare-terms.v1" &&
    Array.isArray(value.rows) &&
    value.rows.every(isRow)
    ? value.rows
    : null;
}

const dateWords = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const inWords = (date: string) => dateWords.format(new Date(`${date}T00:00:00Z`));
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function figure({ term, value }: Row) {
  const { label, money: usd, unit } = TERMS[term];
  return `${label}: ${usd ? money.format(value) : number.format(value)}${unit}`;
}
const basisKey = (row: Row) => row.expense_structure ?? "";

function CompareTerms({ request, market, refreshRef }: Options & { refreshRef: { current: () => void } }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [term, setTerm] = useState("");
  const [stage, setStage] = useState("");
  const [basis, setBasis] = useState<string | null>(null);
  const [hideSuperseded, setHideSuperseded] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const sequence = useRef(0);

  async function load() {
    const current = ++sequence.current;
    const fields = form.current ? new FormData(form.current) : new FormData();
    const params = new URLSearchParams();
    for (const name of ["market", "use_type", "as_of"]) {
      const value = String(fields.get(name) ?? "").trim();
      if (value) params.set(name, value);
    }
    setView({ kind: "loading" });
    try {
      const response = await request(`/api/engine/market-terms?${params}`, { headers: { accept: "application/json" } });
      const rows = response.ok ? parseCompareTerms(await response.json()) : null;
      if (current !== sequence.current) return;
      if (!rows) throw Error("Compare terms unavailable");
      setView({ kind: "ready", rows, asOf: params.get("as_of") ?? "" });
    } catch {
      if (current === sequence.current) setView({ kind: "error", message: "Comparable terms are unavailable." });
    }
  }
  refreshRef.current = () => void load();
  const initialize = useEffectEvent(() => void load());
  useEffect(() => {
    initialize();
    return () => {
      sequence.current++;
    };
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    void load();
  }

  return (
    <div className="compare-terms">
      <h2>Compare terms</h2>
      <p>Offer rounds and signed leases recorded on our deals. This is not a complete market survey.</p>
      <form className="market-filters" ref={form} onSubmit={submit}>
        <label>
          Market
          <input name="market" maxLength={200} defaultValue={market ?? ""} />
        </label>
        <label>
          Use type
          <input name="use_type" maxLength={200} />
        </label>
        <label>
          As of date (optional)
          <input name="as_of" type="date" min="0001-01-01" max="9999-12-31" aria-describedby="market-date-help" />
        </label>
        <button className="btn" type="submit">
          Compare
        </button>
      </form>
      <p id="market-date-help">Leave the date blank for all recorded history.</p>
      <div data-market-results role="status">
        {view.kind === "loading" ? (
          "Loading comparable terms…"
        ) : view.kind === "error" ? (
          <>
            {view.message}{" "}
            <button className="btn" type="button" onClick={() => void load()}>
              Retry
            </button>
          </>
        ) : (
          <Results
            view={view}
            filters={{ term, stage, basis, hideSuperseded }}
            set={{ term: setTerm, stage: setStage, basis: setBasis, hideSuperseded: setHideSuperseded }}
          />
        )}
      </div>
    </div>
  );
}

type Filters = { term: string; stage: string; basis: string | null; hideSuperseded: boolean };
type Setters = { [K in keyof Filters]: (value: Filters[K]) => void };

function Results({ view, filters, set }: { view: Extract<View, { kind: "ready" }>; filters: Filters; set: Setters }) {
  const heading = (
    <p>
      <strong>{view.asOf ? `Terms as of ${inWords(view.asOf)}` : "All recorded history"}</strong>
    </p>
  );
  if (!view.rows.length)
    return (
      <>
        {heading}
        <p>No offer rounds or signed leases are recorded on deals in this market yet.</p>
      </>
    );
  const terms = Object.entries(TERMS).filter(([key]) => view.rows.some((row) => row.term === key));
  const stages = Object.entries(STAGES).filter(([key]) => view.rows.some((row) => row.stage === key));
  const bases = [...new Set(view.rows.map(basisKey))].sort((a, b) => (a && b ? a.localeCompare(b) : a ? -1 : 1));
  // A saved choice missing from these rows filters as "All", which is what its dropdown shows.
  const term = terms.some(([key]) => key === filters.term) ? filters.term : "";
  const stage = stages.some(([key]) => key === filters.stage) ? filters.stage : "";
  const basis = filters.basis !== null && bases.includes(filters.basis) ? filters.basis : null;
  const dropped = [
    term !== filters.term && "term",
    stage !== filters.stage && "recorded stage",
    basis !== filters.basis && "expense basis",
  ].filter((name) => name !== false);
  const rows = view.rows.flatMap((row, key) =>
    (!filters.hideSuperseded || !row.superseded) &&
    (!term || row.term === term) &&
    (!stage || row.stage === stage) &&
    (basis === null || basisKey(row) === basis)
      ? [{ row, key }]
      : [],
  );
  const deals = new Set(rows.map(({ row }) => row.deal_id)).size;
  return (
    <>
      {heading}
      {dropped.map((name) => (
        <p key={name}>
          The selected {name} is not in these results. Showing all{" "}
          {name === "expense basis" ? "expense bases" : `${name}s`}.
        </p>
      ))}
      <div className="market-filters">
        <label>
          Term
          <select value={term} onChange={(event) => set.term(event.target.value)}>
            <option value="">All terms</option>
            {terms.map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recorded stage
          <select value={stage} onChange={(event) => set.stage(event.target.value)}>
            <option value="">All recorded stages</option>
            {stages.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expense basis
          <select
            value={basis === null ? "" : `basis:${basis}`}
            onChange={(event) => set.basis(event.target.value ? event.target.value.slice(6) : null)}
          >
            <option value="">All expense bases</option>
            {bases.map((key) => (
              <option key={key} value={`basis:${key}`}>
                {key || "Not recorded"}
              </option>
            ))}
          </select>
        </label>
        <label className="compare-terms-check">
          <input
            type="checkbox"
            checked={filters.hideSuperseded}
            onChange={(event) => set.hideSuperseded(event.target.checked)}
          />
          Hide superseded terms
        </label>
      </div>
      <p>
        <strong>
          {rows.length} matching {rows.length === 1 ? "term" : "terms"} across {deals} {deals === 1 ? "deal" : "deals"}.
        </strong>
      </p>
      {!rows.length ? (
        <p>No comparable terms match these filters.</p>
      ) : (
        <table className="market-terms-table">
          <thead>
            <tr>
              {["Date", "Deal", "Property", "Stage", "Term", "Expense basis", "Source"].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, key }) => (
              <tr key={key} className={row.superseded ? "superseded" : undefined}>
                <td data-label="Date">{row.recorded_on ? inWords(row.recorded_on) : "Date not recorded"}</td>
                <td data-label="Deal">
                  <a href={`/deals?deal=${encodeURIComponent(row.deal_id)}`}>{row.deal_name}</a>
                </td>
                <td data-label="Property">{row.property.name || row.property.address}</td>
                <td data-label="Stage">
                  {row.stage === "round" ? `Offer round ${row.number}` : `Signed lease, version ${row.number}`}
                  {row.superseded ? " · superseded" : ""}
                </td>
                <td data-label="Term">{figure(row)}</td>
                <td data-label="Expense basis">{row.expense_structure ?? "Not recorded"}</td>
                <td data-label="Source">
                  {row.documents.length
                    ? row.documents.map((document, index) => (
                        <span key={document.id}>
                          {index > 0 && "; "}
                          <a href={`/api/engine/documents/${encodeURIComponent(document.id)}`}>{document.name}</a>
                        </span>
                      ))
                    : `Offer round ${row.number}, no document filed`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function mountCompareTerms(root: HTMLElement, options: Options) {
  const reactRoot = createRoot(root),
    refreshRef = { current: () => {} };
  flushSync(() => reactRoot.render(<CompareTerms {...options} refreshRef={refreshRef} />));
  return { refresh: () => refreshRef.current(), dispose: () => reactRoot.unmount() };
}
