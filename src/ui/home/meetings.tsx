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
  const today = answer.today;
  const items = calendar.items
    .map(event)
    .filter(
      (item) =>
        day(new Date(item.start)) <= today &&
        day(new Date(Math.max(Date.parse(item.start), Date.parse(item.end) - 1))) >= today,
    );

  const { meetingReviews } = await sibling("./home-meeting-reviews.js");
  const reviews: (Event & { key: string })[] = meetingReviews(calendar);
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
    actor: text(answer.viewer) ? answer.viewer : null,
    today,
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

const eventKey = (item: Event) => JSON.stringify([Date.parse(item.start), Date.parse(item.end), item.title.trim()]);

export function MeetingTile({
  data,
  stale,
  handled,
  finish,
}: {
  data: MeetingRead;
  stale: boolean;
  handled: ReadonlySet<string>;
  finish: (key: string, message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const events = new Map(data.items.map((item) => [eventKey(item), item]));
  const reviews = new Map(
    data.reviews
      .filter((review) => !handled.has(review.key) && day(new Date(review.start)) === data.today)
      .map((review) => [eventKey(review), review]),
  );
  for (const [key, review] of reviews) if (!events.has(key)) events.set(key, review);
  const lastSync =
    (stale || data.partial) && data.lastSync
      ? `Last synced ${localDate.format(new Date(data.lastSync))} Central`
      : null;
  if (!events.size)
    return (
      lastSync && (
        <p className="home-tile-status" role="status">
          {lastSync}
        </p>
      )
    );

  return (
    <HomeTile title="Today's meetings" count={events.size} expanded={expanded} setExpanded={setExpanded}>
      {lastSync && <p className="home-tile-status">{lastSync}</p>}
      {[...events].slice(0, expanded ? undefined : 3).map(([key, item]) => {
        const attendees = Array.isArray(item.attendees) ? item.attendees.filter(object) : [];
        const names = attendees.map((person) => (text(person.name) ? person.name : person.email)).filter(text);
        const review = reviews.get(key);
        const deal = href(item.open_url);
        return (
          <details className="home-meeting" key={key}>
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
            {review && <MeetingReview embedded data={data} review={review} finish={finish} />}
          </details>
        );
      })}
    </HomeTile>
  );
}
