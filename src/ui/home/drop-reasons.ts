export type DropCategory =
  | "next_step"
  | "filing"
  | "phase_move"
  | "lead"
  | "call_note"
  | "reply_draft"
  | "checklist_reminder"
  | "tour_feedback";

/** Maps every Home proposal kind, update kind, or card type to its engine drop-reasons category. */
export const DROP_CATEGORIES: Readonly<Record<string, DropCategory>> = {
  next_step: "next_step",
  next_step_done: "next_step",
  file_to_deal: "filing",
  possible_new_deal: "filing",
  phase_move: "phase_move",
  new_lead: "lead",
  email_lead: "lead",
  lead_stage_move: "lead",
  log_call: "call_note",
  reply_draft: "reply_draft",
  next_action: "next_step",
  capture_post_call_action: "next_step",
  update: "checklist_reminder",
  notification: "checklist_reminder",
  tour_feedback: "tour_feedback",
};

type DropItemShape = Readonly<{
  item_id: string;
  source_type: string;
  kind_label?: string;
  kind?: unknown;
  reply_draft_id?: unknown;
  reply_draft_status?: unknown;
  suggestions?: unknown;
  completion_review?: unknown;
}>;

const MAX_REASONS = 5;
export const EMPTY_DROP_REASONS: readonly string[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function dropCategoryForKey(key: string | null | undefined): DropCategory | null {
  return key && Object.hasOwn(DROP_CATEGORIES, key) ? (DROP_CATEGORIES[key] ?? null) : null;
}

function firstSuggestionKind(item: DropItemShape): string | null {
  if (!Array.isArray(item.suggestions) || !item.suggestions.length) return null;
  const first: unknown = item.suggestions[0];
  return isRecord(first) && typeof first.kind === "string" ? first.kind : null;
}

export function dropCategoryForItem(item: DropItemShape): DropCategory | null {
  const pendingDraft = typeof item.reply_draft_id === "string" && item.reply_draft_status === "pending";
  const candidates = [
    pendingDraft ? "reply_draft" : null,
    firstSuggestionKind(item),
    isRecord(item.completion_review) ? "next_step_done" : null,
    item.item_id.startsWith("reply_draft:") ? "reply_draft" : null,
    typeof item.kind === "string" ? item.kind : null,
    item.kind_label === "Tour feedback" ? "tour_feedback" : null,
    item.source_type,
  ];
  for (const key of candidates) {
    const category = dropCategoryForKey(key);
    if (category) return category;
  }
  return null;
}

export function parseDropReasons(value: unknown, category: DropCategory): readonly string[] {
  if (!isRecord(value) || value.category !== category || !Array.isArray(value.reasons)) return EMPTY_DROP_REASONS;
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const entry of value.reasons) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (!text) continue;
    const folded = text.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    reasons.push(text);
    if (reasons.length === MAX_REASONS) break;
  }
  return reasons;
}

/** Fetches drop reasons for one category; any read failure returns an empty list quietly. */
export async function readDropReasons(category: DropCategory): Promise<readonly string[]> {
  try {
    const { sessionFetch } = await import(new URL("./private-session.js", import.meta.url).href);
    const response: Response = await sessionFetch(
      `/api/engine/home/drop-reasons?category=${encodeURIComponent(category)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return EMPTY_DROP_REASONS;
    const payload: unknown = await response.json().catch(() => null);
    return parseDropReasons(payload, category);
  } catch {
    return EMPTY_DROP_REASONS;
  }
}
