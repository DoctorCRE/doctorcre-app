import { object } from "./inbox";

export type DraftEdit = { subject: string; body: string; baseVersion: string };
type TextDraft = {
  read(): string;
  write(text: string, options?: { evictOnFailure: boolean }): void;
};
export type PrivateReplyDraft = (id: string) => TextDraft;

function draftEdits(privateDraft?: PrivateReplyDraft) {
  const edits = new Map<string, DraftEdit>();
  return {
    read(id: string): DraftEdit | undefined {
      const current = edits.get(id);
      if (current) return current;
      const stored = privateDraft?.(id).read();
      if (!stored) return;
      try {
        const value: unknown = JSON.parse(stored);
        if (!object(value)) return;
        const { subject, body, baseVersion } = value;
        if (typeof subject === "string" && typeof body === "string" && typeof baseVersion === "string")
          return { subject, body, baseVersion };
      } catch {
        // An unreadable local draft cannot be restored.
      }
    },
    write(id: string, edit: DraftEdit | null) {
      if (edit) edits.set(id, edit);
      else edits.delete(id);
      privateDraft?.(id).write(edit ? JSON.stringify(edit) : "", { evictOnFailure: true });
    },
  };
}

export function createDraftEdits(privateDraft?: PrivateReplyDraft) {
  return { engine: draftEdits(privateDraft), legacy: draftEdits() };
}

export type DraftEdits = ReturnType<typeof createDraftEdits>;
