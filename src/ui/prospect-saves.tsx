import { type FormEvent, useRef, useState } from "react";

type Reply =
  | { ok: true; data: Record<string, unknown>; sent: Record<string, unknown> }
  | { ok: false; problem: Record<string, unknown>; pending: boolean };
export type ProspectClient = {
  prospectRequest: (path: string, init?: RequestInit) => Promise<Response>;
  saveProspect: (path: string, operation: string, receipt: string, args?: object) => Promise<Reply>;
};
type SaveState = { kind: "ready" | "saving" } | { kind: "refused"; problem: Record<string, unknown>; pending: boolean };
const prospects = "/api/engine/prospects";

function useProspectSave(
  client: ProspectClient,
  url: string,
  operation: string,
  receipt: string,
  saved: (data: Record<string, unknown>, sent: Record<string, unknown>) => void,
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
        saved(result.data, result.sent);
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

const refusalMessages: Readonly<Record<string, string>> = {
  actor_not_provisioned: "Your account is not set up to save prospects. Ask the app administrator.",
  database_refused_the_statement: "The change was refused. Reload the prospect, then try again.",
  not_found: "This prospect could not be found. Reload Deals to check.",
  not_a_prospect: "This person or company is no longer in Prospects. Reload Deals to check.",
  already_client: "This person or company is already a client. Open Add deal to continue.",
  open_step_exists: "You already have a follow-up. Reload the prospect to see it.",
  key_reuse: "An earlier request used this save. Reload the prospect before trying again.",
  session_changed: "Your sign-in changed. Reopen Deals before saving.",
  authentication_required: "Sign in again to save prospects.",
  authorization_refused: "This account cannot save prospects. Check which account is signed in.",
};
const editableFields: readonly string[] = ["summary", "what", "due_on", "name", "kind", "how_found", "note", "reason"];

function ProspectSaveFeedback({ save, reload }: { save: ReturnType<typeof useProspectSave>; reload?: () => void }) {
  if (save.state.kind !== "refused") return null;
  const { problem, pending } = save.state;
  if (pending)
    return (
      <p role="alert">
        {problem.error === "unresolved_command"
          ? "Check the earlier save before sending this draft."
          : "The save could not be confirmed."}{" "}
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
  const code = typeof problem.error === "string" ? problem.error : "";
  const fields = problem.fields;
  if (Array.isArray(fields) && fields.length && fields.every((field) => editableFields.includes(field))) {
    if (code === "missing_required") return <p role="alert">Fill in the missing information and try again.</p>;
    if (code === "invalid_field_value") return <p role="alert">Check what you entered and try again.</p>;
  }
  return (
    <p role="alert">
      {Object.hasOwn(refusalMessages, code)
        ? refusalMessages[code]
        : "This couldn't be saved. Reload the prospect and try again."}
    </p>
  );
}

type Props = { id: string; client: ProspectClient; saved: () => void };
export function ProspectNote({ id, client, saved }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const note = useProspectSave(client, `${prospects}/note`, `${id}:note`, "activity_id", (_data, sent) => {
    if (input.current?.value.trim() === sent.summary) {
      form.current?.reset();
      setMessage("");
    } else if (input.current?.value.trim()) setMessage("Earlier note confirmed. Press Enter to save your draft.");
    saved();
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const summary = String(new FormData(event.currentTarget).get("summary") ?? "").trim();
    if (summary) void note.send({ kind: "note", about: [{ party_id: id }], summary });
  }
  return (
    <>
      <form className="field" ref={form} onSubmit={submit}>
        <label>
          Add note
          <input
            ref={input}
            name="summary"
            required
            disabled={note.blocked}
            onChange={() => setMessage("")}
            placeholder="Write a note and press Enter"
          />
        </label>
      </form>
      <ProspectSaveFeedback save={note} />
      {message && <p role="status">{message}</p>}
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
  const whatInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const base = useRef<{ step: StepVersion | undefined }>(null);
  const save = useProspectSave(client, `${prospects}/follow-up`, `${id}:follow-up`, "next_step_id", (_data, sent) => {
    if (whatInput.current?.value.trim() === sent.what && dateInput.current?.value === sent.due_on) {
      form.current?.reset();
      base.current = null;
    }
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
        className="field"
        ref={form}
        onChange={() => {
          base.current ??= { step: current };
        }}
        onSubmit={submit}
      >
        <label>
          Your follow-up
          <input ref={whatInput} name="what" required disabled={save.blocked} />
        </label>
        <label>
          Follow-up date
          <input ref={dateInput} name="due_on" type="date" required disabled={save.blocked} />
        </label>
        <button type="submit" className="btn" disabled={save.blocked}>
          Set your follow-up
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
