export declare function showToast(
  message: string,
  options?: { eventId?: string | null; onUndo?: (() => void) | null; error?: boolean; preserveUndo?: boolean },
): HTMLElement | null;
