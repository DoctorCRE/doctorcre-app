export type ActivityPorts = {
  businessDay: (when: Date) => string;
  compareInstants: (left: string, right: string) => number;
  escapeText: (value: unknown) => string;
  emailSubject: (subject: unknown) => string;
  calendarDay: (when: unknown) => string | null;
  changeText: (event: { verb?: string; field?: string; new_value?: unknown }, planTours: boolean) => string;
  dateCaption: (day: string) => string;
  importedHistoryEntries: (history: unknown) => ReadonlyArray<{
    id: string;
    when: string;
    actor: string;
    action: string;
    facts: string;
  }>;
  timelineActor: (actor: unknown) => string;
  sourceTime: (when: string, now?: Date) => string;
  noteText: (value: unknown) => string;
};

type EmailFold = (body: string, sender: string | null) => { text: string };

type ActivityItem = {
  id: string;
  key: string;
  filter: string;
  when: string;
  who: string;
  title: string;
  /** The whole text the open item shows: its first line heads it, the rest is its body. */
  text: string;
  /** A filed email, opened as its conversation. */
  email?: string;
  /** A finished tour's visited properties. */
  properties?: string[];
  /** An activity whose deal attribution the open item can show. */
  activity?: string;
  day: string;
  caption: string;
};

type ItemFacts = Pick<ActivityItem, "id" | "filter" | "who" | "title"> &
  Partial<Pick<ActivityItem, "text" | "email" | "properties" | "activity">> & { when: unknown };

const CALLS = new Set(["call", "meeting", "tour"]);
const ENDED_STEPS = new Map([
  ["done", "Done"],
  ["cancelled", "Cancelled"],
  ["expired", "Expired"],
]);
const FILTERS = [
  ["all", "All"],
  ["emails", "Emails"],
  ["notes", "Notes"],
  ["calls", "Calls and meetings"],
  ["documents", "Documents"],
  ["changes", "Changes"],
] as const;
const EMPTY_LINE = new Map([
  ["all", "Nothing recorded yet."],
  ["emails", "No emails."],
  ["notes", "No notes."],
  ["calls", "No calls or meetings."],
  ["documents", "No documents."],
  ["changes", "No changes."],
]);

const plainEmail: EmailFold = (body) => ({ text: body });
const activityOf = (id: unknown) => (typeof id === "string" && id ? { activity: id } : {});

function propertyLine(property: Record<string, unknown>): string[] {
  const address = text(property.address);
  const name = text(property.name);
  return address ? [name ? `${name}, ${address}` : address] : [];
}
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    return row ? [row] : [];
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function values(list: readonly Record<string, unknown>[], key: string): Set<string> {
  return new Set(
    list.flatMap((item) => {
      const value = text(item[key]);
      return value ? [value] : [];
    }),
  );
}

const knownFilter = (filter: string | undefined): string =>
  filter && FILTERS.some(([id]) => id === filter) ? filter : "all";

function weekStart(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function monthName(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

export function activityGroupLabel(day: string, now: Date, ports: ActivityPorts): string {
  if (!day) return "Date not recorded";
  const today = ports.businessDay(now);
  if (weekStart(day) === weekStart(today)) return "This week";
  const [year, month] = day.split("-");
  const [nowYear, nowMonth] = today.split("-");
  if (year && month && year === nowYear && month === nowMonth) return `Earlier in ${monthName(day)}`;
  return !year || year === nowYear ? monthName(day) : `${monthName(day)} ${year}`;
}

function stamped(
  when: unknown,
  now: Date,
  ports: ActivityPorts,
): { when: string; day: string; caption: string } | null {
  if (!ports.calendarDay(when)) return null;
  const value = text(when);
  if (!value) return null;
  const dateOnly = value.length === 10;
  const instant = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(instant.getTime())) return null;
  return {
    when: value,
    day: dateOnly ? value : ports.businessDay(instant),
    caption: dateOnly ? ports.dateCaption(value) : ports.sourceTime(value, now),
  };
}

function sameDocument(event: Record<string, unknown>, ids: Set<string>, names: Set<string>): boolean {
  const activityId = text(event.activity_id);
  if (activityId && ids.has(activityId)) return true;
  const field = `${text(event.verb) ?? ""} ${text(event.field) ?? ""}`;
  if (!/document|attachment/i.test(field)) return false;
  const value = record(event.new_value);
  const name = value ? text(value.name) || text(value.filename) : text(event.new_value);
  return name !== null && names.has(name);
}

function push(items: ActivityItem[], row: ItemFacts, now: Date, ports: ActivityPorts, undated = false): void {
  const title = oneLine(row.title);
  if (!title) return;
  const stamp = stamped(row.when, now, ports) ?? (undated ? { when: "", day: "", caption: "Date not recorded" } : null);
  if (!stamp) return;
  const key = `${row.filter}:${row.id || items.length}`;
  items.push({ ...row, ...stamp, key, title, text: row.text?.trim() || row.title.trim() });
}

export function activityItems(
  detail: unknown,
  options: { planTours?: boolean; now?: Date; fold?: EmailFold; ports: ActivityPorts },
): ActivityItem[] {
  const source = record(detail) ?? {};
  const now = options.now ?? new Date();
  const fold = options.fold ?? plainEmail;
  const { ports } = options;
  const planTours = options.planTours ?? false;
  const notes = rows(source.thread);
  const noteIds = values(notes, "id");
  const correspondence = rows(source.correspondence);
  const correspondenceIds = values(correspondence, "activity_id");
  const activities = rows(source.activities);
  const activityIds = values(activities, "id");
  const activityActors = new Map(
    activities.flatMap((activity) => {
      const id = text(activity.id);
      return id && activity.actor !== undefined ? [[id, activity.actor] as const] : [];
    }),
  );
  const activitySummaries = new Map(
    activities.flatMap((activity) => {
      const id = text(activity.id);
      return id ? [[id, ports.noteText(activity.summary)] as const] : [];
    }),
  );
  const documents = rows(source.documents);
  const documentIds = values(documents, "id");
  const documentNames = values(documents, "name");
  const items: ActivityItem[] = [];
  for (const note of notes) {
    push(
      items,
      {
        id: text(note.id) ?? "",
        filter: "notes",
        when: note.created_at ?? note.at ?? note.recorded_at,
        who: ports.timelineActor(note.actor),
        title: ports.noteText(note.text),
        ...activityOf(note.id),
      },
      now,
      ports,
      true,
    );
  }
  for (const entry of correspondence) {
    const kind = text(entry.kind);
    const meeting = kind === "meeting";
    if (!meeting && kind !== "email") continue;
    const id = text(entry.activity_id) ?? "";
    const title = meeting ? text(entry.title)?.trim() || "Untitled meeting" : ports.emailSubject(entry.subject);
    const visited = planTours && meeting ? rows(entry.properties).flatMap(propertyLine) : [];
    push(
      items,
      {
        id,
        filter: meeting ? "calls" : "emails",
        when: entry.happened_at,
        who: meeting
          ? id && activityActors.has(id)
            ? ports.timelineActor(activityActors.get(id))
            : ""
          : text(entry.sender_name) || text(entry.sender) || "Unknown sender",
        title,
        ...activityOf(id),
        ...(meeting ? { text: [title, activitySummaries.get(id)].filter(Boolean).join("\n") } : { email: id }),
        ...(visited.length ? { properties: visited } : {}),
      },
      now,
      ports,
    );
  }
  for (const activity of activities) {
    const id = text(activity.id) ?? "";
    if (id && (correspondenceIds.has(id) || noteIds.has(id))) continue;
    const raw = ports.noteText(activity.summary).trim() || ports.noteText(activity.detail);
    const email = text(activity.kind) === "email";
    const sender = text(activity.sender_name)?.trim() || text(activity.sender)?.trim() || null;
    const cleaned = email && raw ? fold(raw, sender).text : raw;
    const kind = text(activity.kind);
    push(
      items,
      {
        id,
        filter: email ? "emails" : kind && CALLS.has(kind) ? "calls" : "changes",
        when: activity.occurred_at,
        who: email ? sender || ports.timelineActor(activity.actor) : ports.timelineActor(activity.actor),
        title: cleaned,
        ...activityOf(id),
      },
      now,
      ports,
    );
  }
  for (const file of documents) {
    const name = text(file.name);
    if (!name) continue;
    push(
      items,
      {
        id: text(file.id) ?? "",
        filter: "documents",
        when: file.prepared_at,
        who: ports.timelineActor(file.actor),
        title: name,
      },
      now,
      ports,
    );
  }
  for (const step of rows(source.next_actions)) {
    const status = ENDED_STEPS.get(text(step.status) ?? "");
    const name = text(step.title) || text(step.description);
    if (!status || !name) continue;
    const due = text(step.due_on);
    const updated = text(step.updated_at);
    const dueLabel = updated && due && ports.calendarDay(due) ? `Due ${ports.dateCaption(due)}` : "";
    push(
      items,
      {
        id: text(step.id) ?? "",
        filter: "changes",
        when: step.updated_at ?? step.due_on,
        who: ports.timelineActor(step.actor),
        title: [name, status, dueLabel].filter(Boolean).join(" · "),
      },
      now,
      ports,
    );
  }
  for (const event of rows(source.history)) {
    const activityId = text(event.activity_id);
    if (
      (activityId && (noteIds.has(activityId) || correspondenceIds.has(activityId) || activityIds.has(activityId))) ||
      sameDocument(event, documentIds, documentNames)
    )
      continue;
    const note = text(event.field) === "note";
    const verb = text(event.verb);
    const field = text(event.field);
    push(
      items,
      {
        id: text(event.id) ?? "",
        filter: note ? "notes" : "changes",
        when: event.recorded_at,
        who: ports.timelineActor(event.actor),
        title: note
          ? ports.noteText(event.new_value)
          : ports.changeText(
              { ...(verb ? { verb } : {}), ...(field ? { field } : {}), new_value: event.new_value },
              planTours,
            ),
      },
      now,
      ports,
    );
  }
  for (const event of ports.importedHistoryEntries(source.imported_deal_history)) {
    const facts = event.facts ? event.facts.split("\n") : [];
    push(
      items,
      {
        id: event.id,
        filter: "changes",
        when: event.when,
        who: event.actor,
        title: [event.action, ...facts].filter(Boolean).join(" · "),
        text: [event.action, ...facts].filter(Boolean).join("\n"),
      },
      now,
      ports,
    );
  }
  return items.sort((left, right) => right.day.localeCompare(left.day) || ports.compareInstants(left.when, right.when));
}

function groups(items: ActivityItem[], now: Date, ports: ActivityPorts): { label: string; items: ActivityItem[] }[] {
  const grouped: { label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const label = activityGroupLabel(item.day, now, ports);
    const last = grouped.at(-1);
    if (last?.label === label) last.items.push(item);
    else grouped.push({ label, items: [item] });
  }
  return grouped;
}

export function showActivityFilter(root: ParentNode, filter: string): string {
  const chosen = knownFilter(filter);
  for (const chip of root.querySelectorAll<HTMLElement>("[data-activity-filter]")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.activityFilter === chosen));
  }
  for (const row of root.querySelectorAll<HTMLElement>("[data-activity-kind]")) {
    row.hidden = chosen !== "all" && row.dataset.activityKind !== chosen;
  }
  for (const group of root.querySelectorAll<HTMLElement>("[data-activity-group]")) {
    group.hidden = ![...group.querySelectorAll<HTMLElement>("[data-activity-kind]")].some((row) => !row.hidden);
  }
  const empty = root.querySelector<HTMLElement>(".activity-empty");
  if (empty) {
    const any = [...root.querySelectorAll<HTMLElement>("[data-activity-kind]")].some((row) => !row.hidden);
    empty.hidden = any;
    if (!any && empty.dataset.waiting !== "true") empty.textContent = EMPTY_LINE.get(chosen) ?? "";
  }
  return chosen;
}

export function renderDealActivity(
  detail: unknown,
  options: {
    planTours?: boolean;
    now?: Date;
    fold?: EmailFold;
    filter?: string;
    note?: string;
    canNote?: boolean;
    link?: (text: string) => string;
    /** The key of the open item, if any. */
    open?: string | null;
    /** The open email's suggestions and conversation. */
    emailHtml?: (activityId: string) => string;
    ports: ActivityPorts;
  },
): { html: string; filter: string; open: string | null } {
  const now = options.now ?? new Date();
  const { ports } = options;
  const esc = ports.escapeText;
  const items = activityItems(detail, options);
  const opened = items.find((item) => item.key === options.open) ?? null;
  const selected = knownFilter(options.filter);
  const anyVisible = selected === "all" ? items.length > 0 : items.some((item) => item.filter === selected);
  const source = record(detail);
  const known = Array.isArray(source?.correspondence);
  const waiting = known ? rows(source?.email_follow_ups).filter((row) => row.kind === "file_to_deal").length : 0;
  const waitingLine =
    !items.length && waiting
      ? `No emails or meetings filed yet. ${waiting} email${waiting === 1 ? " is" : "s are"} waiting to be filed on Overview.`
      : "";
  const link = options.link ?? ((value: string) => esc(value));
  const note = options.note ?? "";
  const canNote = options.canNote ?? true;
  const body = groups(items, now, ports)
    .map((group) => {
      const groupHidden = !group.items.some((item) => selected === "all" || item.filter === selected);
      return `<section data-activity-group${groupHidden ? " hidden" : ""}><h3>${esc(group.label)}</h3><ol>${group.items
        .map((item) => {
          const who = item.who ? `<span>${esc(item.who)}</span>` : "";
          const when = item.caption ? `<span>${esc(item.caption)}</span>` : "";
          const meta = who && when ? `${who} · ${when}` : who || when;
          const hidden = selected !== "all" && item.filter !== selected;
          const current = item.key === opened?.key ? ' aria-current="true"' : "";
          return `<li class="activity-row" data-activity-kind="${item.filter}"${hidden ? " hidden" : ""}><button type="button" class="activity-open" data-activity-open="${esc(item.key)}"${current}><span class="activity-title">${esc(item.title)}</span><span class="activity-meta">${meta}</span></button></li>`;
        })
        .join("")}</ol></section>`;
    })
    .join("");
  const emptyLine =
    known || items.length
      ? `<p class="activity-empty"${anyVisible ? " hidden" : ""}${waitingLine ? ' data-waiting="true"' : ""}>${esc(waitingLine || EMPTY_LINE.get(selected) || "")}</p>`
      : "";
  const pane = opened ? openItemHtml(opened, { esc, link, emailHtml: options.emailHtml ?? (() => "") }) : "";
  const html = `<div class="deal-activity" data-detail-read="activity"${opened ? " data-open" : ""}><div class="activity-side"><h2>Activity</h2>
    <form id="activityNoteForm" class="activity-note"><label class="sr-only" for="activityNote">Note</label><textarea id="activityNote" name="text" rows="1" maxlength="10000" placeholder="Add a note"${canNote ? "" : " disabled"}>${esc(note)}</textarea><button class="btn" type="submit"${canNote ? "" : " disabled"}>Add note</button><p id="activityNoteStatus" role="status"></p></form>
    <div class="chip-bar" role="group" aria-label="Activity filter">${FILTERS.map(
      ([id, label]) =>
        `<button type="button" class="chip" data-activity-filter="${id}" aria-pressed="${selected === id}">${label}</button>`,
    ).join("")}</div>
    ${known ? "" : '<p>Emails and meetings unavailable.</p><button class="btn" type="button" data-refresh-detail>Retry emails and meetings</button>'}
    <div class="activity-list">${body}${emptyLine}</div></div>${pane}</div>`;
  return { html, filter: selected, open: opened?.key ?? null };
}

function openItemHtml(
  item: ActivityItem,
  {
    esc,
    link,
    emailHtml,
  }: { esc: (value: unknown) => string; link: (text: string) => string; emailHtml: (id: string) => string },
): string {
  const meta = [item.who, item.caption].filter(Boolean).map(esc).join(" · ");
  const doc = (question?: string) =>
    `/doc-chats?${new URLSearchParams({ email: item.email ?? "" })}${question ? `#${new URLSearchParams({ question })}` : ""}`;
  const actions = item.email
    ? `<a class="btn" href="${esc(doc("Draft a reply to this email."))}">Reply</a><a class="btn btn-quiet" href="${esc(doc())}">Ask Doc</a>`
    : "";
  // The heading is the text's first line, so the body never repeats it.
  const [heading = item.title, ...rest] = item.text.split("\n").filter((line) => line.trim());
  const body = item.email ? emailHtml(item.email) : rest.map((line) => `<p>${link(line)}</p>`).join("");
  const visited = item.properties
    ? `<ul class="activity-visited" aria-label="Visited properties">${item.properties.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`
    : "";
  const attribution = item.activity
    ? `<button type="button" class="btn btn-quiet" data-attribution-id="${esc(item.activity)}" aria-expanded="false">Show deal attribution</button>`
    : "";
  return `<section class="activity-pane" aria-labelledby="activityPaneTitle"><header class="activity-pane-head"><h3 id="activityPaneTitle" tabindex="-1">${esc(oneLine(heading))}</h3><div class="activity-pane-actions">${actions}<button type="button" class="btn btn-quiet" data-activity-close><span class="activity-close-wide">Close</span><span class="activity-close-narrow">Back</span></button></div></header>
    <p class="activity-meta">${meta}</p><div class="activity-pane-body">${body}${visited}</div>${attribution}</section>`;
}
