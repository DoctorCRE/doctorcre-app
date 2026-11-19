import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Stamp = { by: string | null; at: string | null };
type Note = Stamp & { id: string; summary: string };
type ReviewItem = {
  kind: "deal" | "prospect";
  id: string;
  name: string;
  owner: string | null;
  phase: string | null;
  status: string | null;
  attention: boolean;
  step: string | null;
  due: string | null;
  note: Note | null;
  reviewed: Stamp | null;
};
type ReviewData = {
  read: () => Promise<unknown>;
  dealNotes: (id: string) => Promise<Note[]>;
  phaseLabel: (phase: string) => string | undefined;
  dateLabel: (date: string) => string | null;
  timeLabel: (time: string | null) => string;
  authorLabel: (author: string | null) => string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const stamp = (value: Record<string, unknown>) => ({ by: text(value.by), at: text(value.at) });
const itemKey = (item: ReviewItem) => `${item.kind}-${item.id}`;

function parseReview(result: unknown): ReviewItem[] {
  if (!record(result) || !Array.isArray(result.items)) throw new Error("Invalid review");
  return result.items.map((row: unknown) => {
    if (!record(row)) throw new Error("Invalid review item");
    const deal = text(row.deal_id);
    const id = deal ?? text(row.party_id);
    const name = text(row.name);
    if (!id || !name) throw new Error("Invalid review item");
    const step = Array.isArray(row.follow_ups) && record(row.follow_ups[0]) ? row.follow_ups[0] : {};
    const note = record(row.latest_note) ? row.latest_note : null;
    const summary = text(note?.summary);
    return {
      kind: deal ? "deal" : "prospect",
      id,
      name,
      owner: text(row.owner),
      phase: text(row.phase),
      status:
        row.state === "closed"
          ? "Closed"
          : row.state === "lost"
            ? "Lost"
            : row.state === "dropped"
              ? "Dropped"
              : row.operating_state === "parked"
                ? "Parked"
                : null,
      attention: row.attention === true || row.needs_attention === true,
      step: text(deal ? row.next_step : step.what),
      due: text(deal ? row.next_date : step.due_on),
      note: note && summary ? { ...stamp(note), id, summary } : null,
      reviewed: record(row.reviewed) ? stamp(row.reviewed) : null,
    };
  });
}

function Notes({ notes, data }: { notes: Note[]; data: ReviewData }) {
  return notes.length ? (
    notes.map((note) => (
      <div key={note.id}>
        <p>
          <strong>{data.authorLabel(note.by)}</strong> · {data.timeLabel(note.at)}
        </p>
        <p className="note-original">{note.summary}</p>
      </div>
    ))
  ) : (
    <p>No notes yet.</p>
  );
}

function DealNotes({ id, data, list }: { id: string; data: ReviewData; list: boolean }) {
  const [open, setOpen] = useState(!list);
  const [notes, setNotes] = useState<Note[] | "unavailable" | null>(null);
  const load = useCallback(() => {
    setNotes(null);
    void data.dealNotes(id).then(setNotes, () => setNotes("unavailable"));
  }, [data, id]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Latest notes</summary>
      {notes === "unavailable" ? (
        <p>
          Could not load notes.{" "}
          <button className="btn" type="button" onClick={load}>
            Retry
          </button>
        </p>
      ) : notes ? (
        <Notes notes={notes} data={data} />
      ) : (
        <p>Loading notes…</p>
      )}
    </details>
  );
}

function Item({ item, data, list, mode }: { item: ReviewItem; data: ReviewData; list: boolean; mode: string | null }) {
  const deal = item.kind === "deal";
  const params = new URLSearchParams({ [deal ? "deal" : "prospect"]: item.id });
  if (mode) params.set("mode", mode);
  const phase = deal ? data.phaseLabel(item.phase ?? "") : "Prospect";
  const owner = item.owner ? data.authorLabel(item.owner) : deal ? "Unassigned" : "Unclaimed";
  const due = item.due ? data.dateLabel(item.due) : null;
  const key = itemKey(item);
  return (
    <>
      <h2>
        <a
          id={key}
          href={`/deals?${params}`}
          onClick={() => {
            history.replaceState({ ...history.state, reviewScroll: scrollY, reviewLink: key }, "");
          }}
        >
          {item.name}
        </a>
      </h2>
      <p>
        {[phase, owner, item.status !== phase && item.status, item.attention && "Needs attention"]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p>
        {item.step ? (
          <>
            {item.step}
            {due && ` · Due ${due}`}
          </>
        ) : deal ? (
          "No next step set."
        ) : (
          "No follow-up set."
        )}
      </p>
      {item.reviewed && (
        <p>
          Reviewed by {data.authorLabel(item.reviewed.by)} · {data.timeLabel(item.reviewed.at)}
        </p>
      )}
      {deal ? (
        <DealNotes id={item.id} data={data} list={list} />
      ) : (
        <Notes data={data} notes={item.note ? [item.note] : []} />
      )}
    </>
  );
}

function Review({ data }: { data: ReviewData }) {
  const [url] = useState(() => new URL(location.href));
  const [list, setList] = useState(url.searchParams.get("layout") === "list");
  const [unreviewed, setUnreviewed] = useState(url.searchParams.has("unreviewed"));
  const [selected, setSelected] = useState(url.searchParams.get("item"));
  const [rows, setRows] = useState<ReviewItem[] | "unavailable" | null>(null);
  const mode = url.searchParams.get("mode");
  function load() {
    setRows(null);
    void data
      .read()
      .then(parseReview)
      .then(setRows, () => setRows("unavailable"));
  }
  useEffect(load, [data]);
  useEffect(() => {
    if (!Array.isArray(rows)) return;
    scrollTo(0, history.state?.reviewScroll ?? 0);
    document.getElementById(history.state?.reviewLink)?.focus({ preventScroll: true });
  }, [rows]);

  const visible = Array.isArray(rows) ? rows.filter((row) => !unreviewed || !row.reviewed) : [];
  const index = Math.max(
    0,
    visible.findIndex((row) => itemKey(row) === selected),
  );
  const item = visible[index];
  function show(nextList: boolean, nextFilter: boolean, nextItem = item) {
    setList(nextList);
    setUnreviewed(nextFilter);
    setSelected(nextItem ? itemKey(nextItem) : null);
    if (nextList) url.searchParams.set("layout", "list");
    else url.searchParams.delete("layout");
    if (nextFilter) url.searchParams.set("unreviewed", "1");
    else url.searchParams.delete("unreviewed");
    if (nextItem) url.searchParams.set("item", itemKey(nextItem));
    else url.searchParams.delete("item");
    history.replaceState(history.state, "", url);
  }

  return (
    <>
      <header>
        <a href={mode === "live" ? "/deals?mode=live" : "/deals"}>← Back to deals</a>
        <h1 id="mondayReviewTitle">Monday review</h1>
        <p role="status">
          {rows === "unavailable"
            ? "Could not load Monday review."
            : rows
              ? `${rows.filter((row) => row.reviewed).length} of ${rows.length} reviewed this week`
              : "Loading this week’s review…"}
        </p>
      </header>
      {rows === "unavailable" && (
        <button className="btn" type="button" onClick={load}>
          Retry
        </button>
      )}
      {Array.isArray(rows) && (
        <>
          <fieldset className="deal-heading-actions monday-review-controls" aria-label="Review view">
            <button className="chip" type="button" aria-pressed={!list} onClick={() => show(false, unreviewed)}>
              One at a time
            </button>
            <button className="chip" type="button" aria-pressed={list} onClick={() => show(true, unreviewed)}>
              As a list
            </button>
            <label>
              <input type="checkbox" checked={unreviewed} onChange={(event) => show(list, event.target.checked)} /> Not
              reviewed
            </label>
          </fieldset>
          <div data-review-items>
            {!item ? (
              <p>{rows.length ? "No unreviewed items." : "No deals or prospects to review this week."}</p>
            ) : (
              <>
                <ol className="monday-review-items">
                  {(list ? visible : [item]).map((row) => (
                    <li className="card glass monday-review-item" key={itemKey(row)}>
                      <Item key={list ? "list" : "single"} item={row} data={data} list={list} mode={mode} />
                    </li>
                  ))}
                </ol>
                {!list && (
                  <div className="deal-heading-actions">
                    {[
                      { label: "Back", item: visible[index - 1] },
                      { label: "Next", item: visible[index + 1] },
                    ].map((move) => (
                      <button
                        className="btn"
                        type="button"
                        key={move.label}
                        disabled={!move.item}
                        onClick={() => show(false, unreviewed, move.item)}
                      >
                        {move.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function mountMondayReview(root: HTMLElement, data: ReviewData) {
  createRoot(root).render(<Review data={data} />);
}
