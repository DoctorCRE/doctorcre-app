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
function proposalIds(item: InboxItem) {
  const review = "completion_review" in item ? item.completion_review : null;
  if (object(review) && typeof review.proposal_id === "string") return [review.proposal_id];
  const suggestions = "suggestions" in item ? item.suggestions : null;
  return Array.isArray(suggestions)
    ? suggestions.flatMap((row: unknown) => (object(row) && typeof row.id === "string" ? [row.id] : []))
    : [];
}
export const hasEngineReview = (item: InboxItem) => Boolean(item.engine_marks && proposalIds(item).length);

function source(value: unknown) {
  if (!object(value)) return null;
  const happened = string(value.happened_at);
  return {
    sender: string(value.sender_name) || string(value.sender),
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
  if (object(value) && typeof value.error === "string") {
    const resolved = ["already_decided", "not_found"].includes(value.error);
    const code = resolved ? "home_review_resolved" : value.error;
    throw Object.assign(Error(code), { payload: { ...value, error: code } });
  }
  if (!object(value)) throw unreadable();
  return value;
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
  const proposals = await Promise.all(
    proposalIds(item).map(async (id) => {
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
  return { kind: "suggestions", operations: [], proposals };
}

export async function saveEngineReview(rpc: Rpc, item: InboxItem, request: ReviewRequest) {
  const { args, verb } = request;
  if (verb !== "decide-engine-home-proposal" || typeof args.id !== "string" || !proposalIds(item).includes(args.id))
    throw unreadable();
  const result = await answer(rpc, verb, args);
  if (result.proposal_id !== args.id || result.status !== (args.decision === "accept" ? "accepted" : "dismissed"))
    throw unreadable();
}
