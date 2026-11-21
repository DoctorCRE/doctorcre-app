import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from "react-router";
import { HomeWatchDetail } from "../watches/home-detail.tsx";
import { BulkControls } from "./bulk-controls";
import { readDashboard } from "./dashboard-read";
import { DropReason } from "./drop-reason.tsx";
import { type MarkUndo, markTarget, restoreMark } from "./engine-marks.ts";
import { draftCardStatus, draftReference, hasEngineReview, openStepRefusal } from "./engine-review.ts";
import {
  type Action,
  type Command,
  command,
  dropCommand,
  dropTarget,
  type InboxClient,
  type InboxItem,
  type ItemResult,
  object,
  type Snapshot,
  shelves,
  type TaskReceipt,
  taskCommand,
} from "./inbox";
import { earlierMeetingReviews, MeetingReview, MeetingTile, readMeetings } from "./meetings";
import { type DraftEdit, ReviewCard, reviewDispositionLabel } from "./review-card";
import { recordPages, recordRoutes } from "./routes";
import { CardTile, cardKey, completionLabel, dashboardCards, day, HomeGrid, lateDays } from "./sections";
import { sourceExcerptText } from "./source-excerpt.ts";

type SnoozePreview = Readonly<{
  items: readonly InboxItem[];
  choices: ReadonlyArray<Readonly<{ hours: number; until: string; label: string }>>;
  error: string;
}>;
type Pending = { request: Command; before: readonly InboxItem[]; undoing?: true };
type Undo = { items: readonly InboxItem[] } & (
  | { mark: MarkUndo }
  | { action: Action | "reopen"; until?: string; receipt?: TaskReceipt }
);
const queryKey = ["home-inbox"];
const EMPTY_ITEMS: readonly InboxItem[] = [];
const cardDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" });
const callDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const snoozeDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  dateStyle: "medium",
  timeStyle: "short",
});
const isWaitingCard = (item: InboxItem) =>
  item.engine_marks === true && ["working", "held", "snoozed"].includes(item.section);

function snoozeLabel(item: InboxItem) {
  return item.disposition === "snoozed" && item.snoozed_until
    ? `Snoozed until ${snoozeDate.format(new Date(item.snoozed_until))} Central`
    : null;
}

const cardTitle = ":is(h3 a, h3[tabindex])";
const visibleRow = (node: HTMLElement) => !node.closest("details:not([open])") && node.getClientRects().length > 0;
const isEngineStep = (item: InboxItem) => item.engine_marks && item.source_type === "next_action";
const isDoneStep = (item: InboxItem) =>
  item.engine_marks && item.section === "done" && item.source_state === "done" && item.action_id !== null;
const canSnooze = (item: InboxItem) => !item.engine_marks || (item.section === "inbox" && markTarget(item.item_id));
function homeCardCue(item: InboxItem) {
  if (item.source_state === "failed") return "Didn't go through";
  if (item.source_state === "needs_attention" && item.kind_label === "Reply draft") return "Draft ready";
  return null;
}
export function inboxRefusal(code: unknown): string {
  switch (code) {
    case "version_conflict":
      return "This card changed on the server. Dismiss and refresh before another action.";
    case "invalid_completion":
      return "This completion can no longer be undone. Refresh to review the task.";
    case "action_not_found":
      return "This task is no longer available. Refresh to review current work.";
    case "action_not_open":
      return "This task is no longer open. Refresh to review its current state.";
    case "partner_required":
    case "human_only_verb_requires_verified_partner":
    case "unattended_runner_authority_not_admitted":
      return "Sign in as a verified partner before changing this task.";
    case "invalid_action_id":
    case "invalid_base_version":
      return "This task could not be identified safely. Refresh before another action.";
    case "key_reuse":
      return "This request does not match its original attempt. Dismiss and refresh before another action.";
    default:
      return "The server did not confirm this change. Retry the same request or dismiss and refresh.";
  }
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Result uncertain. Retry the same request.";
export function markHomeReady(host: HTMLElement) {
  if (host.dataset.homeReady) return;
  host.dataset.homeReady = "true";
  host.dispatchEvent(new Event("doctorcre:home-ready"));
}
function Inbox({ client }: { client: InboxClient }) {
  const route = useLocation();
  const home = route.pathname === "/";
  const engineHome = document.documentElement.hasAttribute("data-home-today-from-engine");
  const { item_id: inboxItemId } = useParams();
  const item_id = home ? new URLSearchParams(route.search).get("card") || undefined : inboxItemId;
  const cache = useQueryClient();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (home && engineHome) {
        const dashboard = await readDashboard(signal);
        if (dashboard) return dashboard;
        const current = cache.getQueryData<Snapshot | { grouped: true }>(queryKey);
        if (inFlight.current && current && "grouped" in current)
          throw Error("Reminders and waiting items unavailable.");
      }
      return client.read(signal);
    },
    // eslint-disable-next-line no-restricted-syntax -- One read per 60000ms while visible and online; paused during writes and cleared on unmount by Query.
    refetchInterval: () =>
      navigator.onLine && document.visibilityState === "visible" && !inFlight.current ? 60_000 : false,
  });
  const meetings = useQuery({
    queryKey: ["home-meetings"],
    queryFn: ({ signal }) => readMeetings(signal),
    enabled: home && engineHome,
    // eslint-disable-next-line no-restricted-syntax -- The calendar reads once a minute while visible and online.
    refetchInterval: () => (navigator.onLine && document.visibilityState === "visible" ? 60_000 : false),
  });
  const [meetingDay, setMeetingDay] = useState(() => day(new Date()));
  const [handledMeetings, setHandledMeetings] = useState<ReadonlySet<string>>(() => new Set());
  const finishMeeting = useCallback((key: string, message: string) => {
    setHandledMeetings((handled) => new Set([...handled, key]));
    setNotice(message);
  }, []);
  useEffect(() => {
    const host = document.getElementById("homeRoot");
    if (home && !query.isPending && host) markHomeReady(host);
  }, [home, query.isPending]);
  async function updateAfterSave(flat?: Snapshot | null, updates: readonly InboxItem[] = []) {
    if (query.data && "grouped" in query.data) {
      await query.refetch({ cancelRefetch: false });
      return;
    }
    if (!flat && !updates.length) return;
    cache.setQueryData<Snapshot>(
      queryKey,
      (current) =>
        flat ??
        (current && {
          ...current,
          items: current.items.map((item) => updates.find((next) => next.item_id === item.item_id) ?? item),
        }),
      { updatedAt: query.dataUpdatedAt },
    );
  }
  const [reviewing, setReviewing] = useState<InboxItem | null>(null);
  const [draftEdits, setDraftEdits] = useState(() => new Map<string, DraftEdit>());
  const reviewingDraftId = reviewing
    ? (draftReference(reviewing)?.id ??
      (reviewing.review_reference?.kind === "reply_draft" ? reviewing.source_id : null))
    : null;
  function updateDraftEdits(id: string, edits: DraftEdit | null) {
    setDraftEdits((current) => {
      if (!edits && !current.has(id)) return current;
      const next = new Map(current);
      if (edits) next.set(id, edits);
      else next.delete(id);
      return next;
    });
  }
  const reviewOpener = useRef<HTMLElement | null>(null);
  const reviewFallback = useRef<HTMLElement[]>([]);
  const [reviewUncertain, setReviewUncertain] = useState(false);
  const openedLink = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!reviewing && reviewOpener.current) {
      const target = [reviewOpener.current, ...reviewFallback.current].find((node) => node.isConnected);
      (target || root.current)?.focus({ preventScroll: true });
      reviewOpener.current = null;
    }
  }, [reviewing]);
  const [selected, select] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [singleBusy, setBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const busy = singleBusy || batchBusy;
  const [notice, setNotice] = useState("");
  const [failures, setFailures] = useState<ItemResult[]>([]);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [dropping, setDropping] = useState<{ item: InboxItem; opener: HTMLButtonElement } | null>(null);
  const [snooze, setSnooze] = useState<SnoozePreview | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const root = useRef<HTMLElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (home && engineHome) setMeetingDay(day(new Date()));
      if (
        !navigator.onLine ||
        document.visibilityState !== "visible" ||
        inFlight.current ||
        cache.getQueryState(queryKey)?.fetchStatus === "fetching" ||
        Date.now() - lastRefresh < 1000
      )
        return;
      lastRefresh = Date.now();
      void query.refetch({ cancelRefetch: false });
      if (home && engineHome) void meetings.refetch({ cancelRefetch: false });
    };
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) refresh();
    };
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on focus; overlapping reads and writes suppress it.
    addEventListener("focus", refresh);
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on visible return; hidden and offline views send none.
    document.addEventListener("visibilitychange", refresh);
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on reconnect; never runs a mutation.
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      mounted.current = false;
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, [cache, engineHome, home, meetings.refetch, query.refetch]);
  useEffect(() => {
    if (!home || !engineHome) return;
    let timer: number;
    function updateDay() {
      setMeetingDay(day(new Date()));
      // Central midnight falls on a UTC minute boundary, even across DST.
      // eslint-disable-next-line no-restricted-syntax -- One local clock timer, cleared on leaving Home.
      timer = window.setTimeout(updateDay, 60_000 - (Date.now() % 60_000));
    }
    updateDay();
    return () => window.clearTimeout(timer);
  }, [engineHome, home]);
  const snoozeOpener = useRef<HTMLElement | null>(null);
  const [snoozeCancelled, setSnoozeCancelled] = useState(0);
  function openSnooze(items: readonly InboxItem[]) {
    const openedAt = Date.now();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    setSnooze({
      items,
      error: "",
      choices: [1, 24].map((hours) => {
        const until = new Date(openedAt + hours * 3_600_000).toISOString();
        return { hours, until, label: formatter.format(new Date(until)) };
      }),
    });
  }
  function cancelSnooze() {
    setSnooze(null);
    setSnoozeCancelled((value) => value + 1);
  }
  useLayoutEffect(() => {
    if (snoozeCancelled) snoozeOpener.current?.focus();
  }, [snoozeCancelled]);
  const [focusTargets, setFocusTargets] = useState<string[] | null>(null);
  function focusRow(preferred: string[] = []) {
    setFocusTargets([...preferred]);
  }
  useLayoutEffect(() => {
    if (!focusTargets) return;
    const links = Array.from(root.current?.querySelectorAll<HTMLElement>(`[data-inbox-row] ${cardTitle}`) || []).filter(
      visibleRow,
    );
    const target =
      focusTargets
        .map((id) => links.find((node) => node.closest<HTMLElement>("[data-inbox-row]")?.dataset.inboxRow === id))
        .find(Boolean) ||
      links[0] ||
      root.current?.querySelector<HTMLElement>(".home-slice h2, .inbox-header button") ||
      root.current;
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [focusTargets]);
  function finishBatch() {
    const next = root.current?.querySelector<HTMLElement>('.home-slice[aria-label="Reminders"] h3 a');
    const target = next || root.current?.querySelector<HTMLElement>(".home-slice h2") || root.current;
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }
  async function run(operation: Pending) {
    if (inFlight.current) return;
    setPending(operation);
    if (!navigator.onLine) {
      setNotice("Offline. No change was sent. Reconnect and retry the same request.");
      return;
    }
    const visible = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-inbox-row]") || [])
      .filter(visibleRow)
      .map((node) => node.dataset.inboxRow || "");
    const index = visible.indexOf(operation.before[0]?.item_id || "");
    const neighbours = [
      ...visible.slice(index + 1),
      ...visible.slice(0, index).reverse(),
      ...visible.slice(index, index + 1),
    ];
    inFlight.current = true;
    setBusy(true);
    setNotice("Waiting for server confirmation…");
    try {
      await cache.cancelQueries({ queryKey });
      if (!mounted.current) return;
      const results = await client.run(operation.request);
      if (!mounted.current) return;
      const successes = results.filter((result) => result.ok);
      if (successes.length && operation.request.action === "drop" && operation.request.target.kind === "draft")
        updateDraftEdits(operation.request.target.id, null);
      const saved = successes.flatMap((result) => (result.item ? [result.item] : []));
      const changed = results.flatMap((result) => (!result.ok && result.current_item ? [result.current_item] : []));
      const updates = [...saved, ...changed];
      const failed = results.filter((result) => !result.ok && !result.current_item);
      await updateAfterSave(results.find((result) => result.snapshot)?.snapshot, updates);
      if (!mounted.current) return;
      setFailures(failed);
      select(new Set(failed.map((result) => result.item_id)));
      if ((successes.length || changed.length) && !operation.undoing) {
        setUndo((entries) => [
          ...entries.filter(
            (entry) =>
              !results.some((result) => result.ok && result.item_id === entry.items[0]?.item_id) &&
              !changed.some((item) => item.item_id === entry.items[0]?.item_id),
          ),
          ...results.flatMap<Undo>((result) => {
            if (!result.ok) return [];
            const { item, undo } = result;
            const previous = operation.before.find((before) => before.item_id === result.item_id);
            if (undo && previous)
              return [{ mark: undo, items: [{ ...(item ?? previous), base_version: undo.base_version }] }];
            if (!item || operation.request.action === "drop") return [];
            if (operation.request.action === "complete")
              return result.receipt && (home || !item.undo_completion)
                ? [{ action: "reopen", items: [item], receipt: result.receipt }]
                : [];
            return previous
              ? [
                  {
                    action:
                      previous.disposition === "settled"
                        ? "settle"
                        : previous.disposition === "snoozed"
                          ? "snooze"
                          : "unsettle",
                    items: [item],
                    ...(previous.snoozed_until ? { until: previous.snoozed_until } : {}),
                  },
                ]
              : [];
          }),
        ]);
      }
      const completion =
        operation.request.action === "complete" ? saved.map((item) => `Marked done: ${item.title}.`).join(" ") : "";
      setNotice(
        operation.request.action === "drop" && successes.length
          ? "Dropped."
          : `${completion} ${successes.length + changed.length} confirmed. ${changed.length ? `${changed.length} changed again after confirmation. Showing the latest state. Undo is unavailable for those cards. ` : ""}${failed.length ? `${failed.length} failed or uncertain. Kept for review.` : successes.length ? (operation.undoing ? "Undone." : "You can undo this change.") : ""}`,
      );
      if (!failed.length) setPending(null);
      focusRow(operation.undoing ? operation.before.map((item) => item.item_id) : neighbours);
    } catch (error) {
      if (!mounted.current) return;
      const code =
        error &&
        typeof error === "object" &&
        "payload" in error &&
        error.payload &&
        typeof error.payload === "object" &&
        "error" in error.payload
          ? error.payload.error
          : null;
      if (
        typeof code === "string" &&
        [
          "version_conflict",
          "invalid_completion",
          "action_not_open",
          "action_not_found",
          "home_item_not_found",
          "invalid_snooze_time",
          "home_routing_changed",
          "step_ended",
          "step_open",
          "open_step_exists",
        ].includes(code)
      ) {
        setPending(null);
        if (code === "home_routing_changed") {
          setNotice("Home changed. Refreshing your inbox.");
        } else if (code === "open_step_exists") {
          setNotice(openStepRefusal);
        } else if ("engine_marks" in operation.request && operation.request.engine_marks) {
          setNotice(
            code === "invalid_snooze_time"
              ? "That snooze time has passed. Choose a new time."
              : "This card changed. Refreshing your inbox. Your change was not saved.",
          );
        } else {
          setNotice(`This task changed. ${inboxRefusal(code)} Nothing was overwritten.`);
        }
        void query.refetch();
        focusRow(neighbours);
      } else
        setNotice(
          `Result uncertain. ${typeof code === "string" ? inboxRefusal(code) : message(error)} Retry the same request.`,
        );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  function act(
    action: Action | "complete" | "reopen",
    items: readonly InboxItem[],
    until?: string,
    undoing = false,
    receipt?: TaskReceipt,
  ) {
    if (pending) {
      setNotice("Resolve or dismiss the previous request before starting another.");
      return;
    }
    const first = items[0];
    if (!first) return;
    try {
      void run({
        request:
          action === "complete" || action === "reopen"
            ? taskCommand(action, first, receipt)
            : command(action, items, until),
        before: items,
        ...(undoing ? { undoing: true as const } : {}),
      });
    } catch (error) {
      setNotice(message(error));
    }
  }
  const items = query.data?.items ?? EMPTY_ITEMS;
  const today = day(new Date(query.dataUpdatedAt || Date.now()));
  const pinnedTile =
    reviewing?.dashboard_tile ??
    (reviewing && ["working", "held", "snoozed"].includes(reviewing.section) ? "waiting" : "reminders");
  const tiles = useMemo(() => {
    const placed = dashboardCards(items, today);
    const otherTile = pinnedTile === "reminders" ? "waiting" : "reminders";
    if (reviewing) placed[otherTile] = placed[otherTile].filter((item) => cardKey(item) !== cardKey(reviewing));
    return placed;
  }, [items, today, reviewing, pinnedTile]);
  const finishedElsewhere =
    home &&
    reviewing !== null &&
    !items.some((item) => item.item_id === reviewing.item_id && !["done", "settled"].includes(item.section));
  const availableUndo = undo.filter((entry) => {
    if (!("mark" in entry)) return true;
    const card = items.find((item) => item.item_id === entry.mark.item_id);
    return card
      ? card.base_version === entry.mark.base_version &&
          card.source_state !== "working" &&
          (card.source_state === "done") === Boolean(entry.mark.completion)
      : entry.mark.completion;
  });
  const placed = shelves(items, item_id);
  const visibleShelves = (["working", "held", "done", "snoozed", "settled"] as const).filter(
    (shelf) => shelf !== "settled" || !query.data?.engine_marks,
  );
  const picked = items.filter((item) => selected.has(item.item_id) && canSnooze(item));
  const openCard = useCallback((item: InboxItem, opener: HTMLElement) => {
    reviewOpener.current = opener;
    const tile = opener.closest(".home-slice");
    const links = Array.from(tile?.querySelectorAll<HTMLElement>(`[data-inbox-row] ${cardTitle}`) ?? []);
    const index = links.findIndex((link) => link.closest("[data-inbox-row]") === opener.closest("[data-inbox-row]"));
    const heading = tile?.querySelector<HTMLElement>("h2");
    reviewFallback.current = [
      ...links.slice(index + 1),
      ...links.slice(0, Math.max(0, index)).reverse(),
      ...(heading ? [heading] : []),
    ];
    setReviewing(item);
  }, []);
  const openingLocked = busy || !!pending || reviewUncertain || !!dropping || !!snooze;
  useLayoutEffect(() => {
    const item = placed.current;
    if (!home || !item?.engine_marks || openingLocked || openedLink.current === route.key) return;
    const opener = root.current?.querySelector<HTMLElement>(`[data-current="true"] ${cardTitle}`);
    if (!opener) return;
    openedLink.current = route.key;
    if (isEngineStep(item) && !isDoneStep(item)) {
      opener.focus();
      opener.scrollIntoView({ block: "center" });
    } else {
      openCard(item, opener);
    }
  }, [home, openCard, openingLocked, placed.current, route.key]);
  function row(item: InboxItem) {
    if (home && reviewing && cardKey(reviewing) === cardKey(item)) item = reviewing;
    const primary =
      item.disposition === "settled" ? "Show in inbox" : item.disposition === "snoozed" ? "Wake" : "Hide from inbox";
    const markAction = item.engine_marks ? "unsnooze" : item.disposition === "inbox" ? "settle" : "unsettle";
    const snoozable = canSnooze(item);
    const waitingCard = isWaitingCard(item);
    const wakeable =
      home && item.disposition !== "snoozed"
        ? false
        : item.engine_marks
          ? item.section === "snoozed" && markTarget(item.item_id)
          : item.source_state !== "working";
    const tourDone = item.engine_marks && item.home_mark_drop && item.kind_label === "Tour feedback" && snoozable;
    const completable =
      item.action_id !== null &&
      item.source_state === "needs_attention" &&
      (!item.engine_marks || item.section === "inbox");
    const droppable = dropTarget(item) !== null;
    const reopenable = item.engine_marks && item.section === "done" && item.undo_completion && item.action_id;
    const reviewLabel =
      item.engine_marks && item.section === "inbox" && hasEngineReview(item)
        ? item.kind_label === "Reply draft"
          ? "Review reply"
          : item.kind_label === "Call" || item.kind_label === "Suggestion"
            ? "Review suggestions"
            : null
        : null;
    const presentation = item.presentation;
    const namedAction = presentation?.primaryAction;
    const feedbackReview = namedAction === "Review feedback";
    const open = reviewing?.item_id === item.item_id;
    const reviewClient =
      reviewing &&
      (hasEngineReview(reviewing) || (reviewing.review_reference && reviewing.source_state === "needs_attention"))
        ? client.review
        : undefined;
    const activity =
      item.engine_marks && "source_activity" in item && object(item.source_activity) ? item.source_activity : null;
    const activityAt =
      typeof activity?.happened_at === "string" && Number.isFinite(Date.parse(activity.happened_at))
        ? activity.happened_at
        : null;
    const callAt = item.source_type === "capture_post_call_action" && activity?.kind === "call" ? activityAt : null;
    const emailAt =
      item.source_type === "email_proposal" && item.section !== "done" && activity?.kind === "email"
        ? activityAt
        : null;
    const callContact = typeof activity?.contact === "string" ? activity.contact.trim() : "";
    const deal = item.deal_id ? `/deals?deal=${encodeURIComponent(item.deal_id)}` : null;
    const recordedSource = recordRoutes.source(item);
    const checklistUrl = namedAction === "Open checklist item" ? recordRoutes.checklist(item) : null;
    const directUrl = checklistUrl ?? (isEngineStep(item) && !isDoneStep(item) ? recordedSource : null);
    const canOpen = home || Boolean(presentation) || isDoneStep(item) || !isEngineStep(item) || directUrl !== null;
    function openDetails(opener: HTMLElement) {
      if (directUrl) location.assign(directUrl);
      else openCard(item, opener);
    }
    const recordedUrl = recordedSource ? new URL(recordedSource, "https://doctorcre.invalid") : null;
    const opensEditor = recordedUrl?.searchParams.get("focus") === "next-step" && !recordedUrl.searchParams.get("step");
    const source = (isDoneStep(item) && isEngineStep(item) && opensEditor ? null : recordedSource) ?? deal;
    const sourcePage = source ? recordPages.get(new URL(source, "https://doctorcre.invalid").pathname) : null;
    const namedRecord = sourcePage === "deal" || sourcePage === "client" || sourcePage === "contact";
    const due = item.due_on && <time dateTime={item.due_on}>{cardDate.format(new Date(item.due_on))}</time>;
    const daysLate =
      item.section === "inbox" && item.action_id && (home || item.engine_marks)
        ? (item.days_late ?? lateDays(item.due_on))
        : 0;
    const dueCaption = daysLate ? `${daysLate} day${daysLate === 1 ? "" : "s"} late` : due && <>Due {due}</>;
    const cue = home ? homeCardCue(item) : null;
    const legacyFailedReply =
      !item.engine_marks && item.source_type === "email_proposal" && item.source_state === "failed";
    const detail =
      snoozeLabel(item) ||
      draftCardStatus(item) ||
      (item.section === "done" || (!item.engine_marks && item.auto_settled)
        ? completionLabel(item)
        : item.disposition === "settled"
          ? "Hidden from inbox by you"
          : item.source_state === "working"
            ? "Dr. CRE is working. You can come back to this."
            : item.source_state === "done"
              ? completionLabel(item)
              : item.source_state === "failed"
                ? home && !presentation && !legacyFailedReply && "Open the card to review the failed action."
                : !item.engine_marks && "Ready for your attention");
    const waitingOn =
      item.waiting_reason ??
      (item.waiting_on &&
        [
          item.waiting_on.identity.display_name && `Waiting for ${item.waiting_on.identity.display_name}`,
          item.waiting_on.reason,
        ]
          .filter(Boolean)
          .join(" · "));
    const returns =
      item.returns_at && !item.hold_until && !item.snoozed_until
        ? `Returns ${snoozeDate.format(new Date(item.returns_at))} Central`
        : null;
    const hold =
      item.hold_until &&
      `On hold until ${
        item.hold_until.length === 10
          ? cardDate.format(new Date(item.hold_until))
          : `${snoozeDate.format(new Date(item.hold_until))} Central`
      }`;
    const propertyFeedback =
      feedbackReview &&
      source &&
      sourcePage === "deal" &&
      new URL(source, "https://doctorcre.invalid").searchParams.has("property");
    const linkedRecord = source && (
      <a className="inbox-source" href={source}>
        {propertyFeedback
          ? "Open property"
          : sourcePage === "call"
            ? "Call summary"
            : (namedRecord && item.context_label) || `Open ${sourcePage}`}
      </a>
    );
    return (
      <article
        key={cardKey(item)}
        className={presentation || isDoneStep(item) ? "inbox-row inbox-row-explained" : "inbox-row"}
        data-inbox-row={item.item_id}
        data-current={item_id === item.item_id || undefined}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (touch) gesture.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0],
            start = gesture.current;
          gesture.current = null;
          if (
            !touch ||
            !start ||
            Math.abs(touch.clientY - start.y) > 45 ||
            Math.abs(touch.clientX - start.x) < 90 ||
            busy ||
            reviewing
          )
            return;
          if (touch.clientX > start.x && wakeable) act(markAction, [item]);
          else if (touch.clientX < start.x && snoozable) {
            snoozeOpener.current = event.currentTarget.querySelector("h3 a");
            openSnooze([item]);
          }
        }}
      >
        <label className="inbox-select">
          <input
            type="checkbox"
            aria-label={`Select ${item.title}`}
            checked={selected.has(item.item_id)}
            disabled={busy || !!reviewing || !snoozable || item.source_state === "working"}
            onChange={(event) =>
              select((previous) => {
                const next = new Set(previous);
                if (event.target.checked) next.add(item.item_id);
                else next.delete(item.item_id);
                return next;
              })
            }
          />
        </label>
        <div className="inbox-copy">
          {!home && (
            <p className="inbox-meta">
              <span>{item.kind_label}</span>
              {!item.engine_marks && (
                <span className={`inbox-badge inbox-${item.source_state}`}>
                  {item.source_state.replaceAll("_", " ")}
                </span>
              )}
            </p>
          )}
          <h3
            className={presentation || open || item_id === item.item_id ? "inbox-title-expanded" : undefined}
            tabIndex={canOpen ? undefined : -1}
          >
            {canOpen ? (
              <Link
                aria-current={item_id === item.item_id ? "true" : undefined}
                aria-expanded={directUrl ? undefined : open}
                aria-disabled={openingLocked}
                to={directUrl ?? recordRoutes.card(item.item_id)}
                reloadDocument={Boolean(directUrl)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  if (openingLocked || !directUrl) event.preventDefault();
                  if (!openingLocked && !directUrl) openCard(item, event.currentTarget);
                }}
              >
                {item.title}
              </Link>
            ) : (
              item.title
            )}
          </h3>
          {cue && (
            <p className="inbox-detail">
              <strong>{cue}</strong>
            </p>
          )}
          {presentation && <p className="inbox-why">{presentation.why}</p>}
          {(item.context_label || due) && (
            <p className="inbox-context">
              {item.context_label}
              {due && (
                <>
                  {" "}
                  {item.context_label && "· "}
                  {dueCaption}
                </>
              )}
            </p>
          )}
          {callAt && !presentation && (
            <p className="inbox-detail">
              From your call{callContact && ` with ${callContact}`} on{" "}
              <time dateTime={callAt}>{callDate.format(new Date(callAt))}</time>
            </p>
          )}
          {emailAt && (
            <p className="inbox-detail">
              Received <time dateTime={emailAt}>{snoozeDate.format(new Date(emailAt))} Central</time>
            </p>
          )}
          {(detail || hold || waitingOn || returns || item.section === "held") && (
            <p className="inbox-detail">
              {[waitingOn, detail, returns, hold || (item.section === "held" && "On hold")].filter(Boolean).join(" · ")}
            </p>
          )}
          {item_id === item.item_id && !open && !directUrl && linkedRecord}
          {item_id === item.item_id && !open && item.source_type === "notification" && (
            <HomeWatchDetail open_url={item.open_url} />
          )}
          {item_id === item.item_id && item.open_url && !source && <p role="status">This link can't be opened here.</p>}
        </div>
        {(!open || !finishedElsewhere) && (!waitingCard || wakeable) && (
          <div className="inbox-actions">
            {!waitingCard && presentation && (
              <button
                type="button"
                className="inbox-primary"
                aria-expanded={directUrl || namedAction === "Mark done" ? undefined : open}
                disabled={openingLocked || (namedAction === "Mark done" && (!completable || !!reviewing))}
                onClick={(event) => {
                  if (namedAction === "Mark done") act("complete", [item]);
                  else openDetails(event.currentTarget);
                }}
              >
                {namedAction}
              </button>
            )}
            {!presentation && !waitingCard && canOpen && (
              <button
                type="button"
                className={completable || tourDone || reviewLabel ? undefined : "inbox-primary"}
                aria-expanded={directUrl ? undefined : open}
                disabled={openingLocked}
                onClick={(event) => openDetails(event.currentTarget)}
              >
                Open
              </button>
            )}
            {!presentation && reviewLabel && (
              <button
                type="button"
                className="inbox-primary"
                aria-expanded={open}
                disabled={openingLocked}
                onClick={(event) => openCard(item, event.currentTarget)}
              >
                {reviewLabel}
              </button>
            )}
            {reopenable && (
              <button
                type="button"
                disabled={busy || !!pending || !!reviewing}
                onClick={() => act("reopen", [item], undefined, true)}
              >
                Undo
              </button>
            )}
            {!presentation && (completable || tourDone) && (
              <button
                type="button"
                className="inbox-primary"
                disabled={busy || !!reviewing}
                onClick={() => act(tourDone ? "done" : "complete", [item])}
              >
                {tourDone ? "Done" : "Mark done"}
              </button>
            )}
            {legacyFailedReply && (
              <p className="inbox-detail inbox-guidance">
                {home
                  ? "This reply didn't send. Send it from your email."
                  : "This reply didn't send. Send it from your email, then press Hide from inbox."}
              </p>
            )}
            {wakeable && (
              <button type="button" disabled={busy || !!reviewing} onClick={() => act(markAction, [item])}>
                {primary}
              </button>
            )}
            {snoozable && (
              <button
                type="button"
                disabled={busy || !!reviewing}
                onClick={(event) => {
                  snoozeOpener.current = event.currentTarget;
                  openSnooze([item]);
                }}
              >
                Snooze
              </button>
            )}
            {droppable && (
              <button
                type="button"
                disabled={busy || !!pending || !!reviewing || !online}
                onClick={(event) => setDropping({ item, opener: event.currentTarget })}
              >
                Drop
              </button>
            )}
          </div>
        )}
        {open && (
          <ReviewCard
            item={reviewing}
            readOnly={waitingCard || finishedElsewhere}
            client={reviewClient}
            draftEdits={reviewingDraftId ? draftEdits.get(reviewingDraftId) : undefined}
            updateDraftEdits={(edits) => {
              if (reviewingDraftId) updateDraftEdits(reviewingDraftId, edits);
            }}
            blockSwitching={setReviewUncertain}
            close={() => setReviewing(null)}
            busy={(value) => {
              inFlight.current = value;
              setBusy(value);
              if (value) void cache.cancelQueries({ queryKey });
            }}
            confirmed={async (current, receipt, snapshot) => {
              if (!current) setReviewing(null);
              await updateAfterSave(snapshot, current ? [current] : []);
              if (!mounted.current || !current) return;
              if (receipt) {
                setUndo((entries) => [
                  ...entries.filter((entry) => entry.items[0]?.item_id !== current.item_id),
                  { action: "reopen", items: [current], receipt },
                ]);
                setNotice(`Marked done: ${current.title}. You can undo this change.`);
              }
            }}
          >
            {finishedElsewhere && <p role="status">This card was finished elsewhere.</p>}
            {!finishedElsewhere && !item.engine_marks && due && <p>Due {due}</p>}
            {presentation && (feedbackReview || isDoneStep(item)) && <p>{presentation.why}</p>}
            {isDoneStep(item) && <p>{completionLabel(item)}</p>}
            {linkedRecord}
            {!finishedElsewhere && feedbackReview && tourDone && (
              <div className="inbox-actions">
                <button
                  type="button"
                  className="inbox-primary"
                  disabled={openingLocked}
                  onClick={() => {
                    setReviewing(null);
                    act("done", [item]);
                  }}
                >
                  Done
                </button>
              </div>
            )}
            {activity && !reviewClient && (
              <>
                {typeof activity.contact === "string" && <p>Call with {activity.contact}</p>}
                {activityAt && <time dateTime={activityAt}>{snoozeDate.format(new Date(activityAt))} Central</time>}
                {typeof activity.summary === "string" && <p>{sourceExcerptText(activity.summary)}</p>}
                {typeof activity.quote === "string" && <blockquote>{sourceExcerptText(activity.quote)}</blockquote>}
              </>
            )}
            {deal && sourcePage !== "deal" && (
              <p>
                <a className="inbox-source" href={deal}>
                  {sourcePage === "call" && item.context_label ? item.context_label : "Open deal"}
                </a>
              </p>
            )}
            {!source && !["email_proposal", "fact_review"].includes(item.source_type) && <p>No linked record.</p>}
            {item.source_type === "email_proposal" && !reviewClient && (
              <p>The email and draft are unavailable for this card.</p>
            )}
            {item.source_type === "notification" && <HomeWatchDetail open_url={item.open_url} />}
          </ReviewCard>
        )}
      </article>
    );
  }
  return (
    <section
      aria-label="Inbox cards"
      className={home ? "home-inbox" : undefined}
      ref={root}
      tabIndex={home ? -1 : undefined}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp"].includes(event.key) ||
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(`[data-inbox-row] ${cardTitle}`)
        )
          return;
        const links = Array.from(
          root.current?.querySelectorAll<HTMLElement>(`[data-inbox-row] ${cardTitle}`) || [],
        ).filter(visibleRow);
        const index = links.indexOf(event.target);
        const next = links[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {!home && (
        <header className="inbox-header">
          <div>
            <h1>Inbox</h1>
            <p>Your attention, updates and work in progress.</p>
          </div>
          <button
            type="button"
            disabled={query.isFetching || busy || !!pending || !online}
            onClick={() => void query.refetch()}
          >
            Refresh inbox
          </button>
        </header>
      )}
      {!home && (
        <div className="inbox-health" role="status">
          {!online
            ? "Offline · Inbox changes unavailable. Nothing will replay automatically."
            : query.isFetching
              ? "Updating inbox…"
              : query.isError
                ? "Update unavailable"
                : query.isStale
                  ? "Snapshot may be stale · Refresh before acting."
                  : "Up to date"}
        </div>
      )}
      {!home && query.data && !query.data.engine_marks && !query.data.auto_settle_enabled && (
        <p role="status">
          Automatic settlement unavailable. Showing the earlier inbox; completed items may still need review.
        </p>
      )}
      {notice && (
        <div className="inbox-notice" role="status">
          <p>{notice}</p>
          {failures.map(
            (result) =>
              !result.ok && (
                <p key={result.item_id}>
                  {items.find((item) => item.item_id === result.item_id)?.title || result.item_id} ·{" "}
                  {inboxRefusal(result.error)}
                </p>
              ),
          )}
          {pending && (
            <>
              <button type="button" disabled={busy || !online} onClick={() => void run(pending)}>
                Retry same request
              </button>
              <button
                type="button"
                disabled={busy || !!reviewing}
                onClick={() => {
                  setPending(null);
                  setFailures([]);
                  setNotice("Request dismissed. Refresh to check canonical state before another action.");
                  void query.refetch();
                }}
              >
                Dismiss and refresh
              </button>
            </>
          )}
          {!pending &&
            availableUndo.map((previous) => (
              <button
                type="button"
                key={previous.items[0]?.item_id}
                disabled={busy || !!reviewing}
                onClick={() => {
                  setUndo((entries) => entries.filter((entry) => entry !== previous));
                  const change = "mark" in previous ? restoreMark(previous.mark) : previous;
                  act(
                    change.action,
                    previous.items,
                    change.until,
                    true,
                    "receipt" in change ? change.receipt : undefined,
                  );
                }}
              >
                {availableUndo.length === 1 ? "Undo" : `Undo ${previous.items[0]?.title}`}
              </button>
            ))}
        </div>
      )}
      {query.isPending ? (
        <p className="inbox-empty" role="status">
          Loading your inbox…
        </p>
      ) : query.isError && !query.data ? (
        <div className="inbox-empty" role="alert">
          <h2>{home ? "Reminders and waiting items unavailable" : "Inbox unavailable"}</h2>
          <p>{message(query.error)}</p>
          {!home && <p>Refresh to try again.</p>}
        </div>
      ) : (
        <>
          {item_id && !placed.current && <p role="status">This card is not in your current inbox snapshot.</p>}
          {query.data && "truncated" in query.data && query.data.truncated && (
            <p role="status">Showing the first 1,000 cards. More work is available.</p>
          )}
          {!home && (
            <>
              <section className="inbox-section" aria-label="Inbox">
                <div className="inbox-section-title">
                  <h2>
                    Needs your attention <span>{placed.inbox.length}</span>
                  </h2>
                  {!query.data?.engine_marks && <p>Mark done finishes a task. Hide from inbox leaves the task open.</p>}
                </div>
                {placed.inbox.length ? (
                  placed.inbox.map(row)
                ) : (
                  <div className="inbox-empty">
                    <h3>You’re all caught up.</h3>
                    <p>New work will appear here. Your shelves stay below.</p>
                  </div>
                )}
              </section>
              {visibleShelves.map((shelf) => (
                <details className="inbox-shelf" key={shelf} open={placed.current?.section === shelf || undefined}>
                  <summary>
                    <span>
                      {shelf === "working"
                        ? "Dr. CRE is working"
                        : shelf === "held"
                          ? "Held"
                          : shelf === "done"
                            ? "Done"
                            : shelf === "snoozed"
                              ? "Snoozed"
                              : "Settled"}
                    </span>
                    <span>{placed[shelf].length}</span>
                  </summary>
                  {placed[shelf].length ? (
                    placed[shelf].map(row)
                  ) : (
                    <p className="inbox-shelf-empty">Nothing here right now.</p>
                  )}
                </details>
              ))}
            </>
          )}
        </>
      )}
      {home && (
        <HomeGrid snapshot={query.data} calendar={meetings.data}>
          <CardTile
            title="Reminders"
            items={tiles.reminders}
            pinned={pinnedTile === "reminders" ? reviewing : null}
            current={reviewing?.item_id || item_id}
            after={earlierMeetingReviews(meetings.data, meetingDay, handledMeetings).map((review) => (
              <MeetingReview key={review.key} data={meetings.data} review={review} finish={finishMeeting} />
            ))}
            row={row}
          />
          <CardTile
            title="In motion and waiting"
            items={tiles.waiting}
            pinned={pinnedTile === "waiting" ? reviewing : null}
            current={reviewing?.item_id || item_id}
            row={row}
          />
          {meetings.data && (
            <MeetingTile
              data={meetings.data}
              stale={meetings.isError}
              today={meetingDay}
              handled={handledMeetings}
              finish={finishMeeting}
            />
          )}
        </HomeGrid>
      )}
      {home && meetings.isError && (
        <p className="home-read-status" role="status">
          Meetings unavailable.
        </p>
      )}
      {home && ((query.isError && query.data) || !online) && (
        <p className="home-read-status" role="status">
          {!online ? "Offline. Showing the last available update." : "Reminders and waiting items unavailable."}
        </p>
      )}
      {home ? (
        <BulkControls
          finish={finishBatch}
          client={client}
          engine={query.data?.engine_marks === true}
          picked={picked}
          selected={selected}
          locked={singleBusy || !!pending || !!reviewing || !online}
          select={select}
          snapshot={updateAfterSave}
          prepare={() => cache.cancelQueries({ queryKey })}
          lock={(value) => {
            inFlight.current = value;
            setBatchBusy(value);
          }}
        />
      ) : (
        !query.data?.engine_marks &&
        picked.length > 0 && (
          <div role="toolbar" className="inbox-bulk" aria-label="Selected cards">
            <strong>{picked.length} selected</strong>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={() => act("settle", picked)}
            >
              Hide selected
            </button>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={() => act("unsettle", picked)}
            >
              Show selected
            </button>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={(event) => {
                snoozeOpener.current = event.currentTarget;
                openSnooze(picked);
              }}
            >
              Snooze selected
            </button>
            <button type="button" onClick={() => select(new Set())}>
              Clear
            </button>
          </div>
        )
      )}
      {dropping && (
        <DropReason
          title={dropping.item.title}
          cancel={() => {
            dropping.opener.focus();
            setDropping(null);
          }}
          confirm={(reason) => {
            const item = dropping.item;
            setDropping(null);
            void run({ request: dropCommand(item, reason), before: [item] });
          }}
        />
      )}
      {snooze && (
        <dialog
          className="inbox-snooze"
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onCancel={() => {
            cancelSnooze();
          }}
          aria-label="Snooze cards"
        >
          <h2>Snooze {snooze.items.length === 1 ? "card" : `${snooze.items.length} cards`}</h2>
          <p>Choose when this returns to your inbox. All times are Central.</p>
          {snooze.error && <p role="alert">{snooze.error}</p>}
          {snooze.choices.map((choice) => (
            <button
              type="button"
              ref={(button) => {
                if (choice.hours === 1) button?.focus();
              }}
              key={choice.hours}
              onClick={() => {
                if (Date.parse(choice.until) <= Date.now()) {
                  setSnooze({
                    ...snooze,
                    error: "This return time has passed. Cancel and reopen Snooze to choose a new time.",
                  });
                  return;
                }
                const rows = snooze.items;
                setSnooze(null);
                act("snooze", rows, choice.until);
              }}
            >
              {choice.hours === 1 ? "1 hour" : "24 hours"} · <time dateTime={choice.until}>{choice.label}</time>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              cancelSnooze();
            }}
          >
            Cancel
          </button>
        </dialog>
      )}
      {!home && (
        <footer className="inbox-footer">
          Use ↑ ↓ to move between cards. On your phone, swipe right to{" "}
          {(query.data?.engine_marks ?? engineHome) ? "wake a snoozed card" : "hide or wake"}, left to snooze.
        </footer>
      )}
    </section>
  );
}
function LinkedReview({ itemId, client }: { itemId: string; client: InboxClient["linkedReview"] }) {
  const [draftEdits, setDraftEdits] = useState<DraftEdit | undefined>();
  const { data, isPending } = useQuery({
    queryKey: ["home-linked-review", itemId],
    queryFn: ({ signal }) => client.read(itemId, signal),
  });

  if (!data)
    return (
      <>
        <p role="status">{isPending ? "Loading review…" : "This review is unavailable."}</p>
        <a href="/">Back to Home</a>
      </>
    );

  if (data.state !== "active")
    return (
      <>
        <p role="status">{reviewDispositionLabel(data.state, itemId.startsWith("reply_draft:"))}</p>
        {data.reason && <p>{data.reason}</p>}
        <a href="/">Back to Home</a>
      </>
    );

  const waiting = isWaitingCard(data.item);
  return (
    <>
      <h1>{data.item.title}</h1>
      {waiting && (
        <>
          <p role="status">{snoozeLabel(data.item) ?? data.item.waiting_reason}</p>
          <a href="/">Back to Home</a>
        </>
      )}
      <ReviewCard
        item={data.item}
        readOnly={waiting}
        client={client.client}
        draftEdits={draftEdits}
        updateDraftEdits={(edits) => setDraftEdits(edits ?? undefined)}
        close={() => location.assign("/")}
      />
    </>
  );
}

function InboxCard({ client }: { client: InboxClient }) {
  const { item_id } = useParams();
  if (item_id?.startsWith("suggestion:") || item_id?.startsWith("reply_draft:"))
    return <LinkedReview key={item_id} itemId={item_id} client={client.linkedReview} />;
  return <Inbox client={client} />;
}

export function mountInbox(host: HTMLElement, client: InboxClient) {
  const query = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 0,
        // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
        retry: false,
        refetchOnWindowFocus: false,
        // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
        refetchOnReconnect: false,
        networkMode: "always",
      },
      // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
      mutations: { retry: false, networkMode: "always" },
    },
  });
  const root = createRoot(host);
  const inbox: ReactNode = <Inbox client={client} />;
  root.render(
    <QueryClientProvider client={query}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={inbox} />
          <Route path="/inbox" element={inbox} />
          <Route path="/inbox.html" element={inbox} />
          <Route path="/inbox/card/:item_id" element={<InboxCard client={client} />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  addEventListener(
    "doctorcre-session-invalidated",
    () => {
      query.clear();
      root.unmount();
    },
    { once: true },
  );
}
