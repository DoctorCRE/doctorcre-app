type Request = { deal: string; event_id: string; seen_change_id: number };
type RetainedRequest = Request & { idempotency_key: string };
type Feedback = { busy: boolean; eventId: string | null; code?: string; message: string };
type Commands = Record<string, unknown>;
type Options = {
  state: {
    nextDealSaves?: boolean;
    selfActor: string | null;
    client: { undoAutomaticPhaseMove: (request: RetainedRequest) => Promise<unknown> } | null;
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

export function createAutomaticPhaseUndo({ state, performCommand, newKey, render, report, refreshedMessage }: Options) {
  const feedbackByDeal = new Map<string, Feedback>();
  let commands: Commands = {};

  async function undo(button: HTMLButtonElement) {
    const { client, boardSync, nextDealSaves, selfActor } = state;
    if (!client || !boardSync || !nextDealSaves || button.getAttribute("aria-disabled") === "true") return;
    const { undoPhase: deal, eventId, baseVersion } = button.dataset;
    const version = Number(baseVersion);
    if (!deal || !eventId || !Number.isSafeInteger(version) || version < 0 || feedbackByDeal.get(deal)?.busy) return;
    const feedback: Feedback = { busy: true, eventId: null, message: "" };
    feedbackByDeal.set(deal, feedback);
    render();
    const result = await performCommand({
      operationKey: `phase-undo:${selfActor}:${deal}:${eventId}:${version}`,
      args: { deal, event_id: eventId, seen_change_id: version },
      getState: () => commands,
      setState: (next) => {
        commands = next;
      },
      newKey,
      call: (request) => client.undoAutomaticPhaseMove(request),
    });
    if (feedbackByDeal.get(deal) !== feedback) return;
    if (result.status === "ok" || result.code === "version_conflict") {
      const refreshed = await boardSync.requestRefresh("after-phase-undo");
      if (feedbackByDeal.get(deal) !== feedback) return;
      feedback.message =
        result.status === "ok"
          ? refreshed.applied
            ? ""
            : "Move undone. Refresh Deals to see the current phase."
          : refreshed.applied
            ? `This deal changed. ${refreshedMessage}`
            : "This deal changed. Refresh Deals to see the current phase.";
    } else {
      feedback.eventId = eventId;
      if (result.code) feedback.code = result.code;
      feedback.message =
        result.hint ||
        (result.status === "unknown"
          ? "Undo could not be confirmed. Use Undo again to check what happened."
          : "Undo could not be saved.");
    }
    feedback.busy = false;
    if (!feedback.message) feedbackByDeal.delete(deal);
    render();
    if (feedback.message) report(feedback.message);
  }

  return { feedback: (deal: string) => feedbackByDeal.get(deal), undo, clear: () => feedbackByDeal.clear() };
}
