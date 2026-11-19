import { type FormEvent, useRef, useState } from "react";

type Reply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; problem: Record<string, unknown>; pending: boolean };
export type ProspectClient = {
  prospectRequest: (path: string, init?: RequestInit) => Promise<Response>;
  saveProspect: (path: string, operation: string, receipt: string, args?: object) => Promise<Reply>;
};
type SaveState = { kind: "ready" | "saving" } | { kind: "refused"; problem: Record<string, unknown>; pending: boolean };
export const prospectsPath = "/api/engine/prospects";

export function useProspectSave(
  client: ProspectClient,
  url: string,
  operation: string,
  receipt: string,
  saved: (data: Record<string, unknown>) => void,
) {
  const busy = useRef(false);
  const [state, setState] = useState<SaveState>({ kind: "ready" });
  async function send(args?: object) {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: "saving" });
    try {
      const result = await client.saveProspect(url, operation, receipt, args);
      if (result.ok) {
        setState({ kind: "ready" });
        saved(result.data);
      } else setState({ kind: "refused", problem: result.problem, pending: result.pending });
    } finally {
      busy.current = false;
    }
  }
  return {
    send,
    state,
    blocked: state.kind === "saving" || (state.kind === "refused" && state.pending),
    clear: () => setState({ kind: "ready" }),
  };
}

export function ProspectSaveFeedback({
  save,
  reload,
}: {
  save: ReturnType<typeof useProspectSave>;
  reload?: () => void;
}) {
  if (save.state.kind !== "refused") return null;
  const { problem, pending } = save.state;
  if (pending)
    return (
      <p role="alert">
        The save could not be confirmed.{" "}
        <button type="button" className="btn" onClick={() => void save.send()}>
          Check outcome
        </button>
      </p>
    );
  if (problem.error === "version_conflict")
    return (
      <p role="alert">
        This prospect changed while you were editing.{" "}
        {reload && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              save.clear();
              reload();
            }}
          >
            Reload changes
          </button>
        )}
      </p>
    );
  return (
    <p role="alert">
      {problem.error === "not_a_prospect" || problem.error === "not_found"
        ? "This prospect is no longer available here. Reload Deals to check."
        : "This couldn't be saved. Check what you entered and try again."}
    </p>
  );
}

type Props = { id: string; client: ProspectClient; saved: () => void };
export function ProspectNote({ id, client, saved }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const note = useProspectSave(client, `${prospectsPath}/note`, `${id}:note`, "activity_id", () => {
    form.current?.reset();
    saved();
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const summary = String(new FormData(event.currentTarget).get("summary") ?? "").trim();
    if (summary) void note.send({ kind: "note", about: [{ party_id: id }], summary });
  }
  return (
    <>
      <form ref={form} onSubmit={submit}>
        <label>
          Add note
          <input name="summary" required disabled={note.blocked} placeholder="Write a note and press Enter" />
        </label>
      </form>
      <ProspectSaveFeedback save={note} />
    </>
  );
}

type StepVersion = { next_step_id: string; change_id: number };
export function ProspectFollowUp({
  id,
  client,
  current,
  saved,
  reload,
}: Props & {
  current: StepVersion | undefined;
  reload: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const base = useRef<{ step: StepVersion | undefined }>(null);
  const save = useProspectSave(client, `${prospectsPath}/follow-up`, `${id}:follow-up`, "next_step_id", () => {
    form.current?.reset();
    base.current = null;
    saved();
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const what = String(data.get("what") ?? "").trim(),
      due_on = data.get("due_on");
    const seen = base.current === null ? current : base.current.step;
    if (what && typeof due_on === "string" && due_on)
      void save.send({
        party_id: id,
        what,
        due_on,
        replaces: "current",
        seen_current_step: seen ? { next_step_id: seen.next_step_id, change_id: seen.change_id } : null,
      });
  }
  return (
    <>
      <form
        ref={form}
        onChange={() => {
          base.current ??= { step: current };
        }}
        onSubmit={submit}
      >
        <label>
          Follow-up
          <input name="what" required disabled={save.blocked} />
        </label>
        <label>
          Follow-up date
          <input name="due_on" type="date" required disabled={save.blocked} />
        </label>
        <button type="submit" className="btn" disabled={save.blocked}>
          Set follow-up
        </button>
      </form>
      <ProspectSaveFeedback
        save={save}
        reload={() => {
          base.current = null;
          reload();
        }}
      />
    </>
  );
}
