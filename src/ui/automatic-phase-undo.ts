type Request = { deal: string; event_id: string; seen_change_id: number };
type InvoiceRequest = { deal: string; invoice_id: string; seen_change_id: number; idempotency_key: string };
type RetainedRequest = Request & { idempotency_key: string };
type Feedback = { eventId?: string; message: string };
type UndoState =
  | { status: "idle" }
  | { status: "pending" }
  | ({ status: "refreshed" } & Feedback)
  | ({ status: "failed"; needsRefresh?: true; code?: string | undefined } & Feedback);
type DealView = {
  deal: string;
  state: UndoState;
  refresh: () => Promise<boolean>;
  render: () => void;
};
type Commands = Record<string, unknown>;
type Options = {
  stateByDeal: Map<string, UndoState>;
  state: {
    nextDealSaves?: boolean;
    selfActor: string | null;
    client: {
      undoAutomaticPhaseMove: (request: RetainedRequest) => Promise<unknown>;
      undoInvoiceClose: (request: InvoiceRequest) => Promise<unknown>;
    } | null;
    boardSync: { requestRefresh: (reason: string) => Promise<{ applied: boolean }> } | null;
  };
  performCommand: (command: {
    operationKey: string;
    args: Request;
    getState: () => Commands;
    setState: (next: Commands) => void;
    newKey: () => string;
    call: (request: RetainedRequest) => Promise<unknown>;
  }) => Promise<{ status: string; code?: string; hint?: string }>;
  newKey: () => string;
  render: () => void;
  report: (message: string) => void;
  refreshedMessage: string;
};

export function createAutomaticPhaseUndo({
  stateByDeal,
  state,
  performCommand,
  newKey,
  render,
  report,
  refreshedMessage,
}: Options) {
  let commands: Commands = {};

  async function undo(button: HTMLButtonElement, view?: DealView) {
    const { client, boardSync, nextDealSaves, selfActor } = state;
    if (!client || !boardSync || !nextDealSaves || button.getAttribute("aria-disabled") === "true") return;
    const { undoPhase, undoInvoice, eventId, baseVersion } = button.dataset;
    const deal = undoPhase || undoInvoice;
    const version = Number(baseVersion);
    if (!deal || !eventId || !Number.isSafeInteger(version) || version < 0 || (view && view.deal !== deal)) return;
    const current = () => (view ? view.state : stateByDeal.get(deal));
    const paint = (next: UndoState) => {
      if (view) {
        view.state = next;
        view.render();
      } else {
        if (next.status === "idle") stateByDeal.delete(deal);
        else stateByDeal.set(deal, next);
        render();
        if ((next.status === "refreshed" || next.status === "failed") && next.message) report(next.message);
      }
    };
    const previous = current();
    if (previous?.status === "pending" || (view && previous?.status === "failed" && previous.needsRefresh)) return;
    const pending: UndoState = { status: "pending" };
    paint(pending);
    const result = await performCommand({
      operationKey: `phase-undo:${selfActor}:${deal}:${eventId}:${version}`,
      args: { deal, event_id: eventId, seen_change_id: version },
      getState: () => commands,
      setState: (next) => {
        commands = next;
      },
      newKey,
      call: (request) =>
        undoInvoice
          ? client.undoInvoiceClose({
              deal: request.deal,
              invoice_id: request.event_id,
              seen_change_id: request.seen_change_id,
              idempotency_key: request.idempotency_key,
            })
          : client.undoAutomaticPhaseMove(request),
    });
    if (current() !== pending) return;
    if (result.status === "ok" || result.code === "version_conflict") {
      const board = boardSync.requestRefresh("after-phase-undo");
      const refreshed = view ? await view.refresh() : (await board).applied;
      if (current() !== pending) return;
      const hint = [
        "This deal changed. Reload the deal before saving.",
        "Re-read the record and ask the human before retrying.",
      ].includes(result.hint || "")
        ? null
        : result.hint;
      if (refreshed) {
        const message = result.status === "ok" ? "" : hint || `This deal changed. ${refreshedMessage}`;
        paint(view || message ? { status: "refreshed", message } : { status: "idle" });
      } else {
        const message =
          result.status === "ok"
            ? "Move undone. Refresh Deals to see the current phase."
            : hint || "This deal changed. Refresh Deals to see the current phase.";
        paint({ status: "failed", needsRefresh: true, message });
      }
    } else {
      paint({
        status: "failed",
        eventId,
        code: result.code,
        message:
          result.hint ||
          (result.status === "unknown"
            ? "Undo could not be confirmed. Use Undo again to check what happened."
            : "Undo could not be saved."),
      });
    }
  }

  return { undo };
}
