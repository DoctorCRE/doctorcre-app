import { useEffect, useId, useRef, useState } from "react";
import { DealPicker } from "../deal-picker.tsx";
import type { FilingChoice, FilingReasonRefusal } from "./engine-review.ts";
import { type InboxClient, object } from "./inbox.tsx";

export type FilingDestination = { deal_id: string } | { vendor_id: string };
type FileEmail = (destination: FilingDestination, reason?: string) => void;
type CheckReason = NonNullable<InboxClient["review"]>["checkFilingReason"];
type Selection = { id: string };
type RecordOption = { id: string; name: string };
type Targets = { rows: RecordOption[]; pages: number };
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

async function readDealBoard(signal: AbortSignal): Promise<unknown> {
  const { createClient } = await sibling("./client.js");
  const client = await createClient("live", { docContext: false });
  return client.getBoard({ workspace: "all", signal });
}

async function readVendors(query: string, page: number, signal: AbortSignal): Promise<Targets> {
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
  const { rows, page_count: pages } = payload;
  if (!Array.isArray(rows)) throw Error("Vendor records unavailable.");
  return {
    rows: rows.flatMap((row: unknown) =>
      object(row) && typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [],
    ),
    pages,
  };
}

function DealFilingPicker({
  proposalId,
  checkReason,
  file,
  refusal,
}: {
  proposalId: string;
  checkReason: CheckReason;
  file: FileEmail;
  refusal: FilingReasonRefusal | null;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [check, setCheck] = useState<{
    selection: Selection;
    result: Awaited<ReturnType<CheckReason>> | "unavailable";
  } | null>(null);
  const [reason, setReason] = useState("");
  const reasonInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const preview = check?.selection === selection ? check.result : undefined;
  const checked = preview !== undefined && preview !== "unavailable";
  const refusalHint = refusal?.dealId === selection?.id ? refusal?.message : undefined;
  const hint = refusalHint || (checked ? preview.hint : null);
  const needsReason = Boolean(refusalHint) || (checked && preview.required);
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    void checkReason(proposalId, selection.id, controller.signal)
      .catch(() => "unavailable" as const)
      .then((result) => {
        if (!controller.signal.aborted) setCheck({ selection, result });
      });
    return () => controller.abort();
  }, [selection, proposalId, checkReason]);
  useEffect(() => {
    if (refusalHint) reasonInput.current?.focus();
  }, [refusalHint]);

  return (
    <div>
      <DealPicker
        readBoard={readDealBoard}
        onSelect={(deal) => {
          setSelection(deal);
          setReason("");
        }}
      />
      {selection && preview === undefined && <p role="status">Checking filing requirements…</p>}
      {selection && preview === "unavailable" && (
        <p role="status">
          Could not check this deal.{" "}
          <button type="button" onClick={() => setSelection({ id: selection.id })}>
            Retry
          </button>
        </p>
      )}
      {checked && (
        <label>
          Reason for filing
          <input
            ref={reasonInput}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            required={needsReason}
            aria-required={needsReason || undefined}
            aria-invalid={(Boolean(refusalHint) && !reason.trim()) || undefined}
            aria-describedby={hint ? hintId : undefined}
          />
        </label>
      )}
      {hint && (
        <p id={hintId} role={refusalHint ? "alert" : "status"}>
          {hint}
        </p>
      )}
      <button
        type="button"
        disabled={!checked || (needsReason && !reason.trim())}
        onClick={() => selection && file({ deal_id: selection.id }, reason.trim())}
      >
        File email
      </button>
    </div>
  );
}

function VendorPicker({ file }: { file: FileEmail }) {
  const [search, setSearch] = useState("");
  const [request, setRequest] = useState({ query: "", page: 1 });
  const [targets, setTargets] = useState<Targets | "unavailable" | null>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void readVendors(request.query, request.page, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setTargets(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTargets("unavailable");
      });
    return () => controller.abort();
  }, [request]);

  function load(query: string, page: number) {
    setTargets(null);
    setSelected("");
    setRequest({ query, page });
  }
  return (
    <div>
      <label>
        Vendor name{" "}
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setSelected("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              load(search.trim(), 1);
            }
          }}
        />
      </label>
      <button type="button" onClick={() => load(search.trim(), 1)}>
        Search vendors
      </button>
      {targets === null ? (
        <p role="status">Loading vendors…</p>
      ) : targets === "unavailable" ? (
        <p role="status">
          Could not load vendors.{" "}
          <button type="button" onClick={() => load(request.query, request.page)}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <label>
            Vendor{" "}
            <select
              value={selected}
              onChange={(event) => setSelected(event.currentTarget.value)}
              disabled={!targets.rows.length}
            >
              <option value="">{targets.rows.length ? "Select a vendor" : "No vendors found"}</option>
              {targets.rows.map(({ id, name }) => (
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
          <button type="button" disabled={!selected} onClick={() => file({ vendor_id: selected })}>
            File email
          </button>
        </>
      )}
    </div>
  );
}

export function FilingControls({
  proposalId,
  checkReason,
  choices,
  askDocHref,
  file,
  dismiss,
  refusal,
}: {
  proposalId: string;
  checkReason: CheckReason;
  choices: FilingChoice[];
  askDocHref: string | undefined;
  file: FileEmail;
  dismiss(opener: HTMLButtonElement): void;
  refusal: FilingReasonRefusal | null;
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
        {askDocHref && (
          <a className="btn" href={askDocHref}>
            Ask Doc
          </a>
        )}
        <button type="button" onClick={(event) => dismiss(event.currentTarget)}>
          Dismiss
        </button>
      </div>
      {active?.kind === "deal" && (
        <DealFilingPicker proposalId={proposalId} checkReason={checkReason} file={file} refusal={refusal} />
      )}
      {active?.kind === "vendor" && <VendorPicker file={file} />}
    </>
  );
}
