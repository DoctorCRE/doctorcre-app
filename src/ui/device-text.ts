type TextStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localTextStorage(): TextStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredText(storage: TextStorage | null, key: string): string {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStoredText(storage: TextStorage | null, key: string, text: string, evictOnFailure: boolean): void {
  if (!storage) return;
  try {
    if (text) storage.setItem(key, text);
    else storage.removeItem(key);
  } catch {
    // The typing box still works when device storage is blocked. A failed replacement must not leave the old text to be restored.
    if (!evictOnFailure) return;
    try {
      storage.removeItem(key);
    } catch {
      /* Nothing more to clean up. */
    }
  }
}

export function deviceTextDraft(actor: string, kind: string, id: string | null) {
  const key = actor ? `doctorcre:${kind}:v1:${JSON.stringify([actor, id])}` : null;
  const storage = localTextStorage();
  return {
    read() {
      return key ? readStoredText(storage, key) : "";
    },
    write(text: string, options?: { evictOnFailure: boolean }) {
      if (key) writeStoredText(storage, key, text, options?.evictOnFailure ?? false);
    },
  };
}

export const docQuestionDraft = (actor: string, conversationId: string | null) =>
  deviceTextDraft(actor, "doc-question", conversationId);
