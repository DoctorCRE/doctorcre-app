import { readDashboardGroups } from "./dashboard-read";

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const instant = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function unavailableReason(section: unknown, fallback: string) {
  return object(section) && section.state === "unavailable" && text(section.reason) ? section.reason : fallback;
}

function localHref(value: unknown) {
  const base = "https://doctorcre.invalid";
  return typeof value === "string" && /^\/[a-z]/.test(value) && URL.parse(value, base)?.origin === base ? value : null;
}

type Meeting = Record<string, unknown> & { title: string; start: string; end: string };
function meeting(value: unknown): value is Meeting {
  return object(value) && text(value.title) && instant(value.start) && instant(value.end);
}
type Reminder = Record<string, unknown> & {
  kind: "step" | "call_follow_up";
  title: string;
  owner: string;
  due_on: string;
  deal_ended?: true;
};
type Partner = { slug: string; name: string };
function partner(value: unknown): value is Partner {
  return object(value) && text(value.slug) && text(value.name);
}

const sibling = (path: string) => import(new URL(path, import.meta.url).href);

export async function mountHomeTodayPanel(
  rail: HTMLElement,
  readDeals: (signal: AbortSignal) => Promise<unknown[]>,
  { hideEndedDealReminders = false } = {},
) {
  const [transport, dates, week, receipts, reviews]: [
    {
      readWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>, options: { signal: AbortSignal }): Promise<T>;
      sessionFetch(path: string, init: RequestInit): Promise<Response>;
    },
    { isCalendarDay(value: unknown): value is string; shortDay(value: string, today: string): string },
    { meetingTime(value: string, zone: string, includeDate?: boolean): string },
    { escapeText(value: string): string },
    {
      mountHomeMeetingReviews(options: { document: Document; host: HTMLElement; engine: true }): {
        update(view: { actor?: string | null; calendar?: unknown; deals?: unknown[] | null }): void;
        dispose(): void;
      };
    },
  ] = await Promise.all([
    Promise.all([sibling("./current-read.mjs"), sibling("./private-session.js")]).then(([read, session]) => ({
      readWithDeadline: read.readWithDeadline,
      sessionFetch: session.sessionFetch,
    })),
    sibling("./calendar-model.js"),
    sibling("./home-week.js"),
    sibling("./change-receipts.mjs"),
    sibling("./home-meeting-reviews.js"),
  ]);
  const { escapeText } = receipts;
  const central = (value: string, includeDate = false) => week.meetingTime(value, "America/Chicago", includeDate);
  const status = (message: string) => `<p class="app-layout-empty">${escapeText(message)}</p>`;
  function meetingRow(item: Meeting) {
    const deal = localHref(item.open_url);
    const matches = Array.isArray(item.possible_deals) ? item.possible_deals.filter(object) : [];
    const related = deal
      ? `<a href="${escapeText(deal)}">Open deal</a>`
      : matches
          .map((match) => {
            const href = localHref(match.open_url);
            return href && text(match.name) ? `<a href="${escapeText(href)}">${escapeText(match.name)}</a>` : "";
          })
          .join("");
    const attendees = (Array.isArray(item.attendees) ? item.attendees.filter(object) : [])
      .map((person) => (text(person.name) ? person.name : person.email))
      .filter(text);
    const warning = item.schedule_conflict
      ? "Overlapping meetings. Check Outlook."
      : item.time_changed
        ? "Time changed. Check Outlook."
        : "";
    return `<details class="calendar-panel-meeting app-layout-item">
      <summary><strong>${escapeText(item.title)}</strong>
        <time datetime="${escapeText(item.start)}">${item.all_day ? "All day" : `${escapeText(central(item.start, true))} to ${escapeText(central(item.end))}`}</time>
        ${text(item.context_label) ? `<span>${escapeText(item.context_label)}</span>` : ""}
      </summary>
      <small>${attendees.length ? `Attendees: ${escapeText(attendees.join(", "))}` : "No attendees listed."}</small>
      ${text(item.location) ? `<small>${escapeText(item.location)}</small>` : ""}
      ${warning ? `<small>${warning}</small>` : ""}
      ${related}
    </details>`;
  }

  const schedule = rail.querySelector("#appScheduleSlot");
  const reviewHost = rail.querySelector<HTMLElement>("#appMeetingReviews");
  const late = rail.querySelector("#appTodayNeeds");
  const lateGroup = rail.querySelector<HTMLElement>("#appTodayLate");
  const upcoming = rail.querySelector("#appTodayNext");
  const owners = rail.querySelector<HTMLElement>("#appTodayOwners");
  const retry = rail.querySelector<HTMLButtonElement>("#appTodayRetry");
  if (!schedule || !reviewHost || !late || !lateGroup || !upcoming || !owners || !retry)
    throw Error("Missing Today panel");

  const meetingReviews = reviews.mountHomeMeetingReviews({
    document: rail.ownerDocument,
    host: reviewHost,
    engine: true,
  });
  owners.classList.add("chip-bar");
  owners.setAttribute("role", "group");
  owners.setAttribute("aria-label", "Reminders for");
  let scope = "all";
  const paintOwnerSelection = () => {
    for (const button of owners.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.value === scope));
    }
  };

  type DatedReminders = { today: string; partners: Partner[]; late: Reminder[]; upcoming: Reminder[] };
  let data: DatedReminders | null = null;
  let revision = 0;
  let homeCards = new Set<string>();
  const rendered = new Map<Element, string>();
  const paint = (node: Element, html: string) => {
    if (rendered.get(node) === html) return;
    node.innerHTML = html;
    rendered.set(node, html);
  };
  const renderReminders = (message: string) => {
    const name = new Map(data?.partners.map((p) => [p.slug, p.name]));
    const rows = (items: Reminder[], today: string) =>
      items
        .filter((item) => scope === "all" || item.owner === scope)
        .filter((item) => !hideEndedDealReminders || item.deal_ended !== true)
        .map((item) => {
          const destination =
            text(item.home_item_id) && homeCards.has(item.home_item_id)
              ? `/?card=${encodeURIComponent(item.home_item_id)}`
              : localHref(item.open_url);
          const timing = text(item.late_label) ? item.late_label : dates.shortDay(item.due_on, today);
          const detail = [item.context_label, name.get(item.owner), timing].filter(text).join(" · ");
          const why = text(item.why) ? `<span>${escapeText(item.why)}</span>` : "";
          const body = `<strong>${escapeText(item.title)}</strong>${why}<span>${escapeText(detail)}</span>`;
          return destination
            ? `<a href="${escapeText(destination)}" class="app-layout-item">${body}</a>`
            : `<div class="app-layout-item">${body}</div>`;
        })
        .join("");
    const lateRows = data ? rows(data.late, data.today) : "";
    lateGroup.hidden = !lateRows;
    paint(late, lateRows);
    const upcomingRows = data ? rows(data.upcoming, data.today) : "";
    const upcomingHeading = lateRows && upcomingRows ? "<h4>Due today</h4>" : "";
    paint(
      upcoming,
      upcomingHeading + (upcomingRows || (lateRows ? "" : status(data ? "No dated reminders." : message))),
    );
  };
  owners.onclick = (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    scope = event.target.value;
    paintOwnerSelection();
    renderReminders("");
  };
  const clear = (state: "loading" | "offline" | "unavailable" = "unavailable") => {
    revision++;
    data = null;
    meetingReviews.update({});
    owners.hidden = true;
    retry.hidden = state === "loading";
    paint(
      schedule,
      status(
        state === "loading"
          ? "Loading meetings…"
          : state === "offline"
            ? "Meetings unavailable while offline."
            : "Couldn't load meetings.",
      ),
    );
    renderReminders(
      state === "loading"
        ? "Loading dated reminders…"
        : state === "offline"
          ? "Dated reminders unavailable while offline."
          : "Couldn't load dated reminders.",
    );
  };
  clear("loading");

  const showMeetings = (section: unknown) => {
    if (
      !object(section) ||
      !["ready", "empty", "partial"].includes(String(section.state)) ||
      !Array.isArray(section.items) ||
      !section.items.every(meeting)
    ) {
      paint(schedule, status("Couldn't load meetings."));
      return false;
    }
    paint(
      schedule,
      section.items.length
        ? section.items.map(meetingRow).join("")
        : status(section.state === "partial" ? "Couldn't load meetings." : "No meetings today."),
    );
    return true;
  };

  function reminders(answer: Record<string, unknown> & { today: string }): DatedReminders | null {
    const section = answer.reminders;
    const validRow = (value: unknown): value is Reminder =>
      object(value) &&
      (value.kind === "step" || value.kind === "call_follow_up") &&
      text(value.title) &&
      text(value.owner) &&
      dates.isCalendarDay(value.due_on) &&
      (!("deal_ended" in value) || value.deal_ended === true);
    if (
      !object(section) ||
      !["ready", "empty"].includes(String(section.state)) ||
      !Array.isArray(section.late) ||
      !section.late.every(validRow) ||
      !Array.isArray(section.upcoming) ||
      !section.upcoming.every(validRow)
    )
      return null;
    const partners = Array.isArray(answer.partners) ? answer.partners.filter(partner) : [];
    const outsideLeads = (item: Reminder) => !/^\/leads(?:\.html)?(?:[?#]|$)/.test(localHref(item.open_url) ?? "");
    return {
      today: answer.today,
      partners,
      late: section.late.filter(outsideLeads),
      upcoming: section.upcoming.filter(outsideLeads),
    };
  }

  return {
    clear,
    dispose() {
      meetingReviews.dispose();
    },
    async refresh(signal: AbortSignal) {
      const current = ++revision;
      let answer: unknown;
      try {
        answer = await transport.readWithDeadline(
          async (bounded) => {
            const response = await transport.sessionFetch("/api/engine/home/today", { signal: bounded });
            if (!response.ok) return null;
            return response.json();
          },
          { signal },
        );
      } catch {
        /* Both sections show the read failure below. */
      }
      if (signal.aborted || current !== revision) return false;
      if (
        !object(answer) ||
        answer.ok !== true ||
        answer.schema_version !== "home-today.v1" ||
        !dates.isCalendarDay(answer.today)
      ) {
        clear();
        return false;
      }
      const meetingsReady = showMeetings(answer.meetings);
      const dated = reminders({ ...answer, today: answer.today });
      const groups =
        dated && [...dated.late, ...dated.upcoming].some((item) => text(item.home_item_id))
          ? await readDashboardGroups(signal).catch(() => null)
          : null;
      if (signal.aborted || current !== revision) return false;
      homeCards = new Set(groups ? [...groups.reminders, ...groups.waiting].map((card) => card.item_id) : []);
      data = dated;
      const partners = data?.partners ?? [];
      if (!partners.some((p) => p.slug === scope)) scope = "all";
      const options = [{ slug: "all", name: "Both partners" }, ...partners];
      paint(
        owners,
        options
          .map((p) => `<button class="chip" type="button" value="${escapeText(p.slug)}">${escapeText(p.name)}</button>`)
          .join(""),
      );
      paintOwnerSelection();
      owners.hidden = !partners.length;
      renderReminders(unavailableReason(answer.reminders, "Couldn't load dated reminders."));
      retry.hidden = meetingsReady && data !== null;
      const calendar = meetingsReady && object(answer.meetings) ? answer.meetings : null;
      const actor = text(answer.viewer) ? answer.viewer : null;
      let deals: unknown[] | null = [];
      if (actor && Array.isArray(calendar?.follow_up_reviews) && calendar.follow_up_reviews.length) {
        deals = await transport.readWithDeadline(readDeals, { signal }).catch(() => null);
        if (signal.aborted || current !== revision) return false;
        if (!deals) retry.hidden = false;
      }
      meetingReviews.update({ actor, calendar, deals });
      return retry.hidden;
    },
  };
}
