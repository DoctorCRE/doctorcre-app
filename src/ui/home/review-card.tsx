import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type DocLinkRequest, type DocLinkStatus, docLinkMessages, readDocLinkStatus } from "../doc-link";
import { submitOnEnter } from "../keyboard-input";
import type { DraftEdit, DraftEdits } from "./draft-edits.ts";
import { DropReason } from "./drop-reason.tsx";
import {
  draftReference,
  type FilingReasonRefusal,
  filingReasonRefusal,
  proposalRefusal,
  type Suggestion,
} from "./engine-review.ts";
import { FilingControls, type FilingDestination } from "./filing-controls.tsx";
import type {
  LinkedReview,
  CardReview as Review,
  ReviewClient,
  ReviewItem,
  ReviewRequest,
  Snapshot,
  TaskReceipt,
} from "./inbox";
import { type Operation, reviewError } from "./review";
import { sourceExcerptText } from "./source-excerpt.ts";

type State =
  | { phase: "loading" }
  | { phase: "ready" | "editing"; review: Review }
  | { phase: "submitting" | "uncertain"; review: Review; request: ReviewRequest }
  | { phase: "conflict"; review: Review; message: string }
  | { phase: "proposal-refused"; review: Review; message: string; id: string; filing: FilingReasonRefusal | null }
  | { phase: "refused" | "done"; message: string };
const labels: Record<Operation["verb"], string> = {
  "complete-one-action": "Mark done",
  "edit-email-draft": "Save draft",
  "dismiss-email-proposal": "Decline draft",
  "submit-email-draft": "Submit reply for sending",
};
const emailDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const threadDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
});
function EarlierText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide earlier text" : "Show earlier text"}
      </button>
      <p id={id} className="home-email-earlier-text" hidden={!expanded}>
        {expanded && sourceExcerptText(text)}
      </p>
    </>
  );
}

function TalkToDoc({ request, href }: { request: DocLinkRequest | undefined; href: string }) {
  const [status, setStatus] = useState<DocLinkStatus | null>();
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    void readDocLinkStatus(request, controller.signal).then((status) => {
      if (!controller.signal.aborted) setStatus(status);
    });
    return () => controller.abort();
  }, [request]);

  if (status === "ready")
    return (
      <a className="btn" href={href}>
        Talk to Doc about this draft
      </a>
    );

  let reason = "Sign in with DoctorCRE to talk to Doc.";
  if (request) {
    if (status) reason = docLinkMessages[status];
    else reason = status === null ? "Couldn't check whether Doc is ready." : "Checking Doc status…";
  }
  return (
    <p className="inbox-detail inbox-guidance" role="status">
      {reason}
    </p>
  );
}

const writesDraftText = (verb: Operation["verb"]) => verb === "edit-email-draft" || verb === "submit-email-draft";

type Props<Item extends ReviewItem> = {
  item: Item;
  readOnly?: boolean;
  docLinkRequest: DocLinkRequest | undefined;
  client: ReviewClient<Item> | undefined;
  drafts: DraftEdits;
  children?: ReactNode;
  close(): void;
  blockSwitching?(value: boolean): void;
  busy?(value: boolean): void;
  confirmed?(item: Item | null, receipt?: TaskReceipt, snapshot?: Snapshot): void | Promise<void>;
};
export function reviewDispositionLabel(state: Exclude<LinkedReview["state"], "active">, draft: boolean) {
  switch (state) {
    case "done":
      return draft ? "Sent" : "Suggestion accepted.";
    case "dropped":
      return draft ? "Draft dropped." : "Suggestion dropped.";
    case "replaced":
      return draft ? "Draft replaced." : "Suggestion replaced.";
  }
}

export function ReviewCard<Item extends ReviewItem>({
  item,
  readOnly = false,
  docLinkRequest,
  client,
  drafts,
  close,
  blockSwitching,
  busy,
  confirmed,
  children,
}: Props<Item>) {
  const engineDraftId = item.engine_marks ? draftReference(item)?.id : undefined;
  const legacyDraftId =
    item.review_reference?.kind === "reply_draft" && "source_id" in item && typeof item.source_id === "string"
      ? item.source_id
      : null;
  const draftId = engineDraftId ?? legacyDraftId;
  const edits = item.engine_marks ? drafts.engine : drafts.legacy;
  const [draftEdits, setDraftEdits] = useState(() => (draftId ? edits.read(draftId) : undefined));
  function updateDraftEdits(edit: DraftEdit | null) {
    if (!draftId) return;
    edits.write(draftId, edit);
    setDraftEdits(edit ?? undefined);
  }

  const [state, setState] = useState<State>({ phase: "loading" });
  const [reason, setReason] = useState("");
  const [drop, setDrop] = useState<{
    title: string;
    heading?: string;
    opener: HTMLButtonElement;
    confirm(reason: string): void;
  } | null>(null);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const host = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const draftSubject = useRef<HTMLInputElement>(null);
  const focusDraftSubject = useRef(false);
  const anchor = useRef(item);
  useEffect(() => {
    host.current?.focus();
    if (!client) return;
    const controller = new AbortController();
    alive.current = true;
    void client
      .load(anchor.current, controller.signal)
      .catch(async (error: unknown) => {
        const draft = draftReference(anchor.current);
        if (controller.signal.aborted || !draft || reviewError(error).kind !== "conflict") throw error;
        const current = await client.current(anchor.current);
        if (draftReference(current)?.id !== draft.id) throw error;
        const review = await client.load(current, controller.signal);
        if (!controller.signal.aborted) anchor.current = current;
        return review;
      })
      .then((review) => {
        if (controller.signal.aborted) return;
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
  }, [client]);
  const uncertain = state.phase === "uncertain";
  useLayoutEffect(() => {
    if (!uncertain) return;
    blockSwitching?.(true);
    return () => blockSwitching?.(false);
  }, [uncertain, blockSwitching]);
  const waiting = state.phase === "submitting" || lock.current;
  const review = "review" in state ? state.review : null;
  const thread = review && "thread" in review ? review.thread : undefined;
  const proposals = review && "proposals" in review ? (review.proposals ?? []) : [];
  const proposalLed = item.item_id.startsWith("suggestion:");
  const operations = readOnly ? [] : review?.operations;
  const savedDraft = review?.kind === "reply_draft" ? review : null;
  const engineReply = Boolean(item.engine_marks && savedDraft);
  const editOperation = savedDraft?.operations.find((op) => op.verb === "edit-email-draft");
  const canSaveDraft = Boolean(editOperation);
  const staleEdit =
    item.engine_marks &&
    canSaveDraft &&
    draftEdits &&
    savedDraft &&
    draftEdits.baseVersion !== savedDraft.reference.source_version
      ? draftEdits
      : null;
  useEffect(() => {
    if (savedDraft && engineDraftId && !canSaveDraft) {
      drafts.engine.write(engineDraftId, null);
      setDraftEdits(undefined);
    }
  }, [savedDraft, engineDraftId, canSaveDraft, drafts]);
  const editingDraft = Boolean(item.engine_marks && canSaveDraft && draftEdits && !staleEdit);
  const draft = (!item.engine_marks || editingDraft ? draftEdits : null) ?? savedDraft;

  function editDraft({ subject, body }: Pick<DraftEdit, "subject" | "body">) {
    if (savedDraft) updateDraftEdits({ subject, body, baseVersion: savedDraft.reference.source_version });
  }
  function beginDraftEdit(draft: Pick<DraftEdit, "subject" | "body">) {
    focusDraftSubject.current = true;
    editDraft(draft);
  }
  useLayoutEffect(() => {
    if (!editingDraft || !focusDraftSubject.current) return;
    focusDraftSubject.current = false;
    draftSubject.current?.focus();
  }, [editingDraft]);
  const canDeclineDraft = operations?.some((op) => op.verb === "dismiss-email-proposal");
  const editable =
    !readOnly && (state.phase === "ready" || state.phase === "editing" || state.phase === "proposal-refused");
  async function reload() {
    if (!client || lock.current) return;
    lock.current = true;
    busy?.(true);
    setMessage("Loading the updated card. Your edits are kept.");
    try {
      const current = await client.current(anchor.current);
      if (engineDraftId && draftReference(current)?.id !== engineDraftId)
        throw Object.assign(Error("The draft changed."), { payload: { error: "version_conflict" } });
      const updated = await client.load(current);
      if (!alive.current) return;
      anchor.current = current;
      await confirmed?.(current);
      if (!alive.current) return;
      setState({ phase: "ready", review: updated });
      setMessage(
        "Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.",
      );
    } catch (error) {
      if (alive.current) setMessage(reviewError(error).message);
    } finally {
      lock.current = false;
      busy?.(false);
    }
  }
  async function run(request: ReviewRequest, detail: Review) {
    if (!client || lock.current) return;
    lock.current = true;
    busy?.(true);
    setState({ phase: "submitting", review: detail, request });
    setMessage("Waiting for server confirmation…");
    try {
      const result = await client.run(anchor.current, request);
      if (!alive.current) return;
      if (request.verb === "submit-email-draft" || request.verb === "dismiss-email-proposal") updateDraftEdits(null);
      await confirmed?.(result.item, result.receipt, result.snapshot);
      if (!alive.current) return;
      if (
        request.verb === "decide-engine-home-proposal" &&
        result.item &&
        (detail.kind === "reply_draft" || !result.snapshot)
      ) {
        if (detail.kind === "reply_draft") {
          const before = draftReference(anchor.current);
          const after = draftReference(result.item);
          if (!before || after?.id !== before.id || after.version !== before.version)
            throw Object.assign(Error("The draft changed."), { payload: { error: "version_conflict" } });
        }
        const refreshed = await client.load(result.item);
        if (!alive.current) return;
        anchor.current = result.item;
        setState({ phase: "ready", review: refreshed });
        if (request.args.decision === "dismiss") host.current?.focus();
        setMessage(
          result.alreadyResolved
            ? ""
            : reviewDispositionLabel(request.args.decision === "accept" ? "done" : "dropped", false),
        );
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
        updateDraftEdits(null);
        setState({ phase: "ready", review: next });
        if (item.engine_marks) host.current?.focus();
        setMessage("Saved as a draft. Nothing was sent.");
      } else {
        setState({
          phase: "done",
          message:
            request.verb === "submit-email-draft"
              ? item.engine_marks
                ? "Sending"
                : "Reply submitted to the existing sender. Delivery is not yet confirmed."
              : request.verb === "decide-engine-home-proposal"
                ? result.alreadyResolved
                  ? "This review is finished."
                  : reviewDispositionLabel(request.args.decision === "accept" ? "done" : "dropped", false)
                : request.verb === "dismiss-email-proposal" && item.engine_marks
                  ? reviewDispositionLabel("dropped", true)
                  : "This card is confirmed. Its current state is shown in your inbox.",
        });
        setMessage("");
      }
    } catch (error) {
      if (!alive.current) return;
      const refusal = request.verb === "decide-engine-home-proposal" ? proposalRefusal(error) : null;
      if (refusal) {
        const { id, decision, deal_id } = request.args;
        const filing = typeof deal_id === "string" ? filingReasonRefusal(error, deal_id) : null;
        setMessage("");
        setState(
          decision === "accept" && typeof id === "string"
            ? { phase: "proposal-refused", review: detail, message: refusal, id, filing }
            : { phase: "refused", message: refusal },
        );
        if (!filing) host.current?.focus();
        return;
      }
      const failure = reviewError(error);
      setMessage("");
      if (failure.kind === "uncertain") setState({ phase: "uncertain", review: detail, request });
      else if (failure.kind === "conflict") setState({ phase: "conflict", review: detail, message: failure.message });
      else setState({ phase: "refused", message: failure.message });
    } finally {
      lock.current = false;
      busy?.(false);
    }
  }
  function choose(op: Operation, dropReason?: string) {
    if (!review || !editable || lock.current || !form.current) return;
    if (writesDraftText(op.verb) && staleEdit) return;
    if (op.verb !== "dismiss-email-proposal" && !form.current.reportValidity()) return;
    let input: Record<string, unknown> = {};
    if (writesDraftText(op.verb) && draft)
      input = {
        subject: draft.subject,
        body: draft.body,
        ...(op.verb === "submit-email-draft" &&
          review.kind === "reply_draft" &&
          review.attachments && { document_ids: review.attachments.map((row) => row.id) }),
      };
    if (op.verb === "dismiss-email-proposal") {
      const explanation = dropReason ?? reason.trim();
      if (!explanation) {
        setMessage("Give a reason before declining this draft.");
        return;
      }
      input = { reason: explanation };
    }
    void run({ verb: op.verb, args: { ...op.args, ...input, idempotency_key: crypto.randomUUID() } }, review);
  }
  function decideSuggestion(
    proposal: Suggestion,
    decision: "accept" | "dismiss",
    reason?: string,
    destination?: FilingDestination,
  ) {
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
          ...(reason && { reason }),
          ...destination,
          idempotency_key: crypto.randomUUID(),
          ...(edits && { edits: { what, due_on: fields.get(`${proposal.id}-date`) || null } }),
        },
      },
      review,
    );
  }
  function canAcceptSuggestion(proposal: Suggestion) {
    return proposal.canAccept && !(state.phase === "proposal-refused" && state.id === proposal.id);
  }
  function suggestionDecisions(proposal: Suggestion): readonly ("accept" | "dismiss")[] {
    if (readOnly || proposal.filingChoices) return [];
    return !item.engine_marks || proposal.completion || item.home_proposal_drop ? ["accept", "dismiss"] : ["accept"];
  }
  const suggestionFields = (
    <>
      {review?.kind === "reply_draft" && proposals.length > 0 && <h4>Suggestions</h4>}
      {proposals.length > 0 &&
        proposals.map((proposal) => (
          <section key={proposal.id} aria-label={proposal.label}>
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
                {proposal.emailLead && proposal.senderAddress && <p>{proposal.senderAddress}</p>}
                {proposal.source.excerpt && <blockquote>{sourceExcerptText(proposal.source.excerpt)}</blockquote>}
              </>
            )}
            {proposal.reason &&
              (proposal.source ? (
                <>
                  <p>{proposal.emailLead ? "Summary" : "Words that prompted this suggestion"}</p>
                  <blockquote>{proposal.reason}</blockquote>
                </>
              ) : (
                <p>{proposal.reason}</p>
              ))}
            {proposal.editable ? (
              <>
                <label>
                  Next step
                  <textarea
                    className="home-suggestion-instruction"
                    name={`${proposal.id}-what`}
                    defaultValue={proposal.what ?? ""}
                    onKeyDown={(event) => {
                      if (editable && !proposal.filingChoices && canAcceptSuggestion(proposal))
                        submitOnEnter(event.nativeEvent, () => decideSuggestion(proposal, "accept"));
                    }}
                  />
                </label>
                <label>
                  Due date <input type="date" name={`${proposal.id}-date`} defaultValue={proposal.dueOn ?? ""} />
                </label>
              </>
            ) : (
              proposal.what && <p>{proposal.what}</p>
            )}
            {!readOnly && !proposal.canAccept && (
              <p>This step changed after the suggestion. Mark it done from the step, or choose Not yet.</p>
            )}
            {proposal.filingChoices && !readOnly && client && (
              <FilingControls
                proposalId={proposal.id}
                checkReason={client.checkFilingReason}
                choices={proposal.filingChoices}
                askDocHref={
                  editable && docLinkRequest && proposal.filingEmailId
                    ? `/doc-chats?${new URLSearchParams({ email: proposal.filingEmailId })}#${new URLSearchParams({
                        question: "Where should I file this email?",
                      })}`
                    : undefined
                }
                refusal={state.phase === "proposal-refused" && state.id === proposal.id ? state.filing : null}
                file={(destination, reason) => decideSuggestion(proposal, "accept", reason, destination)}
                dismiss={(opener) =>
                  setDrop({
                    title: proposal.label.toLowerCase(),
                    heading: "Drop this filing suggestion?",
                    opener,
                    confirm: (reason) => decideSuggestion(proposal, "dismiss", reason),
                  })
                }
              />
            )}
            <div className="inbox-actions">
              {suggestionDecisions(proposal).map((decision) => (
                <button
                  key={decision}
                  type="button"
                  disabled={decision === "accept" && !canAcceptSuggestion(proposal)}
                  onClick={(event) => {
                    if (item.engine_marks && decision === "dismiss" && !proposal.completion) {
                      setDrop({
                        title: proposal.label.toLowerCase(),
                        opener: event.currentTarget,
                        confirm: (reason) => decideSuggestion(proposal, decision, reason),
                      });
                    } else decideSuggestion(proposal, decision);
                  }}
                >
                  {proposal.completion
                    ? decision === "accept"
                      ? "Yes, it’s done"
                      : "Not yet"
                    : decision === "accept"
                      ? "Accept"
                      : item.engine_marks
                        ? "Drop"
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
        if (event.key === "Escape" && !drop && !waiting && state.phase !== "uncertain") {
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
      {thread &&
        (thread.messages.length ? (
          <section className="home-email-thread" aria-label="Email thread">
            <h4>Email thread</h4>
            {thread.subject && <p>{sourceExcerptText(thread.subject)}</p>}
            {thread.messages.map(({ id, sender, occurredAt, body, folded }) => (
              <article key={id}>
                <h5>
                  From {sender || "unknown sender"} ·{" "}
                  <time dateTime={occurredAt}>{threadDate.format(new Date(occurredAt))}</time>
                </h5>
                <p>{sourceExcerptText(body)}</p>
                {folded !== null && <EarlierText text={folded} />}
              </article>
            ))}
          </section>
        ) : (
          <p>The original email is unavailable.</p>
        ))}
      {review?.kind === "reply_draft" &&
        !thread &&
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
            <blockquote>{sourceExcerptText(review.email.excerpt)}</blockquote>
          </section>
        ) : (
          <p>The original email is unavailable.</p>
        ))}
      {client && state.phase === "loading" && <p role="status">Loading current evidence…</p>}
      {(state.phase === "refused" || state.phase === "done") && <p role="status">{state.message}</p>}
      {state.phase === "proposal-refused" && !state.filing && <p role="alert">{state.message}</p>}
      {review && (
        <form
          ref={form}
          onSubmit={(event) => event.preventDefault()}
          onChange={() => {
            if (state.phase === "ready") setState({ phase: "editing", review });
            setMessage("");
          }}
        >
          {engineReply && proposalLed && proposals.length > 0 && (
            <fieldset disabled={!editable}>{suggestionFields}</fieldset>
          )}
          <fieldset disabled={!editable}>
            <legend className={engineReply ? "home-reply-label" : undefined}>
              {review.kind === "reply_draft"
                ? engineReply
                  ? "Your reply"
                  : proposalLed
                    ? "Suggestions and reply draft"
                    : "Exact reply for review"
                : review.kind === "suggestions"
                  ? "Suggestions"
                  : "Task"}
            </legend>
            {review.kind === "action" && <p>{review.title}</p>}
            {proposalLed && !engineReply && suggestionFields}
            {review.kind === "reply_draft" && draft && (
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
                {!item.engine_marks && (
                  <details>
                    <summary>Current saved reply</summary>
                    <p>{review.subject}</p>
                    <p>{review.body}</p>
                  </details>
                )}
                {!item.engine_marks || editingDraft ? (
                  <>
                    <label>
                      Subject
                      <input
                        ref={draftSubject}
                        value={draft.subject}
                        disabled={!review.operations.length}
                        onChange={(event) => editDraft({ subject: event.target.value, body: draft.body })}
                        maxLength={998}
                        required
                      />
                    </label>
                    <label>
                      Message
                      <textarea
                        aria-label="Message"
                        value={draft.body}
                        disabled={!review.operations.length}
                        onChange={(event) => editDraft({ subject: draft.subject, body: event.target.value })}
                        rows={8}
                        maxLength={20000}
                        required
                      />
                    </label>
                  </>
                ) : (
                  <div className={staleEdit ? "home-draft-comparison" : undefined}>
                    <div>
                      {staleEdit && <h4>Saved draft</h4>}
                      <p>
                        <strong>{draft.subject}</strong>
                      </p>
                      <p>{draft.body}</p>
                    </div>
                    {staleEdit && (
                      <section aria-label="Your unsaved edit">
                        <h4>Your unsaved edit</h4>
                        <p>
                          <strong>{staleEdit.subject}</strong>
                        </p>
                        <p>{staleEdit.body}</p>
                        <div className="inbox-actions">
                          {canSaveDraft && (
                            <button type="button" onClick={() => beginDraftEdit(staleEdit)}>
                              Use my edit
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              updateDraftEdits(null);
                              host.current?.focus();
                            }}
                          >
                            Discard
                          </button>
                        </div>
                      </section>
                    )}
                  </div>
                )}
                {!item.engine_marks && canSaveDraft && (
                  <p>
                    Save draft sends nothing. Submit reply authorizes the existing sender to send this exact content to
                    these recipients.
                  </p>
                )}
                {canDeclineDraft && !item.engine_marks && (
                  <label>
                    Reason for declining
                    <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
                  </label>
                )}
              </>
            )}
          </fieldset>
          <div className="inbox-actions">
            {operations?.map((op) => {
              const startDraftEdit = item.engine_marks && op.verb === "edit-email-draft" && !editingDraft && !staleEdit;
              return (
                <button
                  type="button"
                  key={op.verb}
                  disabled={!editable || Boolean(staleEdit && writesDraftText(op.verb))}
                  onClick={(event) => {
                    if (startDraftEdit && draft) beginDraftEdit(draft);
                    else if (item.engine_marks && op.verb === "dismiss-email-proposal")
                      setDrop({ title: "draft", opener: event.currentTarget, confirm: (reason) => choose(op, reason) });
                    else choose(op);
                  }}
                >
                  {startDraftEdit
                    ? "Edit"
                    : item.engine_marks && op.verb === "dismiss-email-proposal"
                      ? "Drop"
                      : item.engine_marks && op.verb === "submit-email-draft"
                        ? "Send reply"
                        : labels[op.verb]}
                </button>
              );
            })}
            {engineReply && editable && !draftEdits && editOperation && (
              <TalkToDoc
                request={docLinkRequest}
                href={`/doc-chats?${new URLSearchParams({
                  draft: String(editOperation.args.proposal_id),
                  version: String(editOperation.args.base_version),
                })}`}
              />
            )}
          </div>
          {!proposalLed && proposals.length > 0 && <fieldset disabled={!editable}>{suggestionFields}</fieldset>}
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
      {drop && (
        <DropReason
          title={drop.title}
          {...(drop.heading && { heading: drop.heading })}
          cancel={() => {
            drop.opener.focus();
            setDrop(null);
          }}
          confirm={(reason) => {
            setDrop(null);
            drop.confirm(reason);
          }}
        />
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
