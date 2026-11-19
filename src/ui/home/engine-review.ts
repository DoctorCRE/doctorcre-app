import { type CardReview, type InboxItem, object, type ReviewRequest } from "./inbox.tsx";

type Rpc = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
const string = (value: unknown) => (typeof value === "string" ? value : null);
const unreadable = () => Error("Could not verify this review. Close and reopen the card.");
const kinds = new Map([
  ["next_step", "Next step"],
  ["next_step_done", "Step that may be done"],
  ["log_call", "Log a call"],
  ["phase_move", "Deal progress"],
  ["file_to_deal", "File this email"],
  ["possible_new_deal", "Possible new deal"],
  ["lead_stage_move", "Lead progress"],
  ["new_lead", "New lead"],
]);
const mayApproveFailedDraft = (failure: string | null) => failure === "aborted_before_dispatch";
function draftStatus(status: unknown, failure: string | null) {
  if (status === "approved") return "Sending";
  if (status === "sent") return "Sent";
  if (status !== "failed") return null;
  if (failure?.startsWith("unconfirmed_after_")) return "Checking the Sent folder";
  if (failure === "submission_recipients_invalid")
    return "Didn't send. The saved recipients couldn't be used. Reply from Outlook.";
  return mayApproveFailedDraft(failure)
    ? "Didn't send. Sending stopped before delivery."
    : "Didn't send. Reply from Outlook.";
}
export function draftCardStatus(item: InboxItem) {
  if (!item.engine_marks || item.source_state === "done") return null;
  const draft = draftReference(item);
  return draft ? draftStatus(draft.status, draft.failureReason) : null;
}

export function proposalIds(item: InboxItem) {
  const review = "completion_review" in item ? item.completion_review : null;
  if (object(review) && typeof review.proposal_id === "string") return [review.proposal_id];
  const suggestions = "suggestions" in item ? item.suggestions : null;
  return Array.isArray(suggestions)
    ? suggestions.flatMap((row: unknown) => (object(row) && typeof row.id === "string" ? [row.id] : []))
    : [];
}
export function matchesProposal(item: InboxItem, id: string) {
  return proposalIds(item).includes(id);
}

export function draftReference(item: InboxItem) {
  const id = "reply_draft_id" in item ? string(item.reply_draft_id) : null;
  if (id)
    return {
      id,
      version: item.source_version,
      status: "reply_draft_status" in item ? string(item.reply_draft_status) : null,
      failureReason: "failure_reason" in item ? string(item.failure_reason) : null,
    };
  const fallback = "fallback_reply_draft" in item ? item.fallback_reply_draft : null;
  if (
    object(fallback) &&
    typeof fallback.id === "string" &&
    typeof fallback.version === "string" &&
    (fallback.status === "approved" || fallback.status === "failed")
  )
    return {
      id: fallback.id,
      version: fallback.version,
      status: fallback.status,
      failureReason: string(fallback.failure_reason),
    };
  return null;
}
export const hasEngineReview = (item: InboxItem) =>
  Boolean(item.engine_marks && (draftReference(item) || proposalIds(item).length));

function source(value: unknown) {
  if (!object(value)) return null;
  const happened = string(value.happened_at);
  const sender = string(value.sender_name) || string(value.sender) || string(value.contact);
  const from =
    value.kind === "call"
      ? `From your call${sender ? ` with ${sender}` : ""}`
      : value.kind === "meeting"
        ? "From this meeting"
        : value.kind === "email"
          ? sender
            ? `From ${sender}`
            : "From this email"
          : "From this note";
  return {
    sender,
    from,
    subject: string(value.subject),
    excerpt: string(value.body) || string(value.summary) || "",
    occurredAt: happened && Number.isFinite(Date.parse(happened)) ? happened : null,
  };
}

async function answer(rpc: Rpc, name: string, args: unknown, signal?: AbortSignal) {
  const value = await rpc(name, args, signal).catch((error: unknown) => {
    if (object(error) && object(error.payload)) return error.payload;
    throw error;
  });
  if (object(value) && (typeof value.error === "string" || typeof value.http_status === "number")) {
    const error = string(value.error) ?? "suggestion_refused";
    const resolved = ["draft_changed", "already_decided", "not_found"].includes(error);
    const code = resolved ? "home_review_resolved" : error === "not_mailbox_owner" ? "email_draft_not_owner" : error;
    throw Object.assign(Error(code), { payload: { ...value, error: code } });
  }
  if (!object(value)) throw unreadable();
  return value;
}
export const openStepRefusal =
  "You already have an open step for this client or deal. Finish or change that step first.";

export function proposalRefusal(error: unknown) {
  const payload = object(error) && object(error.payload) ? error.payload : null;
  const status = payload?.http_status;
  if (payload?.error === "home_routing_changed") return "Home changed. Refresh the inbox and try again.";
  if (!payload || typeof status !== "number" || status < 400 || status >= 500) return null;
  switch (payload.error) {
    case "open_step_exists":
      return `${openStepRefusal} Or dismiss this suggestion.`;
    case "version_conflict":
      return "current_stage" in payload
        ? "This lead has moved since the suggestion. Dismiss it, or open the lead."
        : "This deal has moved since the suggestion. Dismiss it, or open the deal.";
    case "home_review_resolved":
      return "This suggestion is already gone. Refresh the inbox to see what remains.";
    default:
      return status === 401 || status === 403
        ? "Sign in as the partner who can decide this suggestion."
        : "This suggestion could not be saved. Review the linked record or dismiss the suggestion.";
  }
}
export type Suggestion = {
  id: string;
  label: string;
  target: string | null;
  evidence: string;
  source: ReturnType<typeof source>;
  what: string | null;
  dueOn: string | null;
  editable: boolean;
  completion: boolean;
  canAccept: boolean;
};

export async function loadEngineReview(rpc: Rpc, item: InboxItem, signal?: AbortSignal): Promise<CardReview> {
  const draft = draftReference(item);
  const ids = proposalIds(item);
  if (!draft && !ids.length) throw unreadable();
  const pending = Promise.all(
    ids.map(async (id) => {
      const value = await answer(rpc, "read-engine-home-proposal", { id }, signal);
      const label = kinds.get(string(value.kind) ?? "");
      if (value.proposal_id !== id || typeof value.evidence !== "string" || !label) throw unreadable();
      const change = string(value.to_phase) || string(value.to_stage);
      const review = "completion_review" in item && object(item.completion_review) ? item.completion_review : null;
      return {
        id,
        label,
        target: string(value.target_name),
        evidence: value.evidence,
        source: source(value.source_activity),
        what: string(value.what) || change?.replaceAll("_", " ") || null,
        dueOn: string(value.due_on),
        editable: value.kind === "next_step",
        completion: value.kind === "next_step_done",
        canAccept: review?.can_resolve !== false,
      };
    }),
  );
  if (draft) {
    const [reply, proposals] = await Promise.all([loadDraft(rpc, item, draft, signal), pending]);
    return { ...reply, proposals };
  }
  return { kind: "suggestions", operations: [], proposals: await pending };
}

async function loadDraft(
  rpc: Rpc,
  item: InboxItem,
  draft: { id: string; version: string },
  signal?: AbortSignal,
): Promise<Extract<CardReview, { kind: "reply_draft" }>> {
  const { id } = draft;
  const value = await answer(rpc, "read-engine-home-draft", { id }, signal);
  const { subject, body, version, status, to, cc } = value;
  if (
    value.draft_id !== id ||
    typeof subject !== "string" ||
    typeof body !== "string" ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    typeof status !== "string" ||
    !Array.isArray(value.attachments)
  )
    throw unreadable();
  if (String(version) !== draft.version)
    throw Object.assign(Error("Draft changed."), { payload: { error: "version_conflict" } });
  const attachments = value.attachments.map((row: unknown) => {
    if (!object(row) || typeof row.document_id !== "string" || typeof row.name !== "string") throw unreadable();
    return { id: row.document_id, name: row.name };
  });
  const args = { proposal_id: id, base_version: version };
  const recipients = typeof to === "string" && to && typeof cc === "string" && cc ? { to: [to], cc: [cc] } : null;
  const failure = string(value.failure_reason);
  const operations: Extract<CardReview, { kind: "reply_draft" }>["operations"] =
    status === "pending"
      ? [
          { verb: "edit-email-draft", args },
          { verb: "dismiss-email-proposal", args },
        ]
      : [];
  if (recipients && (status === "pending" || (status === "failed" && mayApproveFailedDraft(failure))))
    operations.push({
      verb: "submit-email-draft",
      args: { ...args, subject, body, ...recipients },
    });
  const statusMessage = draftStatus(status, failure);
  return {
    kind: "reply_draft",
    reference: {
      kind: "reply_draft",
      item_id: item.item_id,
      source_version: item.source_version,
      operations: operations.map((op) => op.verb),
    },
    subject,
    body,
    recipients,
    operations,
    sendUnavailableReason: statusMessage || "A reply needs the sender and the other partner’s work email.",
    email: source(value.source_activity),
    attachments,
    addresses: { to: string(to), cc: string(cc) },
    statusMessage,
  };
}

export async function saveEngineReview(rpc: Rpc, item: InboxItem, request: ReviewRequest) {
  const { args, verb } = request;
  if (verb === "decide-engine-home-proposal") {
    if (typeof args.id !== "string" || !matchesProposal(item, args.id)) throw unreadable();
    const result = await answer(rpc, verb, args);
    if (result.proposal_id !== args.id || result.status !== (args.decision === "accept" ? "accepted" : "dismissed"))
      throw unreadable();
    return undefined;
  }
  const draft = draftReference(item);
  if (
    !draft ||
    draft.id !== args.proposal_id ||
    typeof args.base_version !== "number" ||
    String(args.base_version) !== draft.version
  )
    throw unreadable();
  const { id } = draft;
  const { idempotency_key, base_version: version, subject, body, reason, document_ids } = args;
  const base = { id, idempotency_key, version };
  const result =
    verb === "edit-email-draft"
      ? await answer(rpc, "edit-engine-home-draft", { ...base, subject, body })
      : verb === "dismiss-email-proposal"
        ? await answer(rpc, "dismiss-engine-home-draft", { ...base, reason })
        : verb === "submit-email-draft" && Array.isArray(args.to) && Array.isArray(args.cc)
          ? await answer(rpc, "submit-engine-home-draft", {
              ...base,
              to: args.to[0],
              cc: args.cc[0],
              subject,
              body,
              document_ids,
            })
          : null;
  const expected =
    verb === "edit-email-draft" ? "pending" : verb === "dismiss-email-proposal" ? "dismissed" : "approved";
  if (
    !result ||
    result.draft_id !== id ||
    result.status !== expected ||
    typeof result.version !== "number" ||
    !Number.isSafeInteger(result.version) ||
    result.version <= version
  )
    throw unreadable();
  return result.version;
}
