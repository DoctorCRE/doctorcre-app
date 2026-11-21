import { useEffect, useRef, useState } from "react";
import { object } from "./inbox";
import { day, HomeTile } from "./sections";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const central = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const localDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const href = (value: unknown) =>
  typeof value === "string" &&
  /^\/[a-z]/.test(value) &&
  URL.parse(value, "https://doctorcre.invalid")?.origin === "https://doctorcre.invalid"
    ? value
    : undefined;
type Event = Record<string, unknown> & { title: string; start: string; end: string };
function event(value: unknown): Event {
  if (
    !object(value) ||
    !text(value.title) ||
    !instant(value.start) ||
    !instant(value.end) ||
    Date.parse(value.end) < Date.parse(value.start)
  )
    throw Error("Meetings unavailable");
  return { ...value, title: value.title, start: value.start, end: value.end };
}

export async function readMeetings(signal: AbortSignal) {
  const { sessionFetch } = await sibling("./private-session.js");
  const response: Response = await sessionFetch("/api/engine/home/today", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw Error("Meetings unavailable");
  const answer: unknown = await response.json();
  if (
    !object(answer) ||
    answer.schema_version !== "home-today.v1" ||
    answer.ok !== true ||
    !object(answer.meetings) ||
    typeof answer.today !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(answer.today)
  )
    throw Error("Meetings unavailable");
  const calendar = answer.meetings;
  if (!["ready", "empty", "partial"].includes(String(calendar.state)) || !Array.isArray(calendar.items))
    throw Error("Meetings unavailable");
  const items = calendar.items.map(event);

  const { meetingReviews } = await sibling("./home-meeting-reviews.js");
  const actor = text(answer.viewer) ? answer.viewer : null;
  const pending: (Event & { key: string })[] = actor ? meetingReviews(calendar) : [];
  const reviews = [...new Map(pending.map((review) => [review.key, review])).values()];
  let deals: unknown[] | null = [];
  if (reviews.length) {
    const [{ createClient }, { scopedDeals }] = await Promise.all([
      sibling("./client.js"),
      sibling("./deal-review-model.js"),
    ]);
    deals = await createClient("live", { docContext: false })
      .then(async (client: { getBoard(options: { workspace: "all"; signal: AbortSignal }): Promise<unknown> }) =>
        scopedDeals(await client.getBoard({ workspace: "all", signal }), "team"),
      )
      .catch(() => null);
  }
  return {
    actor,
    readDay: answer.today,
    items,
    reviews,
    deals,
    lastSync: instant(calendar.observed_at) ? calendar.observed_at : null,
    partial: calendar.state === "partial",
  };
}
export type MeetingRead = Awaited<ReturnType<typeof readMeetings>>;

export function MeetingReview({
  review,
  data,
  finish,
  embedded,
}: {
  review: MeetingRead["reviews"][number];
  data: MeetingRead | undefined;
  finish: (key: string, message: string) => void;
  embedded?: true;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef({
    actor: data?.actor,
    deals: data?.deals,
    calendar: { follow_up_reviews: [{ ...review, state: "needs_review" }] },
  });
  const controller = useRef<{ update: (view: unknown) => void; dispose: () => void }>(null);
  useEffect(() => {
    let live = true;
    void sibling("./home-meeting-reviews.js").then(({ mountHomeMeetingReviews }) => {
      if (!live || !host.current) return;
      controller.current = mountHomeMeetingReviews({
        document,
        host: host.current,
        engine: true,
        embedded,
        onAnswer: (message: string) => finish(review.key, message),
      });
      controller.current?.update(view.current);
    });
    return () => {
      live = false;
      controller.current?.dispose();
    };
  }, [embedded, finish, review.key]);
  useEffect(() => {
    view.current = {
      actor: data?.actor,
      deals: data?.deals,
      calendar: { follow_up_reviews: [{ ...review, state: "needs_review" }] },
    };
    controller.current?.update(view.current);
  }, [review, data?.actor, data?.deals]);
  return <div ref={host} />;
}

const lastMeetingDay = (item: Event) => day(new Date(Math.max(Date.parse(item.start), Date.parse(item.end) - 1)));

const onMeetingDay = (item: Event, today: string) =>
  day(new Date(item.start)) <= today && lastMeetingDay(item) >= today;

export function earlierMeetingReviews(data: MeetingRead | undefined, today: string, handled: ReadonlySet<string>) {
  return (data?.reviews ?? []).filter((review) => !handled.has(review.key) && lastMeetingDay(review) < today);
}

type Review = MeetingRead["reviews"][number];
type MeetingRow = { id: string; item: Event; outcome: { key: string; pending: Review | null } | null };

const outlookKey = (item: Event, outcome?: MeetingRow["outcome"]) => (text(item.key) ? item.key : outcome?.key);
const slot = (item: Event) => JSON.stringify([Date.parse(item.start), Date.parse(item.end), item.title.trim()]);
function personKey(person: unknown) {
  if (!object(person)) return null;
  return text(person.email) ? person.email : text(person.name) ? person.name : null;
}

function scheduledRows(items: Event[]) {
  const occurrences = new Map<string, number>();
  const rows = new Map<string, MeetingRow>();
  for (const item of items) {
    const key = outlookKey(item);
    if (key) {
      rows.set(`event:${key}`, { id: `event:${key}`, item, outcome: null });
      continue;
    }
    const attendees = Array.isArray(item.attendees) ? item.attendees.map(personKey).sort() : [];
    const fingerprint = JSON.stringify([slot(item), personKey(item.organizer), attendees, item.location]);
    const count = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, count + 1);
    const id = `schedule:${fingerprint}:${count}`;
    rows.set(id, { id, item, outcome: null });
  }
  return rows;
}

function matchReview(candidates: MeetingRow[], review: Review, reviews: Review[]) {
  const exact = candidates.find(({ item, outcome }) => outlookKey(item, outcome) === review.key);
  if (exact) return exact;

  const reviewSlot = slot(review);
  if (reviews.some((other) => other.key !== review.key && slot(other) === reviewSlot)) return;
  const fallback = candidates.filter(({ item, outcome }) => !outlookKey(item, outcome) && slot(item) === reviewSlot);
  if (fallback.length === 1) return fallback[0];
}

function meetingRows(data: MeetingRead, today: string, previous: MeetingRow[]) {
  const rows = scheduledRows(data.items.filter((item) => onMeetingDay(item, today)));
  const reviews = data.reviews.filter((review) => onMeetingDay(review, today));
  const candidates = new Map(rows);
  for (const old of previous) {
    const current = candidates.get(old.id);
    candidates.set(old.id, current ? { ...current, outcome: old.outcome } : old);
  }
  const meetings = [...candidates.values()];
  for (const review of reviews) {
    const match = matchReview(meetings, review, reviews);
    const id = match?.id ?? `event:${review.key}`;
    rows.set(id, { id, item: match?.item ?? review, outcome: { key: review.key, pending: review } });
  }

  const linkedReviews = new Set([...rows.values()].map((row) => row.outcome?.key));
  const retained: MeetingRow[] = [];
  for (const old of previous) {
    const row = rows.get(old.id);
    rows.delete(old.id);
    // Outlook's next snapshot can omit an ended meeting and its answered review.
    const outcome =
      old.outcome && !linkedReviews.has(old.outcome.key) && onMeetingDay(old.item, today)
        ? { key: old.outcome.key, pending: null }
        : null;
    if (row) retained.push({ ...row, outcome: row.outcome ?? outcome });
    else if (outcome) retained.push({ ...old, outcome });
  }
  return [...retained, ...rows.values()];
}

export function MeetingTile({
  data,
  stale,
  today,
  handled,
  finish,
}: {
  data: MeetingRead;
  stale: boolean;
  today: string;
  handled: ReadonlySet<string>;
  finish: (key: string, message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState(() => ({ data, today, rows: meetingRows(data, today, []) }));
  const changed = view.data !== data || view.today !== today;
  const sameActor = view.data.actor === data.actor;
  const events = changed ? meetingRows(data, today, sameActor ? view.rows : []) : view.rows;
  if (changed) {
    setView({ data, today, rows: events });
    const stillOpen = sameActor ? events.filter(({ id }) => open.has(id)).map(({ id }) => id) : [];
    if (stillOpen.length !== open.size) setOpen(new Set(stillOpen));
  }

  const lastSync =
    (stale || data.partial || data.readDay !== today) && data.lastSync
      ? `Last synced ${localDate.format(new Date(data.lastSync))} Central`
      : null;
  if (!events.length)
    return (
      lastSync && (
        <p className="home-tile-status" role="status">
          {lastSync}
        </p>
      )
    );

  const shown = expanded ? events : events.filter(({ id }, index) => index < 3 || open.has(id));
  return (
    <HomeTile title="Today's meetings" count={events.length} expanded={expanded} setExpanded={setExpanded}>
      {lastSync && <p className="home-tile-status">{lastSync}</p>}
      {shown.map(({ id, item, outcome }) => {
        const review = outcome?.pending;
        const attendees = Array.isArray(item.attendees) ? item.attendees.filter(object) : [];
        const names = attendees.map((person) => (text(person.name) ? person.name : person.email)).filter(text);
        const deal = href(item.open_url);
        return (
          <details
            className="home-meeting"
            key={id}
            onToggle={({ currentTarget }) => {
              const isOpen = currentTarget.open;
              setOpen((previous) => {
                if (previous.has(id) === isOpen) return previous;
                const next = new Set(previous);
                if (isOpen) next.add(id);
                else next.delete(id);
                return next;
              });
            }}
          >
            <summary>
              <time dateTime={item.start}>{item.all_day ? "All day" : central.format(new Date(item.start))}</time>
              <strong>{item.title}</strong>
              {text(item.context_label) && <span>{item.context_label}</span>}
            </summary>
            {names.length > 0 && <p>{names.join(", ")}</p>}
            {text(item.location) && <p>{item.location}</p>}
            {deal && <a href={deal}>Open deal</a>}
            {Array.isArray(item.possible_deals) &&
              !deal &&
              item.possible_deals.filter(object).map((match) => {
                const link = href(match.open_url);
                return link && text(match.name) ? (
                  <a href={link} key={link}>
                    {match.name}
                  </a>
                ) : null;
              })}
            {review && !handled.has(review.key) && (
              <MeetingReview embedded data={data} review={review} finish={finish} />
            )}
          </details>
        );
      })}
    </HomeTile>
  );
}
