import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AddProspect, ManageProspect } from "./prospect-management";
import { type ProspectClient, ProspectFollowUp, ProspectNote, prospectsPath } from "./prospect-saves";

const partners = { joe: "Joe", dell: "Dell" };
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

type Partner = keyof typeof partners;
type RequestProspect = (path: string, init?: RequestInit) => Promise<Response>;
type AuthorLabel = (by: string | null) => string;
type Filters = { owner: string; attention: boolean; actor: Partner | null; canSave: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    !textOrNull(value.due_on) ||
    (value.due_on !== null && !Number.isFinite(Date.parse(value.due_on))) ||
    typeof value.change_id !== "number" ||
    !Number.isSafeInteger(value.change_id)
  )
    return invalid();
  return {
    next_step_id: value.next_step_id,
    owner: value.owner,
    what: value.what,
    due_on: value.due_on,
    change_id: value.change_id,
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
  route: string,
  revision: number,
  parse: (value: Record<string, unknown>) => T,
) {
  const [state, setState] = useState<Read<T>>({});
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const response = await request(route, { signal: controller.signal });
        const value: unknown = await response.json();
        if (!response.ok || !record(value)) return invalid();
        if (!controller.signal.aborted) setState({ value: parse(value) });
      } catch {
        if (!controller.signal.aborted) setState({ unavailable: true });
      }
    }
    if (revision) setState((state) => (state.value ? state : {}));
    void read();
    return () => controller.abort();
  }, [request, route, revision, parse]);
  return state;
}

function parseDetail(value: Record<string, unknown>) {
  if (!Array.isArray(value.notes)) return invalid();
  const notes = value.notes.map((note: unknown) => {
    if (!record(note) || typeof note.activity_id !== "string") return invalid();
    return { ...parseNote(note), id: note.activity_id };
  });
  return { ...parseProspect(value), notes };
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
  close,
  focusFollowUp,
}: {
  id: string;
  client: ProspectClient;
  filters: Filters;
  refreshLane: () => void;
  authorLabel: AuthorLabel;
  close: () => void;
  focusFollowUp: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const followUps = useRef<HTMLHeadingElement>(null);
  const [revision, update] = useState(0);
  const { value: row, unavailable } = useProspectRead(
    client.prospectRequest,
    `${prospectsPath}/${id}`,
    revision,
    parseDetail,
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (focusFollowUp && row) followUps.current?.focus();
  }, [focusFollowUp, row]);
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
            {filters.canSave && <ProspectNote id={id} client={client} saved={saved} />}
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
            {row.follow_ups.length ? (
              <ul>
                {row.follow_ups.map((item) => (
                  <li key={item.next_step_id}>
                    {label(item.owner)} · {item.what} · {due(item.due_on)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No follow-up set</p>
            )}
            {filters.canSave && filters.actor && (
              <ProspectFollowUp
                id={id}
                client={client}
                current={row.follow_ups.find((step) => step.owner === filters.actor)}
                saved={saved}
                reload={reload}
              />
            )}
            {filters.canSave && filters.actor && (
              <ManageProspect
                row={row}
                actor={filters.actor}
                client={client}
                saved={saved}
                reload={reload}
                drop={() => {
                  dialog.current?.close();
                  refreshLane();
                }}
              />
            )}
            <h3>Notes</h3>
            {row.notes.length ? (
              <ul>
                {row.notes.map((note) => (
                  <li key={note.id}>
                    {noteBy(note, authorLabel)}
                    <p>{note.summary}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No notes yet</p>
            )}
          </>
        )}
        <div>
          <button type="button" className="btn" onClick={reload}>
            Reload prospect
          </button>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            Back to Deals
          </button>
        </div>
      </div>
    </dialog>
  );
}

function ProspectLane({
  filters,
  revision,
  client,
  authorLabel,
  count,
  refresh,
  addDeal,
}: {
  filters: Filters;
  revision: number;
  client: ProspectClient;
  authorLabel: AuthorLabel;
  count: (value: number | null) => void;
  refresh: () => void;
  addDeal: (client: { id: string; name: string }) => void;
}) {
  const query = new URLSearchParams(location.search);
  const initial = query.get("prospect");
  const [opened, open] = useState(initial && uuid.test(initial) ? initial : null);
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
      {filters.canSave && <AddProspect client={client} sources={howFound} refresh={refresh} addDeal={addDeal} />}
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
            className="kanban-card work-card work-card--tile"
            data-attention={row.needs_attention}
            key={row.party_id}
          >
            <h4 className="work-card-title">
              <button type="button" className="card-open" onClick={() => open(row.party_id)}>
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
              <p className="next-line">{next ? `${label(next.owner)} · ${due(next.due_on)}` : "No follow-up set"}</p>
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
          focusFollowUp={initial === opened && query.get("focus") === "follow-up"}
          close={() => open(null)}
        />
      )}
    </>
  );
}

export function mountProspects(
  host: HTMLElement,
  client: ProspectClient,
  count: (value: number | null) => void,
  authorLabel: AuthorLabel,
  addDeal: (client: { id: string; name: string }) => void,
) {
  const root = createRoot(host);
  let revision = 0;
  let filters: Filters = { owner: "all", attention: false, actor: null, canSave: false };
  function render() {
    root.render(
      <ProspectLane
        filters={filters}
        client={client}
        authorLabel={authorLabel}
        revision={revision}
        count={count}
        refresh={refresh}
        addDeal={addDeal}
      />,
    );
  }
  function refresh() {
    revision++;
    render();
  }
  return {
    show(owner: string, attention: boolean, actor: unknown, canSave: boolean) {
      filters = { owner, attention, actor: partner(actor) ? actor : null, canSave };
      render();
    },
    refresh,
    dispose: () => root.unmount(),
  };
}
