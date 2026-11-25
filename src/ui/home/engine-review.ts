import { splitSignature } from "./email-signature.ts";
import { type CardReview, type InboxItem, object, type ReviewItem, type ReviewRequest } from "./inbox.tsx";

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
  ["email_lead", "Possible lead"],
]);
// Rule 99: only these failures never pressed Send, so the owner may approve them again.
const resendable = new Map([
  ["aborted_before_dispatch", "Didn't send. Sending stopped before delivery."],
  ["submission_recipients_invalid", "Didn't send. The recipients were refused. Correct them and send again."],
]);
// Rule 99: these may still be approved again or found sent, so they stay on Home.
const mayStillSend = (failure: string) => resendable.has(failure) || failure.startsWith("unconfirmed_after_");
function draftStatus(status: unknown, failure: string | null) {
  if (status === "approved") return "Sending";
  if (status === "sent") return "Sent";
  if (status !== "failed") return null;
  if (failure?.startsWith("unconfirmed_after_")) return "Checking the Sent folder";
  return resendable.get(failure ?? "") ?? "Didn't send. Reply from Outlook.";
}
export function draftCardStatus(item: InboxItem) {
  if (!item.engine_marks || item.source_state === "done") return null;
  const draft = draftReference(item);
  return draft ? draftStatus(draft.status, draft.failureReason) : null;
}

type ProposalReference = { id: string; emailId: string | null };

function proposalReferences(item: ReviewItem): ProposalReference[] {
  const review = "completion_review" in item ? item.completion_review : null;
  if (object(review) && typeof review.proposal_id === "string") return [{ id: review.proposal_id, emailId: null }];
  const suggestions = "suggestions" in item ? item.suggestions : null;
  return Array.isArray(suggestions)
    ? suggestions.flatMap((row: unknown) =>
        object(row) && typeof row.id === "string"
          ? [{ id: row.id, emailId: row.activity_kind === "email" ? string(row.activity_id) : null }]
          : [],
      )
    : [];
}

export function proposalIds(item: ReviewItem) {
  return proposalReferences(item).map(({ id }) => id);
}
function matchesProposal(item: ReviewItem, id: string) {
  return proposalIds(item).includes(id);
}

export function draftReference(item: ReviewItem) {
  const id = "reply_draft_id" in item ? string(item.reply_draft_id) : null;
  if (id && item.source_version)
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
export function failedForGood(item: ReviewItem) {
  const draft = draftReference(item);
  return draft?.status === "failed" && !!draft.failureReason && !mayStillSend(draft.failureReason);
}
export const hasEngineReview = (item: InboxItem) =>
  Boolean(item.engine_marks && (draftReference(item) || proposalIds(item).length));

export type EmailThread = {
  subject: string | null;
  messages: { id: string; sender: string | null; occurredAt: string; body: string; folded: string | null }[];
};

function emailThread(value: Record<string, unknown>): EmailThread {
  const messages = Array.isArray(value.thread)
    ? value.thread.flatMap((message: unknown) => {
        if (!object(message)) return [];
        const { activity_id: id, happened_at: occurredAt, body, sender_name } = message;
        if (
          typeof id !== "string" ||
          !id ||
          typeof occurredAt !== "string" ||
          !Number.isFinite(Date.parse(occurredAt)) ||
          typeof body !== "string"
        )
          return [];
        const { text, signature } = splitSignature(body, string(sender_name));
        const earlier = string(message.folded);
        return [
          {
            id,
            occurredAt,
            body: text,
            sender: string(sender_name)?.trim().split(/\s+/, 1)[0] || null,
            folded: signature === null ? earlier : [signature, earlier].filter(Boolean).join("\n\n"),
          },
        ];
      })
    : [];
  return {
    messages,
    subject: messages.length && object(value.source_activity) ? string(value.source_activity.subject) : null,
  };
}

function combineThreads(threads: EmailThread[]): EmailThread {
  const messages = new Map(threads.flatMap(({ messages }) => messages.map((message) => [message.id, message])));
  return {
    subject: threads.find(({ subject }) => subject)?.subject ?? null,
    messages: [...messages.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)),
  };
}

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
    from,
    excerpt: value.kind === "email" ? "" : string(value.body) || string(value.summary) || "",
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
    if (name === "decide-engine-home-proposal" && error === "already_decided" && value.http_status === 409)
      return value;
    const resolved = ["draft_changed", "already_decided", "not_found"].includes(error);
    const code = resolved ? "home_review_resolved" : error === "not_mailbox_owner" ? "email_draft_not_owner" : error;
    throw Object.assign(Error(code), { payload: { ...value, error: code } });
  }
  if (!object(value)) throw unreadable();
  return value;
}
export const openStepRefusal =
  "You already have an open step for this client or deal. Finish or change that step first.";

export type FilingReasonRefusal = { dealId: string; message: string };

export type DealFilingReason = { required: true; hint: string } | { required: false; hint: null };

export async function readDealFilingReason(
  rpc: Rpc,
  id: string,
  dealId: string,
  signal: AbortSignal,
): Promise<DealFilingReason> {
  const value = await answer(rpc, "read-engine-home-proposal", { id, deal_id: dealId }, signal);
  if (value.reason_required === true && typeof value.hint === "string" && value.hint.trim())
    return { required: true, hint: value.hint };
  if (value.reason_required === false && value.hint === null) return { required: false, hint: null };
  throw unreadable();
}

export function filingReasonRefusal(error: unknown, dealId: string): FilingReasonRefusal | null {
  const payload = object(error) && object(error.payload) ? error.payload : null;
  return payload?.http_status === 422 &&
    payload.error === "database_refused_the_statement" &&
    payload.rule === "proposal_filing_reason"
    ? { dealId, message: "This email isn't linked to that deal yet. Add a short reason to file it there." }
    : null;
}

export function proposalRefusal(error: unknown) {
  const payload = object(error) && object(error.payload) ? error.payload : null;
  const status = payload?.http_status;
  if (payload?.error === "home_routing_changed") return "Home changed. Refresh the inbox and try again.";
  if (!payload || typeof status !== "number" || status < 400 || status >= 500) return null;
  switch (payload.error) {
    case "open_step_exists":
      return `${openStepRefusal} Or drop this suggestion.`;
    case "version_conflict":
      return "current_stage" in payload
        ? "This lead has moved since the suggestion. Drop it, or open the lead."
        : "This deal has moved since the suggestion. Drop it, or open the deal.";
    case "home_review_resolved":
      return "This suggestion is already gone. Refresh the inbox to see what remains.";
    default:
      return status === 401 || status === 403
        ? "Sign in as the partner who can decide this suggestion."
        : "This suggestion could not be saved. Review the linked record or drop the suggestion.";
  }
}
export type FilingChoice = { kind: "deal" | "vendor"; label: string };

function filingChoices(value: unknown): FilingChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw unreadable();
  const choices = new Map<FilingChoice["kind"], FilingChoice>();
  for (const choice of value) {
    if (!object(choice) || (choice.kind !== "deal" && choice.kind !== "vendor") || typeof choice.label !== "string")
      throw unreadable();
    choices.set(choice.kind, { kind: choice.kind, label: choice.label });
  }
  return [...choices.values()];
}

export type Suggestion = {
  id: string;
  label: string;
  target: string | null;
  reason: string | null;
  emailLead: boolean;
  senderAddress: string | null;
  source: ReturnType<typeof source>;
  what: string | null;
  dueOn: string | null;
  editable: boolean;
  completion: boolean;
  canAccept: boolean;
  filingChoices: FilingChoice[] | undefined;
  filingEmailId: string | null;
};

// Header, greeting and "On … wrote:" lines say nothing about the deal.
const notAReason =
  /^(?:(?:from|to|cc|sent|date|subject):|(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.!?,]{0,40}[,!:]?$|on\b.*\bwrote:$)/i;
function firstLine(text: string) {
  const line = text
    .split("\n")
    .map((row) => row.replace(/^(?:>\s*)+/, "").trim())
    .find((row) => row && !notAReason.test(row));
  return line && line.length > 160 ? `${line.slice(0, 159)}…` : line || null;
}

function parseProposal(value: Record<string, unknown>, { id, emailId }: ProposalReference, canAccept: boolean) {
  const label = kinds.get(string(value.kind) ?? "");
  if (value.proposal_id !== id || typeof value.evidence !== "string" || !label) throw unreadable();
  const change = string(value.to_phase) || string(value.to_stage);
  const activity = object(value.source_activity) ? value.source_activity : null;
  const leadCandidate = value.kind === "email_lead" && activity?.id === null && !Array.isArray(value.thread);
  const thread =
    !leadCandidate && (Array.isArray(value.thread) || activity?.kind === "email") ? emailThread(value) : null;
  const choices = filingChoices(value.filing_choices);
  const newDeal = value.kind === "possible_new_deal";
  const proposal: Suggestion = {
    id,
    label: choices ? "File this email" : label,
    target: string(value.target_name) || (newDeal ? string(activity?.sender_name) : null),
    // Imported proposals can store raw email quotes in evidence.
    reason: thread ? string(value.reason) || (newDeal ? firstLine(value.evidence) : null) : value.evidence,
    emailLead: value.kind === "email_lead",
    senderAddress: leadCandidate ? string(activity?.sender) : null,
    source: thread ? null : source(activity),
    what: string(value.what) || change?.replaceAll("_", " ") || null,
    dueOn: string(value.due_on),
    editable: value.kind === "next_step",
    completion: value.kind === "next_step_done",
    canAccept,
    filingChoices: choices,
    filingEmailId: choices?.length ? emailId : null,
  };
  return { proposal, thread };
}

export async function loadEngineReview(rpc: Rpc, item: ReviewItem, signal?: AbortSignal): Promise<CardReview> {
  const draft = draftReference(item);
  const references = proposalReferences(item);
  if (!draft && !references.length) throw unreadable();
  const completion = "completion_review" in item && object(item.completion_review) ? item.completion_review : null;
  const [reply, details] = await Promise.all([
    draft && loadDraft(rpc, item.item_id, draft, signal),
    Promise.all(
      references.map(async (reference) =>
        parseProposal(
          await answer(rpc, "read-engine-home-proposal", { id: reference.id }, signal),
          reference,
          completion?.can_resolve !== false,
        ),
      ),
    ),
  ]);
  const threads = details.flatMap(({ thread }) => (thread ? [thread] : []));
  const proposals = details.map(({ proposal }) => proposal);
  if (reply) return { ...reply, proposals, thread: combineThreads([reply.thread, ...threads]) };
  return {
    kind: "suggestions",
    operations: [],
    proposals,
    ...(threads.length && { thread: combineThreads(threads) }),
  };
}

async function loadDraft(
  rpc: Rpc,
  itemId: string,
  draft: { id: string; version: string },
  signal?: AbortSignal,
): Promise<Extract<CardReview, { kind: "reply_draft" }> & { thread: EmailThread }> {
  const { id } = draft;
  const value = await answer(rpc, "read-engine-home-draft", { id }, signal);
  const review = parseDraft(value, itemId, id);
  if (review.reference.source_version !== draft.version)
    throw Object.assign(Error("Draft changed."), { payload: { error: "version_conflict" } });
  return review;
}

function parseDraft(
  value: Record<string, unknown>,
  itemId: string,
  id: string,
): Extract<CardReview, { kind: "reply_draft" }> & { thread: EmailThread } {
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
  const attachments = value.attachments.map((row: unknown) => {
    if (!object(row) || typeof row.document_id !== "string" || typeof row.name !== "string") throw unreadable();
    return { id: row.document_id, name: row.name };
  });
  const args = { proposal_id: id, base_version: version };
  const recipients = typeof to === "string" && to && typeof cc === "string" && cc ? { to: [to], cc: [cc] } : null;
  const failure = string(value.failure_reason);
  const correctRecipients = status === "failed" && failure === "submission_recipients_invalid";
  const operations: Extract<CardReview, { kind: "reply_draft" }>["operations"] =
    status === "pending"
      ? [
          { verb: "edit-email-draft", args },
          { verb: "dismiss-email-proposal", args },
        ]
      : [];
  if (recipients && (status === "pending" || (status === "failed" && resendable.has(failure ?? ""))))
    operations.push({
      verb: "submit-email-draft",
      args: { ...args, subject, body, ...recipients },
    });
  const statusMessage = draftStatus(status, failure);
  const thread = emailThread(value);
  const sourceId = object(value.source_activity) ? value.source_activity.id : null;
  return {
    kind: "reply_draft",
    reference: {
      kind: "reply_draft",
      item_id: itemId,
      source_version: String(version),
      operations: operations.map((op) => op.verb),
    },
    subject,
    body,
    recipients,
    operations,
    sendUnavailableReason: statusMessage || "A reply needs the sender and the other partner’s work email.",
    thread,
    replyTo: thread.messages.find(({ id }) => id === sourceId)?.sender ?? null,
    attachments,
    addresses: { to: string(to), cc: string(cc) },
    correctRecipients,
    statusMessage,
  };
}

export async function saveEngineReview(rpc: Rpc, item: ReviewItem, request: ReviewRequest) {
  const { args, verb } = request;
  if (verb === "decide-engine-home-proposal") {
    if (typeof args.id !== "string" || !matchesProposal(item, args.id)) throw unreadable();
    const result = await answer(rpc, verb, args);
    if (result.error === "already_decided") return "already_decided";
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
