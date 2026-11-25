import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { centralToday } from "./central-time";
import { docLinkMessages } from "./doc-link";
import { refreshWhileVisible } from "./visible-refresh";

// The app's Content Security Policy blocks dynamic code evaluation.
z.config({ jitless: true });

const recordRef = z.object({
  kind: z.enum(["deal", "lead", "client", "email"]),
  id: z.guid(),
});
const draftRef = z.object({ kind: z.literal("reply_draft"), id: z.guid() });
const draftVersion = z.int().positive();
const draftRequest = draftRef.extend({ version: draftVersion });
const draftContext = draftRequest.extend({ activity_id: z.guid(), mailbox_user_id: z.guid() });
const source = z.object({
  ref: z.union([recordRef, draftRef]),
  label: z.string(),
  href: z.string(),
});
const noteFields = z.object({ text: z.string() });
const stepFields = z.object({ what: z.string(), due_on: z.iso.date().nullable() });
const replyFields = z.object({ subject: z.string(), body: z.string() });
const revisionFields = replyFields.partial();
const revisionTarget = source.extend({ ref: draftRef, version: draftVersion });
const proposal = z.discriminatedUnion("kind", [
  noteFields.extend({ kind: z.literal("note"), target: source }),
  stepFields.extend({ kind: z.literal("next_step"), target: source }),
  replyFields.extend({ kind: z.literal("reply_draft"), target: source }),
  revisionFields
    .extend({ kind: z.literal("reply_revision"), target: revisionTarget })
    .refine(({ subject, body }) => subject !== undefined || body !== undefined),
]);
const proposalDraft = z.object({
  edits: z.union([noteFields, stepFields, revisionFields]),
  idempotency_key: z.guid().optional(),
});
const answer = z.object({
  kind: z.enum(["answer", "clarification", "refusal"]),
  text: z.string(),
  sources: z.array(source),
  proposal: proposal.nullable(),
});
const confirmation = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["note", "next_step"]), id: z.guid(), href: z.string() }),
  z.object({ kind: z.literal("reply_draft"), id: z.guid(), href: z.string(), existing: z.boolean() }),
  z.object({ kind: z.literal("reply_revision"), id: z.guid(), href: z.string(), version: draftVersion }),
]);
const conversation = z.object({
  id: z.guid(),
  title: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
const draftReview = z.object({
  draft_id: z.guid(),
  version: draftVersion,
  current: z.enum(["pending_same", "changed", "gone"]),
});
const chatTurn = z.object({
  id: z.guid(),
  position: z.int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  question: z.string(),
  idempotency_key: z.guid(),
  context: z.union([recordRef, draftContext]).nullable(),
  draft_review: draftReview.nullable(),
  state: z.enum(["queued", "working", "failed", "answered"]),
  answer: answer.nullable(),
  answered_by: z.string().nullable().optional(),
  confirmation: confirmation.nullable(),
  waiting_reason: z
    .enum([
      docLinkMessages.not_set_up,
      docLinkMessages.mac_off,
      docLinkMessages.signed_out,
      docLinkMessages.plan_limited,
      "Doc is waiting for a free slot on your Mac.",
    ])
    .nullable(),
});
const conversationList = z.object({ conversations: z.array(conversation), next_before: z.guid().nullable() });
const conversationDetail = z.object({ conversation, turns: z.array(chatTurn) });
const sendResponse = z.object({ conversation_id: z.guid(), turn: chatTurn });

type Conversation = z.infer<typeof conversation>;
type Turn = z.infer<typeof chatTurn>;
type Proposal = z.infer<typeof proposal>;
type Confirmation = z.infer<typeof confirmation>;
type ProposalDraft = z.infer<typeof proposalDraft>;
type DraftField = "doc-question" | "doc-proposal";
type Ask = Pick<Turn, "question" | "idempotency_key"> & {
  conversation_id?: string;
  context?: z.infer<typeof recordRef> | z.infer<typeof draftRequest>;
};
type Session = {
  verify(options: { fresh: boolean; waitForBudget?: boolean }): Promise<{ actor: { slug: string } }>;
  fetch(path: string, init: RequestInit, options: { boundRead: boolean; waitForBudget: boolean }): Promise<Response>;
};

type TextDraft = { read(): string; write(text: string): void };

function sessionModule(): Promise<{
  privateSession(): Session | null;
  privateTextDraft(window: Window, actor: string, field: DraftField, id: string | null): TextDraft;
}> {
  return import(new URL("./private-session.js", import.meta.url).href);
}

const api = "/api/engine/doc";
const questionLimit = 4000;
const params = new URLSearchParams(location.search);
const legacyPath = /^\/doc\/conversations\/([^/]+)\/turns\/([^/]+)$/.exec(location.pathname);
const legacyLink = params.has("id") || Boolean(legacyPath);
const initialId = legacyPath?.[1] ?? params.get("id") ?? params.get("chat");
const initialDraft = initialId
  ? undefined
  : draftRequest.safeParse({
      kind: "reply_draft",
      id: params.get("draft"),
      version: Number(params.get("version")),
    }).data;
const invoiceDeal = recordRef.safeParse({ kind: "deal", id: params.get("deal") }).data;
const invoiceKey = params.get("invoice");
const initialInvoice =
  !initialId &&
  !initialDraft &&
  invoiceDeal &&
  invoiceKey &&
  (z.guid().safeParse(invoiceKey).success || invoiceKey === `awaiting:${invoiceDeal.id}`)
    ? { key: invoiceKey, deal: invoiceDeal }
    : undefined;
const initialEmail =
  !initialId && !initialDraft && !initialInvoice
    ? recordRef.safeParse({ kind: "email", id: params.get("email") }).data
    : undefined;
const initialContext = initialDraft ?? initialInvoice?.deal ?? initialEmail;
const composerId = initialDraft?.id ?? initialInvoice?.key ?? initialEmail?.id ?? null;
const draftChangeText = {
  changed: "This draft has a newer revision.",
  gone: "This draft is no longer pending.",
};
const statusText = {
  signIn: "Sign in again to open your chats.",
  loadFailed: "Chats couldn’t be loaded.",
  sendFailed: "The question couldn’t be sent. Try again.",
  unavailable: "Conversation unavailable",
  older: "This older conversation wasn't kept",
};
const stateText = {
  queued: "Doc is waiting.",
  working: "Doc is working.",
  answered: "Answered",
  failed: "Doc couldn’t answer.",
};

function chatHref(id: string | null) {
  const query = new URLSearchParams(location.search);
  query.delete("id");
  query.delete("draft");
  query.delete("version");
  query.delete("invoice");
  query.delete("deal");
  query.delete("email");
  if (id) query.set("chat", id);
  else query.delete("chat");
  return "/doc-chats" + (query.size ? `?${query}` : "");
}

const chatDay = (date: Date) => Date.parse(centralToday(date)) / 86_400_000;
const centralFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", ...options });
const chatTimes = {
  today: centralFormat({ hour: "numeric", minute: "2-digit" }),
  week: centralFormat({ weekday: "short" }),
  year: centralFormat({ month: "short", day: "numeric" }),
  older: centralFormat({ month: "short", day: "numeric", year: "numeric" }),
};

function chatTime(at: string, now: Date) {
  const date = new Date(at);
  const days = chatDay(now) - chatDay(date);
  const format =
    days === 0
      ? chatTimes.today
      : days > 0 && days < 7
        ? chatTimes.week
        : centralToday(date).slice(0, 4) === centralToday(now).slice(0, 4)
          ? chatTimes.year
          : chatTimes.older;
  return format.format(date);
}

function Icon({ path }: { path: string }) {
  return (
    <svg className="app-shell-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const icons = {
  chats: "M4 5h16v14H4zM9 5v14",
  newChat: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z",
};
const topbar = document.getElementById("docTopbar");
const topbarStart = document.getElementById("docTopbarStart");
const topbarTitle = document.getElementById("docTitle");

function draftReviewHref(id: string) {
  return `/inbox/card/${encodeURIComponent(`reply_draft:${id}`)}`;
}

function conversationPath(id: string) {
  return `/conversations/${encodeURIComponent(id)}`;
}

function recordHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//") && !/[\\\s]/.test(href) ? href : undefined;
}

class ConversationUnavailable extends Error {}

class DocRequestFailed extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Doc request failed with status ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

async function docFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  { body, signal, boundRead = false }: { body?: object; signal?: AbortSignal; boundRead?: boolean } = {},
): Promise<T> {
  const { privateSession } = await sessionModule();
  const session = privateSession();
  if (!session) throw Error(statusText.signIn);
  signal?.throwIfAborted();
  const waitForBudget = Boolean(body);
  if (!boundRead) await session.verify({ fresh: true, waitForBudget });
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(12000);
  const response = await session.fetch(
    api + path,
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body && {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    },
    { boundRead, waitForBudget },
  );
  signal?.throwIfAborted();
  const unavailable = response.status === 404 && path.startsWith("/conversations/");
  if (!boundRead || unavailable) await session.verify({ fresh: true, waitForBudget });
  signal?.throwIfAborted();
  if (unavailable) throw new ConversationUnavailable();
  if (!response.ok) throw new DocRequestFailed(response.status, await response.json().catch(() => null));
  const result = schema.safeParse(await response.json());
  if (!result.success) throw Error("Invalid Doc response");
  return result.data;
}

const proposalCopy = {
  note: { save: "Save note", saved: "Note saved.", open: "Open saved note" },
  next_step: { save: "Save next step", saved: "Next step saved.", open: "Open saved next step" },
  reply_draft: { save: "Save draft and open review", saved: "Reply draft saved.", open: "Open reply review" },
  reply_revision: { save: "Save revision", saved: "Reply revision saved.", open: "Open reply review" },
};

function keptSavedDraft(result: Confirmation) {
  return result.kind === "reply_draft" && result.existing;
}

function SavedProposal({ result }: { result: Confirmation }) {
  const href = recordHref(result.href);
  const { saved, open } = proposalCopy[result.kind];
  const status = keptSavedDraft(result) ? "Opened your saved draft. Doc’s new wording wasn’t used." : !href && saved;
  return (
    <p>
      {status}
      {status && href && " "}
      {href && (
        <a className="doc-chat__action" href={href}>
          {open}
        </a>
      )}
    </p>
  );
}

function readProposalDraft(storage: TextDraft, suggestion: Proposal): ProposalDraft {
  const { kind, target, ...initial } = suggestion;
  const schema = {
    note: noteFields,
    next_step: stepFields,
    reply_draft: replyFields,
    reply_revision: revisionFields,
  }[kind];
  const stored = storage.read();
  if (stored) {
    try {
      const draft = proposalDraft.extend({ edits: schema }).safeParse(JSON.parse(stored));
      if (draft.success) return draft.data;
    } catch {
      return { edits: initial };
    }
  }
  return { edits: initial };
}

const saveResponse = z.object({ result: confirmation });
const saveRefusal = z.object({
  error: z.string(),
  href: z.string().optional(),
  fields: z.array(z.string()).optional(),
  hint: z.string().optional(),
  next_step_id: z.guid().nullish(),
});
const saveUncertain = "Doc couldn’t tell if this saved. Try again.";

function draftConflict(error: unknown) {
  if (!(error instanceof DocRequestFailed) || error.status !== 409) return;
  const code = saveRefusal.safeParse(error.payload).data?.error;
  if (code === "version_conflict") return "changed";
  if (code === "draft_changed") return "gone";
}

function proposalRefusal(error: DocRequestFailed, draftId?: string) {
  const conflict = draftId && draftConflict(error);
  if (conflict) {
    return {
      text: draftChangeText[conflict],
      link: { href: draftReviewHref(draftId), label: "Open fresh review" },
      requiresReview: true,
    };
  }
  const refusal = saveRefusal.safeParse(error.payload).data;
  const messages = new Map([
    ["subject", "Keep the subject under 998 characters."],
    ["body", "Enter a reply."],
    ["text", "Enter the note."],
    ["what", "Enter the next step."],
    ["due_on", "Choose a valid due date."],
  ]);
  if (refusal?.fields?.length && refusal.fields.every((field) => messages.has(field))) {
    return { text: refusal.fields.map((field) => messages.get(field)).join(" "), fields: refusal.fields };
  }
  if (error.status === 404) return { text: "This record is no longer available." };
  switch (refusal?.error) {
    case "open_step_exists": {
      const href = refusal.href && recordHref(refusal.href);
      return {
        text: "You already have an open next step on this record.",
        link: href ? { href, label: refusal.next_step_id ? "Open existing next step" : "Open record" } : undefined,
      };
    }
    case "target_changed":
      return { text: "This record has changed. Open the record or ask Doc again." };
    case "already_confirmed":
    case "key_reuse":
      return { text: "Reload this chat to check whether this suggestion was saved." };
    default:
      return { text: "Doc couldn’t save this. Check your edits and try again." };
  }
}

function ProposalEditor({
  turnId,
  suggestion,
  storage,
  onSaved,
}: {
  turnId: string;
  suggestion: Proposal;
  storage: TextDraft;
  onSaved: (result: Confirmation) => void;
}) {
  const [draft, setDraft] = useState(() => readProposalDraft(storage, suggestion));
  const [notice, setNotice] = useState<ReturnType<typeof proposalRefusal> | null>(() =>
    draft.idempotency_key ? { text: saveUncertain } : null,
  );
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  const fieldId = useId();
  const { edits, idempotency_key } = draft;
  const { target, kind } = suggestion;
  const targetHref = recordHref(target.href);

  useEffect(() => () => request.current?.abort(), []);

  function writeDraft(next: ProposalDraft) {
    setDraft(next);
    storage.write(JSON.stringify(next));
  }

  async function save() {
    if (request.current) return;
    if ("body" in edits && edits.body !== undefined && !edits.body.trim()) {
      setNotice({ text: "Enter a reply.", fields: ["body"] });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const body = { edits, idempotency_key: idempotency_key ?? crypto.randomUUID() };
    writeDraft(body);
    setSaving(true);
    setNotice(null);
    try {
      const { result } = await docFetch(`/turns/${encodeURIComponent(turnId)}/confirmation`, saveResponse, {
        body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.kind !== kind || (result.kind === "reply_revision" && result.id !== target.ref.id))
        throw Error("Invalid Doc confirmation");
      storage.write("");
      onSaved(result);
      const href = recordHref(result.href);
      // A kept saved draft stays on the chat so the partner reads that Doc's wording was not used.
      if ((result.kind === "reply_draft" || result.kind === "reply_revision") && href && !keptSavedDraft(result))
        location.assign(href);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof DocRequestFailed && error.status >= 400 && error.status < 500 && error.status !== 429) {
        writeDraft({ edits });
        setNotice(proposalRefusal(error, kind === "reply_revision" ? target.ref.id : undefined));
      } else {
        setNotice({ text: saveUncertain });
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  function fieldNotice(field: string) {
    return notice?.fields?.includes(field) ? <p role="alert">{notice.text}</p> : null;
  }

  return (
    <form
      className="doc-chat__proposal"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p>For {targetHref ? <a href={targetHref}>{target.label}</a> : target.label}</p>
      <fieldset disabled={Boolean(idempotency_key)}>
        {"text" in edits ? (
          <>
            <label htmlFor={fieldId}>Note</label>
            <textarea
              id={fieldId}
              required
              maxLength={4000}
              value={edits.text}
              onChange={(event) => writeDraft({ edits: { text: event.currentTarget.value } })}
            />
            {fieldNotice("text")}
          </>
        ) : "what" in edits ? (
          <>
            <label htmlFor={fieldId}>Next step</label>
            <textarea
              id={fieldId}
              required
              maxLength={4000}
              value={edits.what}
              onChange={(event) => writeDraft({ edits: { ...edits, what: event.currentTarget.value } })}
            />
            {fieldNotice("what")}
            <p>Owner: You</p>
            <label htmlFor={`${fieldId}-date`}>Due date</label>
            <input
              id={`${fieldId}-date`}
              type="date"
              value={edits.due_on ?? ""}
              onChange={(event) => writeDraft({ edits: { ...edits, due_on: event.currentTarget.value || null } })}
            />
            {fieldNotice("due_on")}
          </>
        ) : (
          <>
            {edits.subject !== undefined && (
              <>
                <label htmlFor={`${fieldId}-subject`}>Subject</label>
                <input
                  id={`${fieldId}-subject`}
                  required
                  type="text"
                  maxLength={998}
                  value={edits.subject}
                  onChange={(event) => writeDraft({ edits: { ...edits, subject: event.currentTarget.value } })}
                />
                {fieldNotice("subject")}
              </>
            )}
            {edits.body !== undefined && (
              <>
                <label htmlFor={fieldId}>Reply</label>
                <textarea
                  id={fieldId}
                  required
                  value={edits.body}
                  onChange={(event) => writeDraft({ edits: { ...edits, body: event.currentTarget.value } })}
                />
                {fieldNotice("body")}
              </>
            )}
          </>
        )}
      </fieldset>
      {notice && !notice.fields && (
        <p role="alert">
          {notice.text} {notice.link && <a href={notice.link.href}>{notice.link.label}</a>}
        </p>
      )}
      <button className="btn" type="submit" disabled={saving || notice?.requiresReview}>
        {saving ? "Saving…" : idempotency_key ? "Retry save" : proposalCopy[kind].save}
      </button>
    </form>
  );
}

function DocChat() {
  const [id, setId] = useState(initialId);
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [olderFailed, setOlderFailed] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const privateDraft = useRef<((field: DraftField, id: string | null) => TextDraft) | null>(null);
  const [pendingAsk, setPendingAsk] = useState<Ask | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<keyof typeof statusText | null>(null);
  const [draftSendConflict, setDraftSendConflict] = useState<keyof typeof draftChangeText>();
  const retired = useRef(false);
  const active = useRef(false);
  const conversationPane = useRef<HTMLDivElement>(null);
  const chatsPanel = useRef<HTMLElement>(null);
  const chatsToggle = useRef<HTMLButtonElement>(null);
  const latest = turns.at(-1);
  const review = latest?.draft_review;
  const draftId = review?.draft_id ?? initialDraft?.id;
  const draftStatus = latest?.state === "failed" ? review?.current : undefined;
  const reviewReason = draftStatus === "changed" || draftStatus === "gone" ? draftStatus : draftSendConflict;
  const notice = status ? statusText[status] : reviewReason && draftChangeText[reviewReason];
  const waiting = latest?.state === "queued" || latest?.state === "working";
  const waitingTurnId = waiting ? latest.id : undefined;
  const getWaitingReason = useEffectEvent(() => latest?.waiting_reason);
  const retry =
    pendingAsk ??
    (latest?.state === "failed"
      ? {
          question: latest.question,
          idempotency_key: latest.idempotency_key,
          // The engine hashes the first ask without a conversation ID.
          ...(latest.position > 1 && id ? { conversation_id: id } : {}),
          ...(latest.context?.kind === "reply_draft"
            ? latest.position === 1 && { context: draftRequest.parse(latest.context) }
            : latest.context && { context: latest.context }),
        }
      : null);
  const questionLength = [...question].length;
  const canSend =
    ready &&
    !busy &&
    !waiting &&
    !reviewReason &&
    status !== "loadFailed" &&
    !pendingAsk &&
    question.trim().length > 0 &&
    questionLength <= questionLimit &&
    !question.includes("\0");

  const showUnavailable = useCallback(() => {
    setTurns([]);
    setReady(false);
    setStatus(legacyLink ? "older" : "unavailable");
  }, []);

  const run = useCallback(
    async (operation: "load" | "send", work: () => Promise<void>) => {
      if (active.current || retired.current) return;
      active.current = true;
      setBusy(true);
      setStatus(null);
      try {
        await work();
      } catch (error) {
        if (retired.current) return;
        if (error instanceof ConversationUnavailable) {
          showUnavailable();
        } else {
          setStatus(operation === "load" ? "loadFailed" : "sendFailed");
        }
      } finally {
        active.current = false;
        if (!retired.current) setBusy(false);
      }
    },
    [showUnavailable],
  );

  const load = useCallback(
    async (chatId: string | null) => {
      await run("load", async () => {
        const { conversations, next_before } = await docFetch("/conversations", conversationList);
        if (retired.current) return;
        setRecent(conversations);
        setNextBefore(next_before);
        const detail = chatId ? await docFetch(conversationPath(chatId), conversationDetail) : null;
        if (retired.current) return;
        const { privateSession, privateTextDraft } = await sessionModule();
        const session = await privateSession()?.verify({ fresh: false });
        if (retired.current || !session) return;
        const actor = session.actor.slug;
        const storage = (field: DraftField, id: string | null) => privateTextDraft(window, actor, field, id);
        privateDraft.current = storage;
        setTurns(detail?.turns ?? []);
        setTitle(detail?.conversation.title ?? "");
        const draft = storage("doc-question", chatId ?? composerId);
        const savedQuestion = draft.read();
        const prefill =
          !chatId && (initialInvoice || initialEmail)
            ? new URLSearchParams(location.hash.slice(1)).get("question")
            : null;
        const question = initialEmail && savedQuestion ? savedQuestion : prefill || savedQuestion;
        if (prefill) {
          if (question !== savedQuestion) draft.write(question);
          history.replaceState(history.state, "", location.pathname + location.search);
        }
        setQuestion(question);
        setReady(true);
      });
    },
    [run],
  );

  useEffect(() => {
    function clear() {
      retired.current = true;
      privateDraft.current = null;
      setId(null);
      setRecent([]);
      setNextBefore(null);
      setTurns([]);
      setTitle("");
      setQuestion("");
      setPendingAsk(null);
      setDraftSendConflict(undefined);
      setReady(false);
      setBusy(false);
      setStatus("signIn");
    }
    window.addEventListener("doctorcre-session-invalidated", clear);
    void load(initialId);
    return () => window.removeEventListener("doctorcre-session-invalidated", clear);
  }, [load]);

  useEffect(() => {
    if (!id || !waitingTurnId || retired.current) return;
    let waitingReason = getWaitingReason();
    const stop = refreshWhileVisible(
      async (signal) => {
        try {
          const { turns: saved } = await docFetch(conversationPath(id), conversationDetail, {
            signal,
            boundRead: true,
          });
          if (signal.aborted || retired.current) return;
          const turn = saved.find((row) => row.id === waitingTurnId);
          if (!turn) return;
          waitingReason = turn.waiting_reason;
          setTurns((rows) => rows.map((row) => (row.id === turn.id ? turn : row)));
          if (turn.state !== "queued" && turn.state !== "working") return "stop";
        } catch (error) {
          if (!(error instanceof ConversationUnavailable) || signal.aborted || retired.current) return;
          showUnavailable();
          return "stop";
        }
      },
      {
        immediate: false,
        delay(visibleMs) {
          if (visibleMs < 60_000) return 5_000;
          return waitingReason === docLinkMessages.mac_off || waitingReason === docLinkMessages.plan_limited
            ? 120_000
            : 30_000;
        },
      },
    );
    window.addEventListener("doctorcre-session-invalidated", stop, { once: true });
    return () => {
      window.removeEventListener("doctorcre-session-invalidated", stop);
      stop();
    };
  }, [id, waitingTurnId, showUnavailable]);

  useEffect(() => {
    const panel = chatsPanel.current;
    if (chatsOpen) (panel?.querySelector<HTMLElement>("[aria-current]") ?? panel?.querySelector("a"))?.focus();
  }, [chatsOpen]);

  function closeChats() {
    setChatsOpen(false);
    chatsToggle.current?.focus();
  }

  function loadOlder() {
    if (!nextBefore) return;
    void run("load", async () => {
      try {
        const page = await docFetch(`/conversations?before=${encodeURIComponent(nextBefore)}`, conversationList);
        if (retired.current) return;
        setRecent((rows) => [...rows, ...page.conversations]);
        setNextBefore(page.next_before);
        setOlderFailed(false);
      } catch (error) {
        setOlderFailed(true);
        throw error;
      }
    });
  }

  function send(ask: Ask) {
    void run("send", async () => {
      setPendingAsk(ask);
      const result = await docFetch("/turns", sendResponse, { body: ask }).catch((error: unknown) => {
        const conflict = draftConflict(error);
        if (!conflict) throw error;
        if (retired.current) return;
        if (latest?.state === "failed" && review) {
          setTurns((rows) =>
            rows.map((turn) =>
              turn.id === latest.id ? { ...turn, draft_review: { ...review, current: conflict } } : turn,
            ),
          );
        } else {
          setDraftSendConflict(conflict);
        }
        setPendingAsk(null);
      });
      if (!result || retired.current) return;
      const { conversation_id, turn } = result;
      if (id !== conversation_id) {
        history.replaceState(history.state, "", chatHref(conversation_id));
        setId(conversation_id);
        const chat = {
          id: conversation_id,
          title: [...turn.question].slice(0, 80).join(""),
          created_at: turn.created_at,
        };
        setRecent((rows) => [chat, ...rows]);
        setTitle(chat.title);
      }
      setTurns((rows) => [...rows.filter((row) => row.id !== turn.id), turn]);
      // The pane is column-reverse, so scrollTop 0 is the latest turn.
      conversationPane.current?.scrollTo({ top: 0 });
      setPendingAsk(null);
      if (latest?.idempotency_key !== ask.idempotency_key) {
        privateDraft.current?.("doc-question", id ?? composerId).write("");
        setQuestion("");
      }
    });
  }

  const noChats = ready && recent.length === 0;
  const now = new Date();
  const newChat = (className: string) => (
    <a
      className={`doc-chat__icon ${className}`}
      href={chatHref(null)}
      aria-label="New chat"
      title="New chat"
      onClick={() => privateDraft.current?.("doc-question", null).write("")}
    >
      <Icon path={icons.newChat} />
    </a>
  );

  return (
    <>
      {topbarStart &&
        createPortal(
          <button
            ref={chatsToggle}
            className="doc-chat__icon doc-chat__chats-toggle"
            type="button"
            aria-label="Recent chats"
            title="Recent chats"
            aria-controls="docChats"
            aria-expanded={chatsOpen}
            onClick={() => setChatsOpen(true)}
          >
            <Icon path={icons.chats} />
          </button>,
          topbarStart,
        )}
      {topbar && createPortal(newChat("doc-chat__topbar-new"), topbar)}
      {topbarTitle &&
        title &&
        createPortal(
          <span className="doc-chat__title">
            <span className="doc-chat__separator" aria-hidden="true">
              {" / "}
            </span>
            {title}
          </span>,
          topbarTitle,
        )}
      <div className="doc-chat__layout">
        <aside
          id="docChats"
          ref={chatsPanel}
          className="doc-chat__chats"
          data-open={chatsOpen || undefined}
          aria-labelledby="docChatsLabel"
          onKeyDown={(event) => chatsOpen && event.key === "Escape" && closeChats()}
        >
          <div className="doc-chat__chats-head">
            <span id="docChatsLabel">Chats</span>
            {newChat("doc-chat__list-new")}
          </div>
          <ul>
            {recent.map((chat) => (
              <li key={chat.id}>
                <a href={chatHref(chat.id)} aria-current={chat.id === id ? "page" : undefined}>
                  <span>{chat.title}</span>
                  <time dateTime={chat.created_at}>{chatTime(chat.created_at, now)}</time>
                </a>
              </li>
            ))}
          </ul>
          {noChats && <p>No conversations yet</p>}
          {nextBefore && (
            <button className="doc-chat__older" type="button" disabled={busy} onClick={loadOlder}>
              Older chats
            </button>
          )}
        </aside>
        {chatsOpen && (
          <button className="doc-chat__scrim" type="button" aria-label="Close chats" onClick={closeChats} />
        )}
        <section aria-label="Conversation">
          {ready && draftId && (
            <p>
              <a className="doc-chat__action" href={draftReviewHref(draftId)}>
                {reviewReason ? "Open fresh review" : "Open reply review"}
              </a>
            </p>
          )}
          {ready && initialInvoice && (
            <p>
              <a className="doc-chat__action" href={`/invoices?invoice=${encodeURIComponent(initialInvoice.key)}`}>
                Open invoice
              </a>
            </p>
          )}
          <div className="doc-chat__scroll" ref={conversationPane}>
            {ready && !id && !pendingAsk && <p className="doc-chat__empty">What do you need?</p>}
            <ol className="doc-chat__turns" aria-live="polite">
              {turns.map((turn) => {
                const sources = turn.answer?.sources ?? [];
                const suggestion = turn.state === "answered" && turn.answer?.kind === "answer" && turn.answer.proposal;
                const storage = ready && privateDraft.current?.("doc-proposal", turn.id);
                return (
                  <li key={turn.id}>
                    <p className="doc-chat__question">{turn.question}</p>
                    <p className="doc-chat__reply">
                      {turn.answer?.text ?? turn.waiting_reason ?? stateText[turn.state]}
                    </p>
                    {turn.state === "answered" && turn.answered_by === "backup" && <small>Answered by backup</small>}
                    {sources.length > 0 && (
                      <ul className="doc-chat__sources" aria-label="Sources">
                        {sources.map(({ ref, label, href }) => {
                          const path = recordHref(href);
                          return (
                            <li key={`${ref.kind}:${ref.id}${href}`}>{path ? <a href={path}>{label}</a> : label}</li>
                          );
                        })}
                      </ul>
                    )}
                    {turn.confirmation ? (
                      <SavedProposal result={turn.confirmation} />
                    ) : (
                      suggestion &&
                      storage && (
                        <ProposalEditor
                          turnId={turn.id}
                          suggestion={suggestion}
                          storage={storage}
                          onSaved={(result) =>
                            setTurns((rows) =>
                              rows.map((row) => (row.id === turn.id ? { ...row, confirmation: result } : row)),
                            )
                          }
                        />
                      )
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <p role="status">{busy ? (pendingAsk ? "Sending question…" : "Loading chats…") : notice}</p>
          <div className="doc-chat__actions">
            {!pendingAsk && status === "loadFailed" && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => (olderFailed ? loadOlder() : void load(id))}
              >
                Retry loading
              </button>
            )}
            {retry && !reviewReason && status !== "loadFailed" && (
              <button className="btn" type="button" disabled={busy} onClick={() => send(retry)}>
                Retry
              </button>
            )}
          </div>
        </section>
        <form
          className="doc-chat__composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend)
              send({
                question,
                idempotency_key: crypto.randomUUID(),
                ...(id ? { conversation_id: id } : initialContext && { context: initialContext }),
              });
          }}
        >
          <label htmlFor="docQuestion">Question for Doc</label>
          <textarea
            id="docQuestion"
            aria-describedby="docQuestionLength"
            rows={3}
            value={question}
            disabled={(!ready && status !== "unavailable" && status !== "older") || !!pendingAsk}
            readOnly={status === "unavailable" || status === "older"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              privateDraft.current?.("doc-question", id ?? composerId).write(value);
              setQuestion(value);
            }}
          />
          <div className="doc-chat__actions">
            <small id="docQuestionLength">
              {questionLength.toLocaleString("en-US")} / {questionLimit.toLocaleString("en-US")}
            </small>
            <button className="btn btn-primary" type="submit" disabled={!canSend}>
              Send
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

const root = document.querySelector("#main");
if (root) createRoot(root).render(<DocChat />);
