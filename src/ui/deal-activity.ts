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
  filter: string;
  when: string;
  who: string;
  title: string;
  day: string;
  caption: string;
};

const CALLS = new Set(["call", "meeting", "tour"]);
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

function push(
  items: ActivityItem[],
  row: { id: string; filter: string; when: unknown; who: string; title: string },
  now: Date,
  ports: ActivityPorts,
  undated = false,
): void {
  const title = oneLine(row.title);
  if (!title) return;
  const stamp = stamped(row.when, now, ports);
  if (!stamp) {
    if (undated) items.push({ ...row, title, when: "", day: "", caption: "Date not recorded" });
    return;
  }
  items.push({ ...row, ...stamp, title });
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
  const noteIds = new Set(
    notes.flatMap((note) => {
      const id = text(note.id);
      return id ? [id] : [];
    }),
  );
  const correspondence = rows(source.correspondence);
  const correspondenceIds = new Set(
    correspondence.flatMap((entry) => {
      const id = text(entry.activity_id);
      return id ? [id] : [];
    }),
  );
  const documents = rows(source.documents);
  const documentIds = new Set(
    documents.flatMap((file) => {
      const id = text(file.id);
      return id ? [id] : [];
    }),
  );
  const documentNames = new Set(
    documents.flatMap((file) => {
      const name = text(file.name);
      return name ? [name] : [];
    }),
  );
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
    push(
      items,
      {
        id,
        filter: meeting ? "calls" : "emails",
        when: entry.happened_at,
        who: meeting ? "" : text(entry.sender_name) || text(entry.sender) || "Unknown sender",
        title,
      },
      now,
      ports,
    );
  }
  for (const activity of rows(source.activities)) {
    const id = text(activity.id) ?? "";
    if (id && correspondenceIds.has(id)) continue;
    const raw = ports.noteText(activity.summary).trim() || ports.noteText(activity.detail);
    const email = text(activity.kind) === "email";
    const sender = text(activity.sender) ?? text(activity.sender_name);
    const cleaned = email && raw ? fold(raw, sender).text : raw;
    const kind = text(activity.kind);
    push(
      items,
      {
        id,
        filter: email ? "emails" : kind && CALLS.has(kind) ? "calls" : "changes",
        when: activity.occurred_at,
        who: ports.timelineActor(activity.actor),
        title: cleaned,
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
  for (const event of rows(source.history)) {
    const activityId = text(event.activity_id);
    if (
      (activityId && noteIds.has(activityId)) ||
      (activityId && correspondenceIds.has(activityId)) ||
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
  const chosen = FILTERS.some(([id]) => id === filter) ? filter : "all";
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
    ports: ActivityPorts;
  },
): { html: string; filter: string } {
  const now = options.now ?? new Date();
  const { ports } = options;
  const esc = ports.escapeText;
  const items = activityItems(detail, options);
  const requested = options.filter ?? "all";
  const selected = requested !== "all" && items.some((item) => item.filter === requested) ? requested : "all";
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
    .map(
      (group) =>
        `<section data-activity-group><h3>${esc(group.label)}</h3><ol>${group.items
          .map((item) => {
            const who = item.who ? `<span>${esc(item.who)}</span>` : "";
            const when = item.caption ? `<span>${esc(item.caption)}</span>` : "";
            const meta = who && when ? `${who} · ${when}` : who || when;
            const hidden = selected !== "all" && item.filter !== selected;
            return `<li class="activity-row" data-activity-kind="${item.filter}"${hidden ? " hidden" : ""}><span class="activity-title">${link(item.title)}</span><span class="activity-meta">${meta}</span></li>`;
          })
          .join("")}</ol></section>`,
    )
    .join("");
  const emptyLine =
    known || items.length
      ? `<p class="activity-empty"${items.length ? " hidden" : ""}${waitingLine ? ' data-waiting="true"' : ""}>${esc(waitingLine || EMPTY_LINE.get(selected) || "")}</p>`
      : "";
  const html = `<div class="deal-activity" data-detail-read="activity"><h2>Activity</h2><div class="chip-bar" role="group" aria-label="Activity filter">${FILTERS.map(
    ([id, label]) =>
      `<button type="button" class="chip" data-activity-filter="${id}" aria-pressed="${selected === id}">${label}</button>`,
  ).join("")}</div>
    <form id="activityNoteForm" class="activity-note"><label for="activityNote">Note</label><textarea id="activityNote" name="text" rows="1" maxlength="10000"${canNote ? "" : " disabled"}>${esc(note)}</textarea><button class="btn" type="submit"${canNote ? "" : " disabled"}>Add note</button><p id="activityNoteStatus" role="status"></p></form>
    ${known ? "" : '<p>Emails and meetings unavailable.</p><button class="btn" type="button" data-refresh-detail>Retry emails and meetings</button>'}
    <div class="activity-list">${body}${emptyLine}</div></div>`;
  return { html, filter: selected };
}
