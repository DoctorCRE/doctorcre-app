import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { draftReference, proposalRefusal, type Suggestion } from "./engine-review.ts";
import type { InboxClient, InboxItem, CardReview as Review, ReviewRequest, Snapshot, TaskReceipt } from "./inbox";
import { type Operation, reviewError } from "./review";

type State =
  | { phase: "loading" }
  | { phase: "ready" | "editing"; review: Review }
  | { phase: "submitting" | "uncertain"; review: Review; request: ReviewRequest }
  | { phase: "conflict"; review: Review; message: string }
  | { phase: "proposal-refused"; review: Review; message: string; id: string }
  | { phase: "refused" | "done"; message: string };
const labels: Record<Operation["verb"], string> = {
  "complete-one-action": "Mark done",
  "edit-email-draft": "Save draft",
  "dismiss-email-proposal": "Decline draft",
  "submit-email-draft": "Submit reply for sending",
  "resolve-fact-review": "Save review",
};
const availableDecisions = (
  op: Extract<Operation, { verb: "resolve-fact-review" }>,
  review: Extract<Review, { kind: "fact_review" }>,
) =>
  op.decisions.filter(
    (d) =>
      d === "reject" || (review.observations.length > 0 && (d !== "correct" || op.args.fact_key !== "rent_schedule")),
  );
const emailDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
type Props = {
  item: InboxItem;
  client: InboxClient["review"];
  children: ReactNode;
  close(): void;
  busy(value: boolean): void;
  confirmed(item: InboxItem | null, receipt?: TaskReceipt, snapshot?: Snapshot): void;
};
export function ReviewCard({ item, client, close, busy, confirmed, children }: Props) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("approve");
  const [observation, setObservation] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const host = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const anchor = useRef(item);
  const reconcileFacts = useCallback((detail: Review) => {
    if (detail.kind !== "fact_review") return;
    const choices = detail.operations[0] ? availableDecisions(detail.operations[0], detail) : [];
    setDecision((previous) =>
      choices.includes(previous)
        ? previous
        : choices.includes("approve")
          ? "approve"
          : choices.includes("reject")
            ? "reject"
            : choices[0] || "",
    );
    setObservation((previous) =>
      detail.observations.some((o) => o.id === previous) ? previous : detail.observations[0]?.id || "",
    );
  }, []);
  useEffect(() => {
    host.current?.focus();
    if (!client) return;
    const controller = new AbortController();
    alive.current = true;
    void client
      .load(anchor.current, controller.signal)
      .then((review) => {
        if (controller.signal.aborted) return;
        if (review.kind === "reply_draft") {
          setSubject(review.subject);
          setBody(review.body);
        }
        reconcileFacts(review);
        setState({ phase: "ready", review });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            phase: "refused",
            message:
              reviewError(error).kind === "uncertain"
                ? "Could not load this review. Close and try again."
                : reviewError(error).message,
          });
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [client, reconcileFacts]);
  const waiting = state.phase === "submitting" || lock.current;
  const review = "review" in state ? state.review : null;
  const proposals = review && "proposals" in review ? (review.proposals ?? []) : [];
  const proposalLed = item.item_id.startsWith("suggestion:");
  const editable = state.phase === "ready" || state.phase === "editing" || state.phase === "proposal-refused";
  async function reload() {
    if (!client || lock.current) return;
    lock.current = true;
    busy(true);
    setMessage("Loading the updated card. Your edits are kept.");
    try {
      const current = await client.current(anchor.current);
      const updated = await client.load(current);
      if (!alive.current) return;
      reconcileFacts(updated);
      anchor.current = current;
      confirmed(current);
      setState({ phase: "ready", review: updated });
      setMessage(
        "Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.",
      );
    } catch (error) {
      if (alive.current) setMessage(reviewError(error).message);
    } finally {
      lock.current = false;
      busy(false);
    }
  }
  async function run(request: ReviewRequest, detail: Review) {
    if (!client || lock.current) return;
    lock.current = true;
    busy(true);
    setState({ phase: "submitting", review: detail, request });
    setMessage("Waiting for server confirmation…");
    try {
      const result = await client.run(anchor.current, request);
      if (!alive.current) return;
      confirmed(result.item, result.receipt, result.snapshot);
      if (request.verb === "decide-engine-home-proposal" && detail.kind === "reply_draft" && result.item) {
        const before = draftReference(anchor.current);
        const after = draftReference(result.item);
        if (!before || after?.id !== before.id || after.version !== before.version)
          throw Object.assign(Error("The draft changed."), { payload: { error: "version_conflict" } });
        const refreshed = await client.load(result.item);
        if (!alive.current) return;
        anchor.current = result.item;
        setState({ phase: "ready", review: refreshed });
        setMessage(request.args.decision === "accept" ? "Suggestion accepted." : "Suggestion dismissed.");
        return;
      }
      if (result.snapshot && request.verb !== "edit-email-draft") {
        close();
        return;
      }
      if (request.verb === "edit-email-draft") {
        if (!result.item || (result.snapshot && result.item.source_version !== String(result.saved_version)))
          throw Object.assign(Error("The saved draft changed."), { payload: { error: "version_conflict" } });
        anchor.current = result.item;
        const next = await client.load(result.item);
        if (!alive.current) return;
        if (
          next.kind !== "reply_draft" ||
          next.operations.some((op) => op.args.base_version !== result.saved_version) ||
          next.subject !== request.args.subject ||
          next.body !== request.args.body
        )
          throw Object.assign(Error("The saved draft changed again."), { payload: { error: "version_conflict" } });
        setState({ phase: "ready", review: next });
        setMessage("Saved as a draft. Nothing was sent.");
      } else {
        setState({
          phase: "done",
          message:
            request.verb === "submit-email-draft"
              ? item.engine_marks
                ? "Sending"
                : "Reply submitted to the existing sender. Delivery is not yet confirmed."
              : "This card is confirmed. Its current state is shown in your inbox.",
        });
        setMessage("");
      }
    } catch (error) {
      if (!alive.current) return;
      const refusal = request.verb === "decide-engine-home-proposal" ? proposalRefusal(error) : null;
      if (refusal) {
        const { id, decision } = request.args;
        setMessage("");
        setState(
          decision === "accept" && typeof id === "string"
            ? { phase: "proposal-refused", review: detail, message: refusal, id }
            : { phase: "refused", message: refusal },
        );
        host.current?.focus();
        return;
      }
      const failure = reviewError(error);
      setMessage("");
      if (failure.kind === "uncertain") setState({ phase: "uncertain", review: detail, request });
      else if (failure.kind === "conflict") setState({ phase: "conflict", review: detail, message: failure.message });
      else setState({ phase: "refused", message: failure.message });
    } finally {
      lock.current = false;
      busy(false);
    }
  }
  function choose(op: Operation) {
    if (!review || !editable || lock.current || !form.current) return;
    if (op.verb !== "dismiss-email-proposal" && !form.current.reportValidity()) return;
    let input: Record<string, unknown> = {};
    if (op.verb === "edit-email-draft" || op.verb === "submit-email-draft")
      input = {
        subject,
        body,
        ...(op.verb === "submit-email-draft" &&
          review.kind === "reply_draft" &&
          review.attachments && { document_ids: review.attachments.map((row) => row.id) }),
      };
    if (op.verb === "dismiss-email-proposal") {
      if (!reason.trim()) {
        setMessage("Give a reason before declining this draft.");
        return;
      }
      input = { reason };
    }
    if (op.verb === "resolve-fact-review") {
      if (
        review.kind !== "fact_review" ||
        !availableDecisions(op, review).includes(decision) ||
        (decision === "approve" && !review.observations.some((o) => o.id === observation))
      ) {
        setMessage("Choose an available decision and current evidence before saving.");
        return;
      }
      if (!reason.trim()) {
        setMessage("Give a reason for this review.");
        return;
      }
      input = { decision, reason, ...(decision === "approve" ? { observation_id: observation } : {}) };
      if (decision === "correct") {
        const data = new FormData(form.current);
        input.correction = {
          fact_key: op.args.fact_key,
          value: data.get("value"),
          unit: data.get("unit"),
          ...(op.args.fact_key === "base_rent_per_sf" ? { expense_basis: data.get("expense_basis") } : {}),
          source: {
            document_ref: data.get("document_ref"),
            page_start: Number(data.get("page_start")),
            page_end: Number(data.get("page_end")),
            cited_text: data.get("cited_text"),
          },
        };
      }
    }
    void run({ verb: op.verb, args: { ...op.args, ...input, idempotency_key: crypto.randomUUID() } }, review);
  }
  function decideSuggestion(proposal: Suggestion, decision: "accept" | "dismiss") {
    if (!review || !form.current || !editable) return;
    const fields = new FormData(form.current);
    const what = fields.get(`${proposal.id}-what`);
    const edits = decision === "accept" && proposal.editable;
    if (edits && (typeof what !== "string" || !what.trim())) {
      setMessage("Enter a next step before accepting.");
      return;
    }
    void run(
      {
        verb: "decide-engine-home-proposal",
        args: {
          id: proposal.id,
          decision,
          idempotency_key: crypto.randomUUID(),
          ...(edits && { edits: { what, due_on: fields.get(`${proposal.id}-date`) || null } }),
        },
      },
      review,
    );
  }
  const suggestionFields = (
    <>
      {review?.kind === "reply_draft" && proposals.length > 0 && <h4>Suggestions</h4>}
      {proposals.length > 0 &&
        proposals.map((proposal) => (
          <section key={proposal.id}>
            <h4>
              {proposal.label}
              {proposal.target ? ` · ${proposal.target}` : ""}
            </h4>
            {proposal.source && (
              <>
                <p>
                  {proposal.source.from}
                  {proposal.source.occurredAt && (
                    <>
                      {" "}
                      on{" "}
                      <time dateTime={proposal.source.occurredAt}>
                        {emailDate.format(new Date(proposal.source.occurredAt))}
                      </time>
                    </>
                  )}
                </p>
                {proposal.source.subject && <p>{proposal.source.subject}</p>}
                {proposal.source.excerpt && <blockquote>{proposal.source.excerpt}</blockquote>}
              </>
            )}
            <p>Words that prompted this suggestion</p>
            <blockquote>{proposal.evidence}</blockquote>
            {proposal.editable ? (
              <>
                <label>
                  Next step <input name={`${proposal.id}-what`} defaultValue={proposal.what ?? ""} />
                </label>
                <label>
                  Due date <input type="date" name={`${proposal.id}-date`} defaultValue={proposal.dueOn ?? ""} />
                </label>
              </>
            ) : (
              proposal.what && <p>{proposal.what}</p>
            )}
            {!proposal.canAccept && (
              <p>This step changed after the suggestion. Mark it done from the step, or choose Not yet.</p>
            )}
            <div className="inbox-actions">
              {(["accept", "dismiss"] as const).map((decision) => (
                <button
                  key={decision}
                  type="button"
                  disabled={
                    decision === "accept" &&
                    (!proposal.canAccept || (state.phase === "proposal-refused" && state.id === proposal.id))
                  }
                  onClick={() => decideSuggestion(proposal, decision)}
                >
                  {proposal.completion
                    ? decision === "accept"
                      ? "Yes, it’s done"
                      : "Not yet"
                    : decision === "accept"
                      ? "Accept"
                      : "Dismiss"}
                </button>
              ))}
            </div>
          </section>
        ))}
    </>
  );
  return (
    <section
      className="home-inline-review"
      ref={host}
      tabIndex={-1}
      aria-label={`Details for ${item.title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !waiting && state.phase !== "uncertain") {
          event.preventDefault();
          close();
        }
      }}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <header>
        <h4>{client ? "Review this card" : item.title}</h4>
        <button type="button" disabled={waiting || state.phase === "uncertain"} onClick={close}>
          {client && item.review_reference?.kind !== "action" ? "Close review" : "Close"}
        </button>
      </header>
      {children}
      {review?.kind === "reply_draft" &&
        (review.email ? (
          <section aria-label="Their email">
            <h4>Their email</h4>
            {review.email.sender && <p>From: {review.email.sender}</p>}
            {review.email.occurredAt && (
              <p>
                <time dateTime={review.email.occurredAt}>{emailDate.format(new Date(review.email.occurredAt))}</time>
              </p>
            )}
            {review.email.subject && <p>{review.email.subject}</p>}
            <blockquote>{review.email.excerpt}</blockquote>
          </section>
        ) : (
          <p>The original email is unavailable.</p>
        ))}
      {client && state.phase === "loading" && <p role="status">Loading current evidence…</p>}
      {(state.phase === "refused" || state.phase === "done") && <p role="status">{state.message}</p>}
      {state.phase === "proposal-refused" && <p role="alert">{state.message}</p>}
      {review && (
        <form
          ref={form}
          onSubmit={(event) => event.preventDefault()}
          onChange={() => {
            if (state.phase === "ready") setState({ phase: "editing", review });
            setMessage("");
          }}
        >
          <fieldset disabled={!editable}>
            <legend>
              {review.kind === "reply_draft"
                ? proposalLed
                  ? "Suggestions and reply draft"
                  : "Exact reply for review"
                : review.kind === "fact_review"
                  ? "Evidence and decision"
                  : review.kind === "suggestions"
                    ? "Suggestions"
                    : "Task"}
            </legend>
            {review.kind === "action" && <p>{review.title}</p>}
            {proposalLed && suggestionFields}
            {review.kind === "reply_draft" && (
              <>
                {review.addresses ? (
                  <>
                    <p>To: {review.addresses.to || "Unavailable"}</p>
                    <p>CC: {review.addresses.cc || "Unavailable"}</p>
                  </>
                ) : review.recipients ? (
                  <>
                    <p>To: {review.recipients.to.join(", ")}</p>
                    <p>CC: {review.recipients.cc.join(", ")}</p>
                  </>
                ) : (
                  <p>Send recipients are unavailable.</p>
                )}
                {review.statusMessage ? (
                  <p role="status">{review.statusMessage}</p>
                ) : (
                  !review.operations.some((op) => op.verb === "submit-email-draft") && (
                    <p>
                      Sending unavailable:{" "}
                      {review.sendUnavailableReason || "The source record does not allow sending this draft."}
                    </p>
                  )
                )}
                {review.attachments?.map((attachment) => (
                  <p key={attachment.id}>
                    <a href={`/api/engine/documents/${encodeURIComponent(attachment.id)}`}>{attachment.name}</a>
                  </p>
                ))}
                <details>
                  <summary>Current saved reply</summary>
                  <p>{review.subject}</p>
                  <p>{review.body}</p>
                </details>
                <label>
                  Subject
                  <input
                    value={subject}
                    disabled={!review.operations.length}
                    onChange={(event) => setSubject(event.target.value)}
                    maxLength={998}
                    required
                  />
                </label>
                <label>
                  Message
                  <textarea
                    aria-label="Message"
                    value={body}
                    disabled={!review.operations.length}
                    onChange={(event) => setBody(event.target.value)}
                    rows={8}
                    maxLength={20000}
                    required
                  />
                </label>
                <p>
                  {item.engine_marks
                    ? "Save draft keeps your edits. Send reply approves this exact text from your mailbox."
                    : "Save draft sends nothing. Submit reply authorizes the existing sender to send this exact content to these recipients."}
                </p>
                <label>
                  Reason for declining
                  <input
                    value={reason}
                    maxLength={500}
                    disabled={!review.operations.length}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              </>
            )}
            {!proposalLed && suggestionFields}
            {review.kind === "fact_review" && (
              <>
                <p>Canonical value: {review.canonical}</p>
                {review.observations.map((o) => (
                  <section key={o.id}>
                    <strong>
                      {o.value} {o.unit}
                    </strong>
                    <p>
                      Document {o.source.document_ref}, pages {o.source.page_start} to {o.source.page_end}
                    </p>
                    <blockquote>{o.source.cited_text || "Excerpt no longer available"}</blockquote>
                  </section>
                ))}
                <label>
                  Decision
                  <select aria-label="Decision" value={decision} onChange={(event) => setDecision(event.target.value)}>
                    {!decision && (
                      <option value="" disabled>
                        No decision available
                      </option>
                    )}
                    {review.operations[0]?.decisions.map((d) => (
                      <option
                        key={d}
                        value={d}
                        disabled={
                          !review.operations[0] || !availableDecisions(review.operations[0], review).includes(d)
                        }
                      >
                        {d === "approve"
                          ? "Approve a sourced value"
                          : d === "correct"
                            ? "Correct with a source"
                            : "Reject this review"}
                      </option>
                    ))}
                  </select>
                </label>
                {decision === "approve" && (
                  <label>
                    Choose a sourced value
                    <select
                      aria-label="Choose a sourced value"
                      value={observation}
                      onChange={(event) => setObservation(event.target.value)}
                      required
                    >
                      {review.observations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.value} {o.unit}, pages {o.source.page_start} to {o.source.page_end}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {decision === "correct" && (
                  <>
                    <label>
                      Corrected value
                      <input
                        name="value"
                        inputMode="decimal"
                        pattern="(?:0|[1-9][0-9]{0,29})(?:[.][0-9]{1,18})?"
                        required
                      />
                    </label>
                    <label>
                      Unit
                      <select aria-label="Unit" name="unit">
                        {[...new Set(review.observations.map((o) => o.unit))].map((unit) => (
                          <option key={unit}>{unit}</option>
                        ))}
                      </select>
                    </label>
                    {review.operations[0]?.args.fact_key === "base_rent_per_sf" && (
                      <label>
                        Expense basis
                        <select aria-label="Expense basis" name="expense_basis">
                          <option value="nnn">NNN</option>
                          <option value="modified_gross">Modified gross</option>
                          <option value="full_service_gross">Full service gross</option>
                          <option value="gross">Gross</option>
                        </select>
                      </label>
                    )}
                    <label>
                      Source document
                      <select aria-label="Source document" name="document_ref">
                        {[...new Set(review.observations.map((o) => o.source.document_ref))].map((id) => (
                          <option key={id} value={id}>
                            Document {id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      First page
                      <input name="page_start" type="number" min={1} max={100000} defaultValue={1} required />
                    </label>
                    <label>
                      Last page
                      <input name="page_end" type="number" min={1} max={100000} defaultValue={1} required />
                    </label>
                    <label>
                      Cited text
                      <textarea name="cited_text" maxLength={4000} required />
                    </label>
                  </>
                )}
                <label>
                  Reason
                  <textarea
                    aria-label="Reason"
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                </label>
              </>
            )}
          </fieldset>
          <div className="inbox-actions">
            {review.operations.map((op) => (
              <button
                type="button"
                key={op.verb}
                disabled={
                  !editable ||
                  (op.verb === "resolve-fact-review" &&
                    (review.kind !== "fact_review" || !availableDecisions(op, review).includes(decision)))
                }
                onClick={() => choose(op)}
              >
                {item.engine_marks && op.verb === "submit-email-draft" ? "Send reply" : labels[op.verb]}
              </button>
            ))}
          </div>
        </form>
      )}
      {state.phase === "conflict" && (
        <>
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            Review updated card
          </button>
        </>
      )}
      {state.phase === "uncertain" && (
        <>
          <p role="alert">The result is uncertain. Your exact request is kept. Nothing retries automatically.</p>
          <button type="button" onClick={() => void run(state.request, state.review)}>
            Retry same review request
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
