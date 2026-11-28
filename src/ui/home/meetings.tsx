import { useEffect, useRef, useState } from "react";
import { object } from "./inbox";
import { onDay } from "./today-lines.ts";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
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
  return { actor, items, reviews, deals };
}
export type MeetingRead = Awaited<ReturnType<typeof readMeetings>>;

export function MeetingReview({
  review,
  data,
  finish,
}: {
  review: MeetingRead["reviews"][number];
  data: MeetingRead | undefined;
  finish: (key: string, message: string) => void;
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
        onAnswer: (message: string) => finish(review.key, message),
      });
      controller.current?.update(view.current);
    });
    return () => {
      live = false;
      controller.current?.dispose();
    };
  }, [finish, review.key]);
  useEffect(() => {
    view.current = {
      actor: data?.actor,
      deals: data?.deals,
      calendar: { follow_up_reviews: [{ ...review, state: "needs_review" }] },
    };
    controller.current?.update(view.current);
  }, [review, data?.actor, data?.deals]);
  return <div ref={host} data-home-preview />;
}

type Review = MeetingRead["reviews"][number];

/** Unanswered outcome reviews, each timed by today's same-key meeting when Outlook moved it. */
function meetingOutcomes(data: MeetingRead | undefined, today: string, handled: ReadonlySet<string>): Review[] {
  return (data?.reviews ?? []).flatMap((review) => {
    if (handled.has(review.key)) return [];
    const moved = data?.items.filter((item) => item.key === review.key && onDay(item, today)).at(-1);
    // The outcome logs the time Today's meetings shows.
    return [moved ? { ...review, start: moved.start, end: moved.end } : review];
  });
}

/** The outcome reviews the Inbox shows: every meeting that has started, today's included, until answered. */
export function useMeetingOutcomes(data: MeetingRead | undefined, today: string, handled: ReadonlySet<string>) {
  const [, setClock] = useState(0);
  const now = Date.now();
  const outcomes = meetingOutcomes(data, today, handled);
  const nextStart = Math.min(...outcomes.map(({ start }) => Date.parse(start)).filter((start) => start > now));
  useEffect(() => {
    if (!Number.isFinite(nextStart)) return;
    // eslint-disable-next-line no-restricted-syntax -- One timer for the next meeting to start, cleared when the reviews change.
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), Math.max(0, nextStart - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextStart]);
  return outcomes.filter(({ start }) => Date.parse(start) <= now);
}
