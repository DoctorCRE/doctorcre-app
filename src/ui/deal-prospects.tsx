import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AddProspect, DealClientPicker, ManageProspect } from "./prospect-management";
import {
  type Partner,
  type ProspectClient,
  ProspectFollowUp,
  ProspectNote,
  partners,
  prospectsPath,
  uuid,
} from "./prospect-saves";
import { refreshWhileVisible } from "./visible-refresh";

const howFound: Readonly<Record<string, string>> = {
  referral: "Referral",
  vendor: "Vendor",
  marketing_post: "Marketing post",
  public_records: "Public records",
  cold_outreach: "Cold outreach",
  own_research: "Own research",
  inbound: "Inbound",
  national_account: "National account or corporate lead",
  existing_relationship: "Existing relationship",
  event: "Event",
  not_recorded: "Not recorded",
};

type RequestProspect = (path: string, init?: RequestInit) => Promise<Response>;
type AuthorLabel = (by: string | null) => string;
type StepOriginLabel = (step: ReturnType<typeof parseStep>) => string;
type ProspectActions = {
  addDeal: (client: { id: string; name: string }) => void;
  turnIntoDeal: (
    prospect: Pick<ReturnType<typeof parseProspect>, "party_id" | "name" | "latest_note" | "owner">,
    completed: () => void,
  ) => void;
  backToReview: (() => void) | null;
};
type Filters = { owner: string; attention: boolean; actor: Partner | null; canSave: boolean };
type ProspectVariant = "tile" | "row";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const partner = (value: unknown): value is Partner => value === "joe" || value === "dell";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const label = (value: string | null) => (partner(value) ? partners[value] : value || "Unknown");
const invalid = (): never => {
  throw Error("Prospect data unavailable");
};

function parseNote(value: unknown) {
  if (
    !record(value) ||
    !textOrNull(value.by) ||
    !textOrNull(value.summary) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at))
  )
    return invalid();
  return { by: value.by, summary: value.summary, at: value.at };
}

function parseStep(value: unknown) {
  if (
    !record(value) ||
    typeof value.next_step_id !== "string" ||
    !uuid.test(value.next_step_id) ||
    !partner(value.owner) ||
    typeof value.what !== "string" ||
    !(value.display_title === undefined || typeof value.display_title === "string") ||
    !textOrNull(value.due_on) ||
    (value.due_on !== null && !Number.isFinite(Date.parse(value.due_on))) ||
    typeof value.change_id !== "number" ||
    !Number.isSafeInteger(value.change_id)
  )
    return invalid();
  return {
    next_step_id: value.next_step_id,
    owner: value.owner,
    title: value.display_title?.trim() || value.what,
    due_on: value.due_on,
    change_id: value.change_id,
    set_by: typeof value.set_by === "string" ? value.set_by : null,
    set_at: typeof value.set_at === "string" ? value.set_at : null,
    set_from: typeof value.set_from === "string" ? value.set_from : null,
  };
}

function parseProspect(value: unknown) {
  if (
    !record(value) ||
    typeof value.party_id !== "string" ||
    !uuid.test(value.party_id) ||
    typeof value.name !== "string" ||
    !textOrNull(value.how_found) ||
    !(value.owner === null || partner(value.owner)) ||
    typeof value.needs_attention !== "boolean" ||
    !Array.isArray(value.follow_ups) ||
    typeof value.change_id !== "number" ||
    !Number.isSafeInteger(value.change_id)
  )
    return invalid();
  return {
    party_id: value.party_id,
    name: value.name,
    how_found: value.how_found,
    owner: value.owner,
    needs_attention: value.needs_attention,
    change_id: value.change_id,
    follow_ups: value.follow_ups.map(parseStep),
    latest_note: value.latest_note === null ? null : parseNote(value.latest_note),
  };
}

const centralDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function dateWords(timeZone: string, time?: Intl.DateTimeFormatOptions) {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...time,
  };
  return {
    current: new Intl.DateTimeFormat("en-US", options),
    other: new Intl.DateTimeFormat("en-US", { ...options, year: "numeric" }),
  };
}
const noteDate = dateWords("America/Chicago", { hour: "numeric", minute: "2-digit" });
const dueDate = dateWords("UTC");
const dropDate = dateWords("America/Chicago");
const sameYear = (day: string, today: string) => day.slice(0, 4) === today.slice(0, 4);
function due(day: string | null) {
  if (!day) return "No date set";
  const today = centralDay.format(new Date());
  const late = Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  const formatter = sameYear(day, today) ? dueDate.current : dueDate.other;
  return `Due ${formatter.format(new Date(day))}${late > 0 ? ` (${late} day${late === 1 ? "" : "s"} late)` : ""}`;
}
function noteBy({ by, at }: ReturnType<typeof parseNote>, authorLabel: AuthorLabel) {
  const date = new Date(at);
  const formatter = sameYear(centralDay.format(date), centralDay.format(new Date()))
    ? noteDate.current
    : noteDate.other;
  return `${authorLabel(by)} · ${formatter.format(date)}`;
}
const owner = (value: Partner | null) => (value ? partners[value] : "Unclaimed");

type Read<T> = { value?: T; unavailable?: boolean };
function useProspectRead<T>(
  request: RequestProspect,
  route: string | null,
  revision: number,
  parse: (value: Record<string, unknown>) => T,
  mergeRefresh?: (current: T, incoming: T) => T,
) {
  const [state, setState] = useState<Read<T>>({});
  useEffect(() => {
    if (!route) return;
    const path = route;
    let etag: string | null = null;
    let loaded = false;
    async function read(signal: AbortSignal) {
      try {
        const response = await request(path, etag ? { signal, headers: { "If-None-Match": etag } } : { signal });
        if (response.status === 304) return;
        const value: unknown = await response.json();
        if (!response.ok || !record(value)) return invalid();
        if (signal.aborted) return;
        const incoming = parse(value);
        const merge = loaded ? mergeRefresh : undefined;
        setState((state) => ({ value: merge && state.value !== undefined ? merge(state.value, incoming) : incoming }));
        etag = response.headers.get("etag");
        loaded = true;
      } catch {
        if (!signal.aborted && !loaded) {
          setState((state) => ({ ...(mergeRefresh ? state : {}), unavailable: true }));
        }
      }
    }
    if (revision) setState((state) => (state.value ? state : {}));
    if (mergeRefresh) return refreshWhileVisible(read);
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [request, route, revision, parse, mergeRefresh]);
  return state;
}

function parseDetail(value: Record<string, unknown>) {
  if (!Array.isArray(value.notes)) return invalid();
  const notes = value.notes.map((note: unknown) => {
    if (!record(note) || typeof note.activity_id !== "string") return invalid();
    return { ...parseNote(note), id: note.activity_id };
  });
  const dropped = value.state === "dropped" ? parseDrop(value.dropped) : null;
  const completed = value.completed_follow_up == null ? null : parseStep(value.completed_follow_up);
  return { ...parseProspect(value), notes, dropped, completed };
}

function parseDrop(value: unknown) {
  if (!record(value) || typeof value.at !== "string" || typeof value.reason !== "string") return invalid();
  if (!Number.isFinite(Date.parse(value.at))) return invalid();
  return { at: value.at, reason: value.reason };
}

type Detail = ReturnType<typeof parseDetail>;
function refreshNotes(current: Detail, incoming: Detail): Detail {
  if (Boolean(current.dropped) !== Boolean(incoming.dropped)) return incoming;
  // Keep the edit versions from the opened prospect until an explicit reload or save.
  return { ...current, notes: incoming.notes, latest_note: incoming.latest_note, dropped: incoming.dropped };
}

function dropCaption(drop: NonNullable<Detail["dropped"]>) {
  const date = new Date(drop.at);
  const formatter = sameYear(centralDay.format(date), centralDay.format(new Date()))
    ? dropDate.current
    : dropDate.other;
  return `Dropped ${formatter.format(date)}: ${drop.reason}`;
}

function ProspectNotes({ notes, authorLabel }: { notes: Detail["notes"]; authorLabel: AuthorLabel }) {
  return notes.length ? (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>
          {noteBy(note, authorLabel)}
          <p className="note-original">{note.summary}</p>
        </li>
      ))}
    </ul>
  ) : (
    <p>No notes yet</p>
  );
}

function DroppedProspectPage({
  id,
  request,
  authorLabel,
  returnTo,
  back,
}: {
  id: string | null;
  request: RequestProspect;
  authorLabel: AuthorLabel;
  returnTo: string;
  back?: () => void;
}) {
  const path = id && uuid.test(id) ? `${prospectsPath}/${id}` : null;
  const { value: row, unavailable } = useProspectRead(request, path, 0, parseDetail);
  return (
    <>
      <a
        href={returnTo}
        onClick={
          back &&
          ((event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            back();
          })
        }
      >
        ← Back to Monday review
      </a>
      <h1 id="mondayReviewTitle">{row?.name ?? "Prospect"}</h1>
      {!path || unavailable ? <p role="alert">Could not load this prospect.</p> : !row && <p>Loading prospect…</p>}
      {row && (
        <section className="card glass monday-review-item">
          {row.dropped && <p>{dropCaption(row.dropped)}</p>}
          <h2>Notes</h2>
          <ProspectNotes notes={row.notes} authorLabel={authorLabel} />
        </section>
      )}
    </>
  );
}

export function mountDroppedProspect(host: HTMLElement, props: Parameters<typeof DroppedProspectPage>[0]) {
  createRoot(host).render(<DroppedProspectPage {...props} />);
}

function parseLane(value: Record<string, unknown>) {
  if (!Array.isArray(value.prospects)) return invalid();
  return [...new Map(value.prospects.map(parseProspect).map((row) => [row.party_id, row])).values()];
}

function ProspectDetail({
  id,
  client,
  filters,
  refreshLane,
  authorLabel,
  stepOriginLabel,
  close,
  closeLabel,
  turnIntoDeal,
  focusFollowUp,
  stepId,
}: {
  id: string;
  client: ProspectClient;
  filters: Filters;
  refreshLane: () => void;
  authorLabel: AuthorLabel;
  stepOriginLabel: StepOriginLabel;
  close: () => void;
  closeLabel: string;
  turnIntoDeal: (prospect: Parameters<ProspectActions["turnIntoDeal"]>[0]) => void;
  focusFollowUp: boolean;
  stepId: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const followUps = useRef<HTMLHeadingElement>(null);
  const linkedStep = useRef<HTMLLIElement>(null);
  const [revision, update] = useState(0);
  const detailPath = `${prospectsPath}/${id}`;
  const { value: row, unavailable } = useProspectRead(
    client.prospectRequest,
    stepId && uuid.test(stepId) ? `${detailPath}?step=${stepId}` : detailPath,
    revision,
    parseDetail,
    refreshNotes,
  );
  const loaded = row !== undefined;
  const canSave = filters.canSave && !row?.dropped;
  const followUpsInView = row?.completed ? [row.completed, ...row.follow_ups] : (row?.follow_ups ?? []);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (focusFollowUp && loaded) {
      const target = linkedStep.current ?? followUps.current;
      target?.focus();
    }
  }, [focusFollowUp, loaded]);
  const reload = () => update((value) => value + 1);
  const saved = () => {
    reload();
    refreshLane();
  };
  return (
    <dialog ref={dialog} className="dialog prospect-dialog" aria-labelledby="prospect-title" onClose={close}>
      <header>
        <h2 id="prospect-title">{row?.name ?? "Prospect"}</h2>
      </header>
      <div className="dialog-body">
        {unavailable ? <p role="alert">Could not load this prospect.</p> : !row && <p>Loading prospect…</p>}
        {row && (
          <>
            {row.dropped && <p>{dropCaption(row.dropped)}</p>}
            {canSave && <ProspectNote id={id} client={client} saved={saved} />}
            <p>
              How found ·{" "}
              {row.how_found && Object.hasOwn(howFound, row.how_found) ? howFound[row.how_found] : "Unknown"}
            </p>
            <p>
              {row.owner ? `Claimed by ${partners[row.owner]}` : "Unclaimed"}
              {row.needs_attention && " · Needs attention"}
            </p>
            <h3 ref={followUps} tabIndex={-1}>
              Follow-ups
            </h3>
            {followUpsInView.length ? (
              <ul>
                {followUpsInView.map((item) => {
                  const origin = stepOriginLabel(item);
                  const linked = item.next_step_id === stepId;
                  return (
                    <li
                      key={item.next_step_id}
                      ref={linked ? linkedStep : undefined}
                      tabIndex={linked ? -1 : undefined}
                    >
                      {label(item.owner)} · {item.title} · {item === row.completed ? "Done" : due(item.due_on)}
                      {origin && <small> · {origin}</small>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>No follow-up set</p>
            )}
            {canSave && filters.actor && (
              <ProspectFollowUp
                id={id}
                client={client}
                current={row.follow_ups.find((step) => step.owner === filters.actor)}
                saved={saved}
                reload={reload}
              />
            )}
            {canSave && filters.actor && (
              <ManageProspect
                row={row}
                actor={filters.actor}
                client={client}
                saved={saved}
                reload={reload}
                turnIntoDeal={() => turnIntoDeal(row)}
                drop={() => {
                  dialog.current?.close();
                  refreshLane();
                }}
              />
            )}
            <h3>Notes</h3>
            <ProspectNotes notes={row.notes} authorLabel={authorLabel} />
          </>
        )}
        <div>
          <button type="button" className="btn" onClick={reload}>
            Reload prospect
          </button>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            {closeLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function ProspectLane({
  filters,
  variant,
  revision,
  client,
  authorLabel,
  stepOriginLabel,
  count,
  refresh,
  actions: { addDeal, turnIntoDeal, backToReview },
}: {
  filters: Filters;
  variant: ProspectVariant;
  revision: number;
  client: ProspectClient;
  authorLabel: AuthorLabel;
  stepOriginLabel: StepOriginLabel;
  count: (value: number | null) => void;
  refresh: () => void;
  actions: ProspectActions;
}) {
  const query = new URLSearchParams(location.search);
  const initial = query.get("prospect");
  const [opened, open] = useState(initial && uuid.test(initial) ? initial : null);
  const [adding, setAdding] = useState(false);
  const addToggle = useRef<HTMLButtonElement>(null);
  const closingAdd = useRef(false);
  useEffect(() => {
    if (adding || !closingAdd.current) return;
    closingAdd.current = false;
    addToggle.current?.focus();
  }, [adding]);
  const returnToReview = initial === opened ? backToReview : null;
  const { value: rows, unavailable } = useProspectRead(client.prospectRequest, prospectsPath, revision, parseLane);
  const visible = rows?.filter(
    (row) =>
      (filters.owner === "all" || !row.owner || row.owner === filters.owner) &&
      (!filters.attention || row.needs_attention),
  );
  useEffect(() => count(visible?.length ?? null), [visible?.length, count]);
  return (
    <>
      <h3 id="prospects-title">Prospects {visible && <small>{visible.length}</small>}</h3>
      {filters.canSave && !adding && (
        <button
          ref={addToggle}
          type="button"
          className="column-add"
          aria-label="Add prospect"
          onClick={() => setAdding(true)}
        >
          + Add prospect
        </button>
      )}
      {filters.canSave && adding && (
        <AddProspect
          client={client}
          sources={howFound}
          refresh={refresh}
          addDeal={addDeal}
          close={() => {
            closingAdd.current = true;
            setAdding(false);
          }}
        />
      )}
      {unavailable ? (
        <p role="alert">
          Could not load prospects.{" "}
          <button type="button" className="btn" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : visible?.length === 0 ? (
        <p>No prospects in this view</p>
      ) : null}
      {visible?.map((row) => {
        const next = row.follow_ups[0];
        return (
          <article
            className={`kanban-card work-card work-card--${variant}`}
            data-attention={row.needs_attention}
            data-shortcut-card=""
            key={row.party_id}
          >
            <h4 className="work-card-title">
              <button type="button" className="card-open" data-shortcut-open="" onClick={() => open(row.party_id)}>
                {row.name}
              </button>
            </h4>
            <div className="work-card-meta">
              {owner(row.owner)}
              {row.needs_attention && <span className="work-card-status">Needs attention</span>}
            </div>
            <div className="work-card-body">
              {row.latest_note && (
                <>
                  <p className="next-line">{row.latest_note.summary?.split("\n")[0]}</p>
                  <small>{noteBy(row.latest_note, authorLabel)}</small>
                </>
              )}
              {next ? (
                <>
                  <p className="next-line">{next.title}</p>
                  <small>{`${label(next.owner)} · ${due(next.due_on)}`}</small>
                </>
              ) : (
                <p className="next-line">No follow-up set</p>
              )}
            </div>
          </article>
        );
      })}
      {opened && (
        <ProspectDetail
          key={opened}
          id={opened}
          client={client}
          filters={filters}
          refreshLane={refresh}
          authorLabel={authorLabel}
          stepOriginLabel={stepOriginLabel}
          focusFollowUp={initial === opened && query.get("focus") === "follow-up"}
          stepId={initial === opened ? query.get("step") : null}
          turnIntoDeal={(row) => turnIntoDeal(row, () => open(null))}
          close={returnToReview ?? (() => open(null))}
          closeLabel={returnToReview ? "Back to Monday review" : "Back to Deals"}
        />
      )}
    </>
  );
}

export function mountDealClientPicker(host: HTMLElement, props: Parameters<typeof DealClientPicker>[0]) {
  const root = createRoot(host);
  flushSync(() => root.render(<DealClientPicker {...props} />));
  return () => root.unmount();
}

export function mountProspects(
  host: HTMLElement,
  client: ProspectClient,
  count: (value: number | null) => void,
  authorLabel: AuthorLabel,
  stepOriginLabel: StepOriginLabel,
  actions: ProspectActions,
) {
  const root = createRoot(host);
  let revision = 0;
  let filters: Filters = { owner: "all", attention: false, actor: null, canSave: false };
  let variant: ProspectVariant = "tile";
  function render() {
    root.render(
      <ProspectLane
        filters={filters}
        variant={variant}
        client={client}
        authorLabel={authorLabel}
        stepOriginLabel={stepOriginLabel}
        revision={revision}
        count={count}
        refresh={refresh}
        actions={actions}
      />,
    );
  }
  function refresh() {
    revision++;
    render();
  }
  return {
    show(owner: string, attention: boolean, actor: unknown, canSave: boolean, nextVariant: ProspectVariant) {
      filters = { owner, attention, actor: partner(actor) ? actor : null, canSave };
      variant = nextVariant;
      render();
    },
    refresh,
    dispose: () => root.unmount(),
  };
}
