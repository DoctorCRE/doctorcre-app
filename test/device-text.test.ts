import assert from "node:assert/strict";
import test from "node:test";
import { deviceTextDraft, docQuestionDraft } from "../src/ui/device-text.ts";

function fakeLocalStorage() {
  const items = new Map<string, string>();
  const fake = {
    items,
    rejectWrites: false,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      if (fake.rejectWrites) throw new DOMException("full", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true });
  return fake;
}

test("a second kind of draft is kept apart from the Doc question for the same partner and id", () => {
  const { items } = fakeLocalStorage();
  docQuestionDraft("joe", "chat-1").write("a question");
  deviceTextDraft("joe", "reply-edit", "chat-1").write("a reply");
  assert.equal(docQuestionDraft("joe", "chat-1").read(), "a question");
  assert.equal(deviceTextDraft("joe", "reply-edit", "chat-1").read(), "a reply");
  assert.ok(items.has(`doctorcre:doc-question:v1:${JSON.stringify(["joe", "chat-1"])}`));
});

test("a rejected write keeps the old text unless the draft asks to evict it", () => {
  const storage = fakeLocalStorage();
  const draft = deviceTextDraft("joe", "reply-edit", "x");
  draft.write("old");
  storage.rejectWrites = true;
  draft.write("new");
  assert.equal(draft.read(), "old");
  draft.write("new", { evictOnFailure: true });
  assert.equal(draft.read(), "");
});
