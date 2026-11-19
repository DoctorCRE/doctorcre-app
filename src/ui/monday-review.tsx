import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NoteField, type ProspectClient, ProspectFollowUp, ProspectNote } from "./prospect-saves";
import { refreshWhileVisible } from "./visible-refresh";

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
type DealStep = { id: string; change_id?: number | null; description: string; due_on: string | null };
type DealEdit =
  | { kind: "note"; text: string }
  | { kind: "step"; text: string; due: string | null; current: DealStep | null };
type ReviewEdits = {
  actor: string;
  today: string;
  prospect: ProspectClient;
  mark: (row: ReviewItem, confirm: boolean) => ReturnType<ProspectClient["saveProspect"]>;
  step: (id: string) => Promise<DealStep | null>;
  deal: (row: ReviewItem, edit: DealEdit) => Promise<{ status: string; hint?: string; message?: string } | null>;
};
type ReviewData = {
  read: (signal?: AbortSignal) => Promise<{ review: unknown; canEdit: boolean }>;
  edits: () => Promise<ReviewEdits>;
  dealNotes: (id: string, signal: AbortSignal) => Promise<Note[]>;
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

const statusLabels = new Map([
  ["closed", "Closed"],
  ["lost", "Lost"],
  ["dropped", "Dropped"],
  ["parked", "Parked"],
]);

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
        row.state === "closed" || row.state === "lost" || (!deal && row.state === "dropped")
          ? row.state
          : row.operating_state === "parked"
            ? "parked"
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
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [failedRead, setFailedRead] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readVersion = `${revision}:${attempt}`;
  useEffect(() => {
    if (!open) return;
    return refreshWhileVisible(async (signal) => {
      try {
        const fresh = await data.dealNotes(id, signal);
        if (!signal.aborted) setNotes(fresh);
      } catch {
        if (!signal.aborted) setFailedRead(readVersion);
      }
    });
  }, [open, data.dealNotes, id, readVersion]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Latest notes</summary>
      {notes ? (
        <Notes notes={notes} data={data} />
      ) : failedRead === readVersion ? (
        <p>
          Could not load notes.{" "}
          <button className="btn" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </p>
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
  const [current, setCurrent] = useState<DealStep | null | "unavailable">();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const hint = useId();
  const note = kind === "note";
  const step = current === "unavailable" ? null : current;
  const load = useCallback(() => {
    setCurrent(undefined);
    void edits.step(row.id).then(setCurrent, () => setCurrent("unavailable"));
  }, [edits, row.id]);
  useEffect(() => {
    if (!note) load();
  }, [note, load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    const text = String(values.get("text") ?? "").trim(),
      due = String(values.get("due") ?? "") || null;
    if (!text || busy || (!note && (current === undefined || current === "unavailable"))) return;
    if (due && due < edits.today) {
      setMessage("Next date must be today or later.");
      return;
    }
    setBusy(true);
    const result = await edits
      .deal(row, note ? { kind, text } : { kind, text, due, current: step ?? null })
      .catch(() => null);
    if (result?.status === "ok" || result?.status === "conflict") {
      if (!note) load();
      else if (result.status === "ok") form.reset();
      saved();
    }
    setMessage(
      result?.status === "ok"
        ? note
          ? "Note added."
          : "Next step saved."
        : result?.status === "conflict"
          ? (result.hint ?? result.message ?? "The deal changed. Review it before saving again.")
          : (result?.hint ?? "Could not confirm the save. Try again with the same text."),
    );
    setBusy(false);
  }

  const overdue = Boolean(step?.due_on && step.due_on < edits.today);
  return (
    <>
      {!note &&
        (current === undefined ? (
          <p>Loading your next step…</p>
        ) : (
          current === "unavailable" && (
            <p>
              Could not load your next step.{" "}
              <button className="btn" type="button" onClick={load}>
                Retry
              </button>
            </p>
          )
        ))}
      {(note || current === null || step) && (
        <form className="field" noValidate={!note} onSubmit={(event) => void submit(event)}>
          {note ? (
            <NoteField name="text" disabled={busy} />
          ) : (
            <>
              <label>
                Next step
                <input name="text" required disabled={busy} defaultValue={step?.description ?? ""} />
              </label>
              <label>
                Next date
                <input
                  name="due"
                  type="date"
                  min={edits.today}
                  disabled={busy}
                  defaultValue={overdue ? "" : (step?.due_on ?? "")}
                  aria-describedby={overdue ? hint : undefined}
                />
              </label>
              {overdue && <small id={hint}>Current next date is overdue.</small>}
              <button className="btn" type="submit" disabled={busy}>
                Save next step
              </button>
            </>
          )}
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </>
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
  const [pendingRow, setPendingRow] = useState<ReviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [stepOpened, setStepOpened] = useState(false);
  async function mark() {
    if (busy) return;
    setBusy(true);
    try {
      const request = pendingRow ?? row;
      const result = await edits.mark(request, pendingRow !== null);
      if (result.ok || result.problem.error === "version_conflict" || result.problem.error === "not_found") {
        setPendingRow(null);
        setFailure("");
        marked(request, !result.ok);
      } else {
        setPendingRow(result.pending ? request : null);
        const error = text(result.problem.error)?.toLowerCase();
        setFailure(
          result.pending
            ? "Could not confirm the review mark."
            : error === "authorization_refused" || error === "actor_not_provisioned"
              ? "This account cannot change the review mark."
              : error === "authentication_required" || error === "session_changed"
                ? "Sign in again to change the review mark."
                : "The review mark could not be saved. Reload the review and try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const reviewMark = (
    <>
      {row.reviewVersion !== null && (!row.reviewed || row.reviewed.id) && (
        <button className="btn" type="button" disabled={busy} onClick={() => void mark()}>
          {pendingRow ? "Check outcome" : row.reviewed ? "Undo" : "Reviewed"}
        </button>
      )}
      {failure && <p role="alert">{failure}</p>}
    </>
  );
  if (row.status === "dropped") return reviewMark;
  const note =
    row.kind === "deal" ? (
      <DealEditor row={row} edits={edits} saved={saved} kind="note" />
    ) : (
      <ProspectNote id={row.id} client={edits.prospect} saved={saved} />
    );
  return (
    <>
      {reviewMark}
      {list ? (
        <details>
          <summary>Add note</summary>
          {note}
        </details>
      ) : (
        note
      )}
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) setStepOpened(true);
        }}
      >
        <summary>{row.kind === "deal" ? "Change next step" : "Follow-up"}</summary>
        {row.kind === "deal" ? (
          stepOpened && <DealEditor row={row} edits={edits} saved={saved} kind="step" />
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
  if (item.status === "dropped") params.set("view", "dropped-prospect");
  if (mode) params.set("mode", mode);
  const phase = deal ? data.phaseLabel(item.phase ?? "") : "Prospect";
  const status = statusLabels.get(item.status ?? "");
  const owner = item.owner ? data.authorLabel(item.owner) : deal ? "Unassigned" : "Unclaimed";
  const due = item.due ? data.dateLabel(item.due) : null;
  const key = itemKey(item);
  const prospectNotes = <Notes data={data} notes={item.note ? [item.note] : []} />;
  return (
    <>
      <h2>
        <a
          id={key}
          href={`/deals?${params}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const reviewUrl = new URL(location.href);
            reviewUrl.searchParams.set("item", key);
            history.replaceState({ ...history.state, reviewScroll: scrollY, reviewLink: key }, "", reviewUrl);
          }}
        >
          {item.name}
        </a>
      </h2>
      <p>
        {[phase, owner, status !== phase && status, item.attention && "Needs attention"].filter(Boolean).join(" · ")}
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
      ) : list ? (
        <details>
          <summary>Latest notes</summary>
          {prospectNotes}
        </details>
      ) : (
        prospectNotes
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
  const partnerEdits = useRef<Promise<ReviewEdits> | null>(null);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const restored = useRef(false);
  const reload = useCallback(
    async (initial = false) => {
      const request = ++sequence.current;
      try {
        const { review, canEdit } = await data.read();
        const fresh = parseReview(review);
        if (canEdit) {
          partnerEdits.current ??= data.edits().catch((error) => {
            partnerEdits.current = null;
            throw error;
          });
        }
        const editing = canEdit ? await partnerEdits.current?.catch(() => null) : null;
        if (request === sequence.current) {
          setEdits(editing ?? null);
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
  }, [reload]);
  useEffect(() => {
    if (!revision) return;
    return refreshWhileVisible(
      async (signal) => {
        const request = sequence.current;
        try {
          const { review } = await data.read(signal);
          const fresh = new Map(
            parseReview(review)
              .filter((row) => row.kind === "prospect")
              .map((row) => [row.id, row]),
          );
          if (signal.aborted || request !== sequence.current) return;
          // Refresh notes without changing the rows, marks or versions a partner is working through.
          setRows((current) =>
            Array.isArray(current)
              ? current.map((row) => {
                  const incoming = row.kind === "prospect" ? fresh.get(row.id) : undefined;
                  return incoming ? { ...row, note: incoming.note } : row;
                })
              : current,
          );
        } catch {
          // Keep the last notes visible while the next read retries.
        }
      },
      { immediate: false },
    );
  }, [data, revision]);
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
              <p>{rows.length ? "Everything is reviewed this week." : "No deals or prospects to review this week."}</p>
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
