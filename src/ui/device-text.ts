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

function writeStoredText(storage: TextStorage | null, key: string, text: string): void {
  if (!storage) return;
  try {
    if (text) storage.setItem(key, text);
    else storage.removeItem(key);
  } catch {
    /* The typing box still works when device storage is blocked. */
  }
}

function docQuestionDraftKey(actor: string, conversationId: string | null): string {
  return `doctorcre:doc-question:v1:${JSON.stringify([actor, conversationId])}`;
}

export function docQuestionDraft(actor: string, conversationId: string | null) {
  const key = actor ? docQuestionDraftKey(actor, conversationId) : null;
  const storage = localTextStorage();
  return {
    read() {
      return key ? readStoredText(storage, key) : "";
    },
    write(text: string) {
      if (key) writeStoredText(storage, key, text);
    },
  };
}
