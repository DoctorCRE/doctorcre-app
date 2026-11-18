import type { Action, InboxItem } from "./inbox.tsx";

type Target = Pick<InboxItem, "item_id" | "base_version">;
export type MarkSelection = { action: Action; until?: string };
export type MarkUndo = Target & { disposition: "settled" | "snoozed" | null; snoozed_until: string | null };
export const markTarget = (item_id: string) => /^(next_action|capture_post_call_action|notification):/.test(item_id);
export function restoreMark(previous: MarkUndo): MarkSelection {
  if (previous.disposition === "settled") return { action: "settle" };
  if (previous.disposition === "snoozed" && previous.snoozed_until && Date.parse(previous.snoozed_until) > Date.now())
    return { action: "snooze", until: previous.snoozed_until };
  return { action: "unsettle" };
}

export function markArgs(target: Target, selection: MarkSelection, key: string, index: number) {
  return {
    item_id: target.item_id,
    base_version: target.base_version,
    idempotency_key: cardKey(key, index),
    action: selection.action,
    ...(selection.until && { until: selection.until }),
  };
}
function cardKey(key: string, index: number): string {
  // A retry fans out the same batch key to the same distinct per-card keys.
  return key.slice(0, -4) + (Number.parseInt(key.slice(-4), 16) ^ index).toString(16).padStart(4, "0");
}
