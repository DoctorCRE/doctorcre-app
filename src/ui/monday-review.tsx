import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ProspectClient, ProspectFollowUp, ProspectNote } from "./prospect-saves";

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
  reviewed: (Stamp & { id: string | null }) | null;
  seen: number | null;
  reviewVersion: number | null;
  followUps: { owner: string | null; next_step_id: string; change_id: number }[];
};
type DealEdit = { kind: "note"; text: string } | { kind: "step"; text: string; due: string | null };
type ReviewEdits = {
  actor: string;
  today: string;
  prospect: ProspectClient;
  mark: (row: ReviewItem, confirm: boolean) => ReturnType<ProspectClient["saveProspect"]>;
  deal: (row: ReviewItem, edit: DealEdit) => Promise<{ status: string } | null>;
};
type ReviewData = {
  read: () => Promise<unknown>;
  edits: () => Promise<ReviewEdits | null>;
  dealNotes: (id: string) => Promise<Note[]>;
  phaseLabel: (phase: string) => string | undefined;
  dateLabel: (date: string) => string | null;
  timeLabel: (time: string | null) => string;
  authorLabel: (author: string | null) => string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const version = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
    const steps = Array.isArray(row.follow_ups) ? row.follow_ups.filter(record) : [];
    const step = steps[0];
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
      step: text(deal ? row.next_step : step?.what),
      due: text(deal ? row.next_date : step?.due_on),
      note: note && summary ? { ...stamp(note), id, summary } : null,
      reviewed: record(row.reviewed) ? { ...stamp(row.reviewed), id: text(row.reviewed.review_id) } : null,
      seen: version(row.seen),
      reviewVersion: version(row.seen_change_id),
      followUps: steps.flatMap((value) => {
        const next_step_id = text(value.next_step_id),
          change_id = version(value.change_id);
        return next_step_id && change_id !== null ? [{ next_step_id, change_id, owner: text(value.owner) }] : [];
      }),
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

function DealNotes({ id, data, list, revision }: { id: string; data: ReviewData; list: boolean; revision: number }) {
  const [open, setOpen] = useState(!list);
  const [notes, setNotes] = useState<Note[] | "unavailable" | null>(null);
  const load = useCallback(() => {
    void data.dealNotes(id).then(setNotes, () => setNotes("unavailable"));
  }, [data.dealNotes, id]);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (open && (notes === null || lastRevision.current !== revision)) {
      lastRevision.current = revision;
      load();
    }
  }, [open, load, notes, revision]);
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

function DealEditor({
  row,
  edits,
  saved,
  kind,
}: {
  row: ReviewItem;
  edits: ReviewEdits;
  saved: () => void;
  kind: "note" | "step";
}) {
  const original = useRef<ReviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const note = kind === "note";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    const text = String(values.get("text") ?? "").trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await edits.deal(
        original.current ?? row,
        note ? { kind, text } : { kind, text, due: String(values.get("due") || "") || null },
      );
      if (result?.status === "ok") {
        original.current = null;
        if (note) form.reset();
        setMessage(note ? "Note added." : "Next step saved.");
        saved();
      } else if (result?.status === "conflict") {
        original.current = null;
        setMessage("Changed by the other partner. Review reloaded.");
        saved();
      } else setMessage("Could not confirm the save. Try again with the same text.");
    } catch {
      setMessage("Could not confirm the save. Try again with the same text.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="field"
      onSubmit={(event) => void submit(event)}
      onChange={() => {
        if (!note) original.current ??= row;
      }}
    >
      <label>
        {note ? "Add note" : "Next step"}
        <input name="text" disabled={busy} required defaultValue={note ? "" : (row.step ?? "")} />
      </label>
      {!note && (
        <>
          <label>
            Due date
            <input name="due" type="date" min={edits.today} disabled={busy} defaultValue={row.due ?? ""} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Save next step
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </form>
  );
}

function ReviewActions({
  row,
  edits,
  list,
  saved,
  marked,
}: {
  row: ReviewItem;
  edits: ReviewEdits;
  list: boolean;
  saved: () => void;
  marked: (row: ReviewItem, changedByOtherPartner: boolean) => void;
}) {
  const pendingRow = useRef<ReviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function mark() {
    if (busy) return;
    setBusy(true);
    try {
      const request = pendingRow.current ?? row;
      const result = await edits.mark(request, pending);
      if (result.ok || result.problem.error === "version_conflict" || result.problem.error === "not_found") {
        pendingRow.current = null;
        setPending(false);
        setFailed(false);
        marked(request, !result.ok);
      } else {
        pendingRow.current = result.pending ? request : null;
        setPending(result.pending);
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }
  const note =
    row.kind === "deal" ? (
      <DealEditor row={row} edits={edits} saved={saved} kind="note" />
    ) : (
      <ProspectNote id={row.id} client={edits.prospect} saved={saved} />
    );
  return (
    <>
      {row.reviewVersion !== null && (!row.reviewed || row.reviewed.id) && (
        <button className="btn" type="button" disabled={busy} onClick={() => void mark()}>
          {pending ? "Check outcome" : row.reviewed ? "Undo" : "Reviewed"}
        </button>
      )}
      {failed && <p role="alert">Could not confirm the review mark.</p>}
      {list ? (
        <details>
          <summary>Add note</summary>
          {note}
        </details>
      ) : (
        note
      )}
      <details>
        <summary>{row.kind === "deal" ? "Change next step" : "Follow-up"}</summary>
        {row.kind === "deal" ? (
          <DealEditor row={row} edits={edits} saved={saved} kind="step" />
        ) : (
          <ProspectFollowUp
            id={row.id}
            client={edits.prospect}
            saved={saved}
            reload={saved}
            current={row.followUps.find((step) => step.owner === edits.actor)}
          />
        )}
      </details>
    </>
  );
}

function Item({
  item,
  data,
  list,
  mode,
  revision,
}: {
  item: ReviewItem;
  data: ReviewData;
  list: boolean;
  mode: string | null;
  revision: number;
}) {
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
        <DealNotes id={item.id} data={data} list={list} revision={revision} />
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
  const [edits, setEdits] = useState<ReviewEdits | null>(null);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const restored = useRef(false);
  const reload = useCallback(
    async (initial = false) => {
      const request = ++sequence.current;
      try {
        const fresh = parseReview(await data.read());
        if (request === sequence.current) {
          setRows(fresh);
          setRevision(request);
        }
        return fresh;
      } catch {
        if (request === sequence.current) {
          if (initial) setRows("unavailable");
          else setMessage("Could not reload Monday review. Refresh to see the latest changes.");
        }
        return null;
      }
    },
    [data],
  );
  function load() {
    setRows(null);
    void reload(true);
  }
  useEffect(() => {
    void reload(true);
    void data.edits().then(setEdits, () => setEdits(null));
  }, [data, reload]);
  useEffect(() => {
    if (!Array.isArray(rows) || restored.current) return;
    restored.current = true;
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
    setMessage("");
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

  async function marked(row: ReviewItem, changedByOtherPartner: boolean) {
    const fresh = await reload();
    if (!fresh) return;
    if (changedByOtherPartner) {
      setMessage("Changed by the other partner. Review reloaded.");
      return;
    }
    const stamp = fresh.find((candidate) => itemKey(candidate) === itemKey(row))?.reviewed;
    const current = new URLSearchParams(location.search);
    if (
      list ||
      row.reviewed ||
      !stamp ||
      current.get("layout") === "list" ||
      (current.has("item") && current.get("item") !== itemKey(row))
    ) {
      setMessage("");
      return;
    }
    const next = visible[visible.findIndex((candidate) => itemKey(candidate) === itemKey(row)) + 1];
    if (next) {
      show(false, unreviewed, next);
      setMessage(`${row.name} reviewed by ${data.authorLabel(stamp.by)} · ${data.timeLabel(stamp.at)}`);
    }
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
        {message && <p role="status">{message}</p>}
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
                      <Item
                        key={list ? "list" : "single"}
                        item={row}
                        data={data}
                        list={list}
                        mode={mode}
                        revision={revision}
                      />
                      {edits && (
                        <ReviewActions
                          row={row}
                          edits={edits}
                          list={list}
                          saved={() => {
                            void reload();
                          }}
                          marked={(item, stale) => {
                            void marked(item, stale);
                          }}
                        />
                      )}
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
