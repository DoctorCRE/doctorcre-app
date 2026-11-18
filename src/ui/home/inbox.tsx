import { type BatchRequest, type BatchResult, parseBatch } from "./batch.ts";
import { type MarkUndo, markArgs, markTarget } from "./engine-marks.ts";
import { hasEngineReview, loadEngineReview, type Suggestion, saveEngineReview } from "./engine-review.ts";
import {
  type ReviewRequest as LegacyReviewRequest,
  parseReference,
  parseReview,
  type ReviewReference,
} from "./review.ts";
import { completeAction, type TaskReceipt as LegacyReceipt, parseActionReceipt } from "./task-done.ts";

type WaitingIdentity = Readonly<{
  kind: "party" | "actor";
  id: string;
  available: boolean;
  display_name: string | null;
}>;
type Waiting = Readonly<{ identity: WaitingIdentity; reason: string; evidence: string[]; version: number }>;
type BaseItem = Readonly<{
  item_id: string;
  source_type: string;
  source_id: string;
  source_version: string;
  source_state: "working" | "needs_attention" | "done" | "failed";
  title: string;
  activity_at: string;
  hold_until: string | null;
  unseen: boolean;
  disposition: "inbox" | "snoozed" | "settled";
  snoozed_until: string | null;
  explicit_unsettle: boolean;
  section: "inbox" | "working" | "held" | "done" | "snoozed" | "settled";
  base_version: string;
}>;
export type InboxItem = BaseItem &
  Readonly<{
    waiting_version?: number;
    engine_marks?: true;
    waiting_on?: Waiting | null;
    completed_at: string | null;
    auto_settled: boolean;
    context_label: string | null;
    due_on: string | null;
    open_url: string | null;
    kind_label: "Task" | "Call follow-up" | "Call" | "Reply draft" | "Update" | "Fact review" | "Tour feedback";
    merged_source_ids: string[];
    review_reference?: ReviewReference | null;
  }> &
  (
    | Readonly<{
        source_type: "next_action" | "capture_post_call_action";
        action_id: string;
        action_version: number;
        deal_id: string | null;
      }>
    | Readonly<{
        source_type: "capture_session" | "email_proposal" | "notification" | "fact_review" | "tour_feedback";
        action_id: null;
        action_version: number | null;
        deal_id: string | null;
      }>
  );
export type Snapshot = Readonly<{
  ok: true;
  truncated: boolean;
  limit: 1000;
  items: InboxItem[];
  engine_marks?: true;
  working_collapsed: true;
}> &
  (
    | Readonly<{ schema_version: "home-inbox.v2"; auto_settle_enabled: false }>
    | Readonly<{ schema_version: "home-inbox.v3" | "home-inbox.v4" | "home-inbox.v5"; auto_settle_enabled: true }>
  );
export type Action = "snooze" | "settle" | "unsettle";
type CommandArgs = Readonly<{
  idempotency_key: string;
  items: ReadonlyArray<Pick<InboxItem, "item_id" | "base_version">>;
}>;
type DispositionCommand = { engine_marks?: true } & (
  | Readonly<{ action: "snooze"; args: CommandArgs & Readonly<{ until: string }> }>
  | Readonly<{ action: "settle" | "unsettle"; args: CommandArgs }>
);

export type TaskReceipt = LegacyReceipt | { engine: true; action_id: string; version: number; status: "done" };

type TaskCommand = Readonly<{
  action: "complete" | "reopen";
  engine_marks?: true;
  args: CommandArgs & { action_id: string; base_version: number; completion_event_id?: string };
}>;
export type Command = DispositionCommand | TaskCommand;
export function taskCommand(action: "complete" | "reopen", item: InboxItem, receipt?: TaskReceipt): TaskCommand {
  if (
    !item.action_id ||
    item.action_version === null ||
    (action === "complete" && item.source_state !== "needs_attention")
  )
    throw Error("This card cannot be marked done.");
  if (
    action === "reopen" &&
    (!receipt ||
      receipt.action_id !== item.action_id ||
      receipt.status !== "done" ||
      (item.engine_marks
        ? !("engine" in receipt)
        : !("completion_event_id" in receipt) || !receipt.completion_event_id))
  )
    throw Error("Can't undo this completion. Its original receipt has no completion event.");
  return {
    action,
    ...(item.engine_marks && { engine_marks: true }),
    args: {
      idempotency_key: crypto.randomUUID(),
      items: [{ item_id: item.item_id, base_version: item.base_version }],
      action_id: item.action_id,
      base_version: action === "reopen" && receipt ? receipt.version : item.action_version,
      ...(action === "reopen" && receipt && "completion_event_id" in receipt
        ? { completion_event_id: receipt.completion_event_id }
        : {}),
    },
  };
}

export type ItemResult = { snapshot?: Snapshot } & (
  | { item_id: string; ok: true; item: InboxItem; receipt?: TaskReceipt; undo?: MarkUndo }
  | { item_id: string; ok: false; error: string; current_version?: string; current_item?: InboxItem }
);
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
function parseWaiting(value: unknown, version: number): Waiting | null {
  if (value === null) return null;
  if (
    !object(value) ||
    !object(value.identity) ||
    !["party", "actor"].includes(String(value.identity.kind)) ||
    !uuid(value.identity.id) ||
    typeof value.identity.available !== "boolean" ||
    (value.identity.available ? !text(value.identity.display_name) : value.identity.display_name !== null) ||
    !text(value.reason) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length ||
    value.evidence.length > 20 ||
    !value.evidence.every(text) ||
    value.version !== version
  )
    throw Error("Waiting identity unavailable. Refresh to try again.");
  // The checks above validate every Waiting field, including its identity discriminant.
  return value as Waiting;
}
function parseBaseItem(value: unknown): BaseItem {
  if (
    !object(value) ||
    !["item_id", "source_type", "source_id", "source_version", "title", "section", "base_version"].every((key) =>
      text(value[key]),
    ) ||
    !(
      typeof value.source_state === "string" &&
      ["working", "needs_attention", "done", "failed"].includes(value.source_state)
    ) ||
    !(typeof value.disposition === "string" && ["inbox", "snoozed", "settled"].includes(value.disposition)) ||
    !(
      typeof value.section === "string" &&
      ["inbox", "working", "held", "done", "snoozed", "settled"].includes(value.section)
    ) ||
    !timestamp(value.activity_at) ||
    !(value.hold_until === null || timestamp(value.hold_until)) ||
    !(value.snoozed_until === null || timestamp(value.snoozed_until)) ||
    typeof value.unseen !== "boolean" ||
    typeof value.explicit_unsettle !== "boolean"
  )
    throw Error("Inbox returned an unreadable item. Refresh to try again.");
  // The checks above validate all base fields and their allowed string values.
  return value as BaseItem;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const day = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function parseItem(value: unknown, v3 = false, v4 = false, engineMarks = false): InboxItem {
  const legacy = parseBaseItem(value);
  if (
    !object(value) ||
    !(value.context_label === null || text(value.context_label)) ||
    !(value.due_on === null || day(value.due_on)) ||
    !(value.open_url === null || text(value.open_url)) ||
    !(
      typeof value.kind_label === "string" &&
      [
        "Task",
        "Call follow-up",
        "Call",
        "Reply draft",
        "Update",
        ...(v3 ? ["Fact review", "Tour feedback"] : []),
      ].includes(value.kind_label)
    ) ||
    !Array.isArray(value.merged_source_ids) ||
    !value.merged_source_ids.every(uuid) ||
    !(value.deal_id === null || uuid(value.deal_id)) ||
    (["capture_session", "email_proposal"].includes(legacy.source_type) && value.deal_id !== null)
  )
    throw Error("Inbox returned unreadable card context. Refresh to try again.");
  const task = legacy.source_type === "next_action" || legacy.source_type === "capture_post_call_action";
  if (
    task
      ? !uuid(value.action_id) ||
        typeof value.action_version !== "number" ||
        !Number.isInteger(value.action_version) ||
        (engineMarks ? value.action_version < 0 : value.action_version < 1 || value.action_version > 2147483647)
      : ![
          "capture_session",
          "email_proposal",
          "notification",
          ...(v3 ? ["fact_review", "tour_feedback"] : []),
        ].includes(legacy.source_type) ||
        value.action_id !== null ||
        !(
          value.action_version === null ||
          (engineMarks &&
            object(value.completion_review) &&
            typeof value.action_version === "number" &&
            Number.isInteger(value.action_version) &&
            value.action_version >= 0)
        )
  )
    throw Error("Inbox returned unreadable completion identity. Refresh to try again.");
  if (
    v3 &&
    (typeof value.auto_settled !== "boolean" ||
      (value.auto_settled &&
        (legacy.section !== "settled" ||
          legacy.disposition !== "settled" ||
          legacy.source_state !== "done" ||
          legacy.explicit_unsettle ||
          !["next_action", "capture_post_call_action", "email_proposal", "fact_review", "tour_feedback"].includes(
            legacy.source_type,
          ))))
  )
    throw Error("Inbox returned unreadable settlement context. Refresh to try again.");
  if (
    (v4 &&
      !(
        value.completed_at === null ||
        (typeof value.completed_at === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.completed_at) &&
          timestamp(value.completed_at) &&
          new Date(value.completed_at).toISOString().slice(0, 19) === value.completed_at.slice(0, 19))
      )) ||
    (v4 && legacy.source_state !== "done" && value.completed_at !== null)
  )
    throw Error("Inbox returned unreadable completion time. Refresh to try again.");
  const reference = v3 ? parseReference(value.review_reference) : null;
  // Version-specific checks above validate the item before normalized optional fields are added.
  return {
    ...value,
    ...(engineMarks && { engine_marks: true }),
    ...(value.review_reference === undefined
      ? {}
      : {
          review_reference:
            reference && reference.item_id === legacy.item_id && reference.source_version === legacy.source_version
              ? reference
              : null,
        }),
    completed_at: v4 ? value.completed_at : null,
    auto_settled: v3 ? value.auto_settled : false,
  } as InboxItem;
}
const inboxVersions = [
  { version: "v5", schema: "home-inbox.v5", settlement: true, completion: true, waiting: true },
  { version: "v4", schema: "home-inbox.v4", settlement: true, completion: true, waiting: false },
  { version: "v3", schema: "home-inbox.v3", settlement: true, completion: false, waiting: false },
  { version: "v2", schema: "home-inbox.v2", settlement: false, completion: false, waiting: false },
] as const;
export function parseSnapshot(value: unknown): Snapshot {
  const contract = object(value) ? inboxVersions.find((entry) => entry.schema === value.schema_version) : undefined;
  if (
    !contract ||
    !object(value) ||
    value.ok !== true ||
    !Array.isArray(value.items) ||
    value.items.length > 1000 ||
    typeof value.truncated !== "boolean" ||
    value.limit !== 1000 ||
    value.working_collapsed !== true ||
    value.auto_settle_enabled !== contract.settlement
  )
    throw Error("Inbox unavailable. The server could not provide the complete inbox.");
  const items = value.items.map((item) => {
    const parsed = parseItem(item, contract.settlement, contract.completion, value.engine_marks === true);
    if (!contract.waiting) {
      const { waiting_version, waiting_on, ...legacy } = parsed;
      return legacy;
    }
    if (
      !object(item) ||
      typeof item.waiting_version !== "number" ||
      !Number.isSafeInteger(item.waiting_version) ||
      item.waiting_version < 0
    )
      throw Error("Waiting version unavailable.");
    return {
      ...parsed,
      waiting_version: item.waiting_version,
      waiting_on: parseWaiting(item.waiting_on, item.waiting_version),
    };
  });
  if (new Set(items.map((item) => item.item_id)).size !== items.length)
    throw Error("Inbox returned duplicate items. Refresh to try again.");
  const shared = {
    ok: true,
    truncated: value.truncated,
    limit: 1000,
    items,
    ...(value.engine_marks === true && { engine_marks: true as const }),
    working_collapsed: true,
  } as const;
  return contract.settlement
    ? { ...shared, schema_version: contract.schema, auto_settle_enabled: true }
    : { ...shared, schema_version: "home-inbox.v2", auto_settle_enabled: false };
}
export function shelves(items: readonly InboxItem[], currentId?: string) {
  const result: {
    inbox: InboxItem[];
    working: InboxItem[];
    held: InboxItem[];
    done: InboxItem[];
    snoozed: InboxItem[];
    settled: InboxItem[];
    current: InboxItem | undefined;
  } = { inbox: [], working: [], held: [], done: [], snoozed: [], settled: [], current: undefined };
  for (const item of [...items].sort(
    (a, b) => Date.parse(b.activity_at) - Date.parse(a.activity_at) || a.item_id.localeCompare(b.item_id),
  )) {
    if (item.item_id === currentId) result.current = item;
    result[item.section].push(item);
  }
  return result;
}
export function command(action: Action, items: readonly InboxItem[], until?: string): Command {
  if (!items.length || items.length > 100 || new Set(items.map((item) => item.item_id)).size !== items.length)
    throw Error("Select between 1 and 100 distinct cards.");
  if (action === "snooze" && (!until || Date.parse(until) <= Date.now() || !timestamp(until)))
    throw Error("Choose a future snooze time.");
  const args = {
    idempotency_key: crypto.randomUUID(),
    items: items.map(({ item_id, base_version }) => ({ item_id, base_version })),
  };
  const engine = items.some((item) => item.engine_marks) ? { engine_marks: true as const } : {};
  if (action === "snooze") {
    if (!until) throw Error("Choose a future snooze time.");
    return { ...engine, action, args: { ...args, until } };
  }
  return { ...engine, action, args };
}
export function parseResults(
  value: unknown,
  request: Command,
): Array<{ item_id: string; ok: true; item: BaseItem } | Extract<ItemResult, { ok: false }>> {
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "home-inbox-command.v1" ||
    !Array.isArray(value.results)
  )
    throw Error("Result uncertain. Retry the same request.");
  const rows = value.results;
  if (rows.some((row) => !object(row) || !request.args.items.some((item) => item.item_id === row.item_id)))
    throw Error("Result uncertain. Unexpected items in command response.");
  return request.args.items.map(({ item_id }) => {
    const matches = rows.filter((row: unknown) => object(row) && row.item_id === item_id);
    const row: unknown = matches.length === 1 ? matches[0] : null;
    if (object(row) && row.ok === true) {
      try {
        const item = parseBaseItem(row.item);
        if (item.item_id === item_id) return { item_id, ok: true, item };
      } catch {
        /* Preserve an unconfirmed item. */
      }
    }
    return {
      item_id,
      ok: false,
      error: object(row) && text(row.error) ? row.error : "Result uncertain. Retry the same request.",
      ...(object(row) && text(row.current_version) ? { current_version: row.current_version } : {}),
    };
  });
}
type IncomingEmail = Readonly<{
  sender: string | null;
  subject: string | null;
  excerpt: string;
  occurredAt: string | null;
}>;
type Review = ReturnType<typeof parseReview>;
export type ReviewRequest =
  | LegacyReviewRequest
  | {
      verb: "decide-engine-home-proposal";
      args: Record<string, unknown> & { idempotency_key: string };
    };
export type CardReview =
  | Exclude<Review, { kind: "reply_draft" }>
  | { kind: "suggestions"; operations: []; proposals: Suggestion[] }
  | (Extract<Review, { kind: "reply_draft" }> & {
      email: IncomingEmail | null;
      proposals?: Suggestion[];
      addresses?: { to: string | null; cc: string | null };
      attachments?: { id: string; name: string }[];
      statusMessage?: string | null;
    });

function incomingEmail(value: unknown): IncomingEmail | null {
  const source = object(value) && object(value.detail) ? value.detail.source : null;
  if (!object(source) || !text(source.evidence_quote)) return null;
  return {
    sender: text(source.sender) ? source.sender : null,
    subject: text(source.subject) ? source.subject : null,
    excerpt: source.evidence_quote,
    occurredAt: timestamp(source.occurred_at) && text(source.occurred_at) ? source.occurred_at : null,
  };
}

export type InboxClient = {
  review?: {
    current(item: InboxItem): Promise<InboxItem>;
    load(item: InboxItem, signal?: AbortSignal): Promise<CardReview>;
    run(
      item: InboxItem,
      request: ReviewRequest,
    ): Promise<{ item: InboxItem | null; receipt?: TaskReceipt; saved_version?: number; snapshot?: Snapshot }>;
  };
  read(signal?: AbortSignal): Promise<Snapshot>;
  run(request: Command): Promise<ItemResult[]>;
  batch(request: BatchRequest, expected: readonly string[]): Promise<BatchResult>;
};
export function createInboxClient(
  rpc: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>,
): InboxClient {
  async function saveMark(args: ReturnType<typeof markArgs>): Promise<MarkUndo> {
    const value = await rpc("save-engine-home-mark", args);
    if (object(value) && typeof value.error === "string") throw Object.assign(Error(value.error), { payload: value });
    const previous = object(value) ? value.previous : null;
    if (
      !object(value) ||
      value.ok !== true ||
      value.item_id !== args.item_id ||
      !text(value.base_version) ||
      !object(previous) ||
      (previous.disposition !== null && previous.disposition !== "settled" && previous.disposition !== "snoozed") ||
      (previous.snoozed_until !== null && (!text(previous.snoozed_until) || !timestamp(previous.snoozed_until)))
    )
      throw Error("Home change could not be confirmed. Retry the same request.");
    return {
      item_id: args.item_id,
      base_version: value.base_version,
      disposition: previous.disposition,
      snoozed_until: previous.snoozed_until,
    };
  }
  async function read(signal?: AbortSignal): Promise<Snapshot> {
    // eslint-disable-next-line no-restricted-syntax -- At most four version reads; only unknown_tool advances to the next version.
    for (const { version } of inboxVersions) {
      let value: unknown;
      try {
        value = await rpc(`read-home-inbox-${version}`, {}, signal);
      } catch (error) {
        if (!object(error) || !object(error.payload) || error.payload.error !== "unknown_tool") throw error;
        value = { error: "unknown_tool" };
      }
      if (object(value) && value.error === "unknown_tool") continue;
      if (!object(value) || value.schema_version !== `home-inbox.${version}`)
        throw Error("Inbox unavailable. The server inbox could not be verified.");
      return parseSnapshot(value);
    }
    throw Error("Inbox unavailable. No supported inbox could be verified.");
  }
  return {
    read,
    review: {
      async current(item) {
        const current = (await read()).items.find((row) => row.item_id === item.item_id);
        if (!current)
          throw Object.assign(Error("Card no longer available."), { payload: { error: "home_review_not_found" } });
        return current;
      },
      async load(item, signal) {
        if (hasEngineReview(item)) return loadEngineReview(rpc, item, signal);
        if (!item.review_reference) throw Error("This card has no inline review.");
        const value = await rpc(
          "read-home-review",
          { item_id: item.item_id, source_version: item.source_version },
          signal,
        );
        if (object(value) && typeof value.error === "string")
          throw Object.assign(Error(value.error), { payload: value });
        const detail = parseReview(value, item.review_reference);
        if (
          detail.operations.some((op) =>
            op.verb === "complete-one-action"
              ? op.args.action_id !== item.action_id
              : op.verb === "resolve-fact-review"
                ? JSON.stringify([op.args.entity_ref, op.args.fact_key]) !== item.source_id
                : op.args.proposal_id !== item.source_id,
          )
        )
          throw Error("Review source does not match this card.");
        return detail.kind === "reply_draft" ? { ...detail, email: incomingEmail(value) } : detail;
      },
      async run(item, request) {
        if (navigator.onLine === false) throw Error("Offline. Nothing was sent.");
        if (hasEngineReview(item)) {
          const version = await saveEngineReview(rpc, item, request);
          const snapshot = await read();
          return {
            item: snapshot.items.find((row) => row.item_id === item.item_id) ?? null,
            snapshot,
            ...(version === undefined ? {} : { saved_version: version }),
          };
        }
        const value = await rpc(request.verb, request.args);
        if (object(value) && typeof value.error === "string")
          throw Object.assign(Error(value.error), { payload: value });
        if (!object(value) || value.ok !== true) throw Error("Receipt unavailable.");
        let receipt: TaskReceipt | undefined;
        if (request.verb === "complete-one-action") {
          if (typeof request.args.action_id !== "string" || typeof request.args.base_version !== "number")
            throw Error("Task identity unavailable.");
          receipt = parseActionReceipt(
            value,
            {
              action_id: request.args.action_id,
              base_version: request.args.base_version,
              idempotency_key: request.args.idempotency_key,
            },
            "done",
          );
        } else if (request.verb === "resolve-fact-review") {
          if (
            value.schema_version !== "fact-review.v1" ||
            !object(value.review_receipt) ||
            value.review_receipt.entity_ref !== request.args.entity_ref ||
            value.review_receipt.fact_key !== request.args.fact_key
          )
            throw Error("Review receipt unavailable.");
        } else if (
          value.proposal_id !== item.source_id ||
          !Number.isSafeInteger(value.version) ||
          typeof value.version !== "number" ||
          typeof request.args.base_version !== "number" ||
          value.version <= request.args.base_version
        )
          throw Error("Draft receipt unavailable.");
        const current = (await read()).items.find((row) => row.item_id === item.item_id);
        if (!current) throw Error("Receipt received, but exact card readback is unavailable.");
        return {
          item: current,
          ...(request.verb === "edit-email-draft" && typeof value.version === "number"
            ? { saved_version: value.version }
            : {}),
          ...(receipt &&
          current.action_id === receipt.action_id &&
          current.action_version === receipt.version &&
          current.source_state === "done"
            ? { receipt }
            : {}),
        };
      },
    },
    async batch(request, expected) {
      if (navigator.onLine === false) throw Error("Offline. No change was sent. Reconnect and retry manually.");
      let receipt: Omit<BatchResult, "snapshot">;
      if (request.engine_marks) {
        const { args } = request;
        const change = { action: request.action, ...("until" in args && { until: args.until }) };
        const attempts =
          "undo_of" in args ? (request.restore ?? []) : args.items.map((target) => ({ ...target, ...change }));
        const outcomes = await Promise.allSettled(
          attempts.map(async (target, index) => {
            const item_id = target.item_id;
            if (!markTarget(item_id)) return { item_id, status: "not_allowed" as const };
            try {
              const undo = await saveMark(markArgs(target, target, args.idempotency_key, index));
              return { item_id, status: "applied" as const, undo };
            } catch (error) {
              const code = object(error) && object(error.payload) ? error.payload.error : null;
              if (code === "home_item_not_found") return { item_id, status: "not_found" as const };
              if (code === "version_conflict" || code === "invalid_snooze_time" || code === "home_routing_changed")
                return { item_id, status: "not_allowed" as const, error: code };
              throw error;
            }
          }),
        );
        const results = outcomes.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });
        receipt = { batch_key: "undo_of" in args ? args.undo_of : args.idempotency_key, results };
      } else {
        receipt = parseBatch(await rpc(`${request.action}-home-inbox`, request.args), request, expected);
      }
      let snapshot: Snapshot | null = null;
      try {
        snapshot = await read();
      } catch {
        /* Receipts remain confirmed even when readback fails. */
      }
      return { ...receipt, snapshot };
    },
    async run(request) {
      if (navigator.onLine === false) throw Error("Offline. No change was sent. Reconnect and retry manually.");
      if (request.action === "complete" || request.action === "reopen") {
        const { items, ...args } = request.args;
        if (request.engine_marks) {
          const { action_id: id, base_version, idempotency_key } = args;
          const done = request.action === "complete";
          const value = await rpc(done ? "end-engine-home-step" : "reopen-engine-home-step", {
            id,
            base_version,
            idempotency_key,
            ...(done && { resolution: "done" }),
          });
          if (object(value) && typeof value.error === "string")
            throw Object.assign(Error(value.error), { payload: value });
          if (
            !object(value) ||
            value.next_step_id !== id ||
            value.status !== (done ? "done" : "open") ||
            (done &&
              (typeof value.change_id !== "number" ||
                !Number.isSafeInteger(value.change_id) ||
                value.change_id <= base_version))
          )
            throw Error("Task change could not be confirmed. Retry the same request.");
          const snapshot = await read();
          const item_id = items[0]?.item_id ?? "";
          const item = snapshot.items.find((row) => row.item_id === item_id);
          if (
            !item ||
            (done
              ? item.source_state !== "done" || item.action_version !== value.change_id
              : item.source_state !== "needs_attention")
          )
            return [{ item_id, ok: false, error: "intervening_change", ...(item && { current_item: item }), snapshot }];
          const receipt =
            done && typeof value.change_id === "number"
              ? { engine: true as const, action_id: id, version: value.change_id, status: "done" as const }
              : undefined;
          return [{ item_id, ok: true, item, ...(receipt && { receipt }), snapshot }];
        }
        const receipt =
          request.action === "complete"
            ? await completeAction({ completeOneAction: (args) => rpc("complete-one-action", args) }, args)
            : parseActionReceipt(await rpc("reopen-one-action", args), args, "open");
        const snapshot = await read();
        const expectedItem = items[0]?.item_id;
        const item = snapshot.items.find(
          (item) => item.item_id === expectedItem && item.action_id === receipt.action_id,
        );
        if (!item) throw Error("Task receipt confirmed, but readback is unavailable. Retry the same request.");
        const item_id = item.item_id;
        if (
          item.action_version !== receipt.version ||
          item.source_state !== (receipt.status === "done" ? "done" : "needs_attention")
        )
          return [{ item_id, ok: false, error: "intervening_change", current_item: item }];
        return [{ item_id, ok: true, item, receipt }];
      }
      if ("engine_marks" in request && request.engine_marks) {
        const { args } = request;
        const change = { action: request.action, ...("until" in args && { until: args.until }) };
        const marks = await Promise.all(
          args.items.map(async (target, index) =>
            markTarget(target.item_id) ? saveMark(markArgs(target, change, args.idempotency_key, index)) : null,
          ),
        );
        const snapshot = await read();
        return request.args.items.map(({ item_id }, index) => {
          const undo = marks[index];
          if (!undo) return { item_id, ok: false, error: "home_item_not_found", snapshot };
          const item = snapshot.items.find((item) => item.item_id === item_id);
          if (!item) return { item_id, ok: false, error: "home_item_not_found", snapshot };
          return item.base_version === undo.base_version
            ? { item_id, ok: true, item, undo, snapshot }
            : { item_id, ok: false, error: "intervening_change", current_item: item, snapshot };
        });
      }
      const results = parseResults(await rpc(`${request.action}-home-inbox`, request.args), request);
      if (!results.some((result) => result.ok)) return results.flatMap((result) => (result.ok ? [] : [result]));
      const snapshot = await read();
      return results.map((result) => {
        if (!result.ok) return result;
        const item = snapshot.items.find((item) => item.item_id === result.item_id);
        if (!item)
          return {
            item_id: result.item_id,
            ok: false,
            error: "Confirmed change, but card readback is unavailable. Refresh to check its state.",
          };
        if (item.base_version !== result.item.base_version)
          return { item_id: result.item_id, ok: false, error: "intervening_change", current_item: item };
        return { item_id: result.item_id, ok: true, item: { ...item, base_version: result.item.base_version } };
      });
    },
  };
}
