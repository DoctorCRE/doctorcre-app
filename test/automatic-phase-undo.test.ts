import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticPhaseUndo } from "../src/ui/automatic-phase-undo.ts";

test("automatic Undo routes invoice receipts and reports a conflict hint", async () => {
  const calls: unknown[] = [];
  const messages: string[] = [];
  let hint = "Closed because an invoice was recorded; Undo isn't available";
  const controller = createAutomaticPhaseUndo({
    feedbackByDeal: new Map(),
    state: {
      nextDealSaves: true,
      selfActor: "joe",
      boardSync: { requestRefresh: async () => ({ applied: true }) },
      client: {
        undoAutomaticPhaseMove: async (request) => {
          calls.push(request);
        },
        undoInvoiceClose: async (request) => {
          calls.push(request);
        },
      },
    },
    performCommand: async (command) => {
      await command.call({ ...command.args, idempotency_key: "key" });
      return { status: "refused", code: "version_conflict", hint };
    },
    newKey: () => "key",
    render: () => {},
    report: (message) => messages.push(message),
    refreshedMessage: "Refreshed.",
  });
  const button = (dataset: Record<string, string>) => {
    // The controller reads only dataset and the disabled attribute.
    return { dataset, getAttribute: () => null } as unknown as HTMLButtonElement;
  };
  await controller.undo(button({ undoInvoice: "deal", eventId: "invoice", baseVersion: "4" }));
  assert.deepEqual(calls[0], { deal: "deal", invoice_id: "invoice", seen_change_id: 4, idempotency_key: "key" });
  assert.equal(messages[0], "Closed because an invoice was recorded; Undo isn't available");
  await controller.undo(button({ undoPhase: "other", eventId: "event", baseVersion: "5" }));
  assert.deepEqual(calls[1], { deal: "other", event_id: "event", seen_change_id: 5, idempotency_key: "key" });
  hint = "This deal changed. Reload the deal before saving.";
  await controller.undo(button({ undoPhase: "stale", eventId: "event", baseVersion: "6" }));
  assert.equal(messages[2], "This deal changed. Refreshed.");
  hint = "Re-read the record and ask the human before retrying.";
  await controller.undo(button({ undoPhase: "stale-engine", eventId: "event", baseVersion: "7" }));
  assert.equal(messages[3], "This deal changed. Refreshed.");
});
