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
function event(value: unknown): Event & { key: string | null } {
  if (
    !object(value) ||
    !text(value.title) ||
    !instant(value.start) ||
    !instant(value.end) ||
    Date.parse(value.end) < Date.parse(value.start)
  )
    throw Error("Meetings unavailable");
  const key = typeof value.key === "string" && /^[a-f0-9]{16}$/.test(value.key) ? value.key : null;
  return { ...value, key, title: value.title, start: value.start, end: value.end };
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
type MeetingRow = { id: string; item: Event; outcome: { pending: Review | null } | null };

function meetingRows(data: MeetingRead, today: string, revision: number, previous: MeetingRow[]) {
  const rows = new Map<string, MeetingRow>();
  for (const [index, item] of data.items.entries()) {
    if (!onMeetingDay(item, today)) continue;
    const id = item.key ?? `unkeyed:${revision}:${index}`;
    rows.set(id, { id, item, outcome: null });
  }

  for (const review of data.reviews) {
    if (!onMeetingDay(review, today)) continue;
    const id = review.key;
    const item = rows.get(id)?.item ?? review;
    rows.set(id, { id, item, outcome: { pending: review } });
  }

  const retained: MeetingRow[] = [];
  for (const old of previous) {
    const current = rows.get(old.id);
    rows.delete(old.id);
    // Outlook's next snapshot can omit an ended meeting and its answered review.
    if (old.outcome && !current?.outcome && onMeetingDay(old.item, today))
      retained.push({ ...(current ?? old), outcome: { pending: null } });
    else if (current) retained.push(current);
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
  const [view, setView] = useState(() => ({ data, today, revision: 0, rows: meetingRows(data, today, 0, []) }));
  const newRead = view.data !== data;
  const changed = newRead || view.today !== today;
  const sameActor = view.data.actor === data.actor;
  const revision = newRead ? view.revision + 1 : view.revision;
  const events = changed ? meetingRows(data, today, revision, sameActor ? view.rows : []) : view.rows;
  if (changed) {
    setView({ data, today, revision, rows: events });
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
