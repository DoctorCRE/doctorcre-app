import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { refreshWhileVisible } from "./visible-refresh";

// The app's Content Security Policy blocks dynamic code evaluation.
z.config({ jitless: true });

const recordRef = z.object({
  kind: z.enum(["deal", "lead", "client", "email"]),
  id: z.guid(),
});
const source = z.object({
  ref: recordRef,
  label: z.string(),
  href: z.string(),
});
const proposal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), target: source, text: z.string() }),
  z.object({ kind: z.literal("next_step"), target: source, what: z.string(), due_on: z.iso.date().nullable() }),
  z.object({ kind: z.literal("reply_draft"), target: source, subject: z.string(), body: z.string() }),
]);
const answer = z.object({
  kind: z.enum(["answer", "clarification", "refusal"]),
  text: z.string(),
  sources: z.array(source),
  proposal: proposal.nullable(),
});
const confirmation = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["note", "next_step"]), id: z.guid(), href: z.string() }),
  z.object({ kind: z.literal("reply_draft"), id: z.guid(), href: z.string(), existing: z.boolean() }),
]);
const conversation = z.object({
  id: z.guid(),
  title: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
const macOffline = "Doc answers when your Mac is on.";
const planPaused = "Doc is paused until your Claude plan resets.";
const chatTurn = z.object({
  id: z.guid(),
  position: z.int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  question: z.string(),
  idempotency_key: z.guid(),
  context: recordRef.nullable(),
  state: z.enum(["queued", "working", "failed", "answered"]),
  answer: answer.nullable(),
  confirmation: confirmation.nullable(),
  waiting_reason: z
    .enum([
      "Doc isn't set up on your Mac yet.",
      macOffline,
      "Sign in to Claude Code on your Mac.",
      planPaused,
      "Doc is waiting for a free slot on your Mac.",
    ])
    .nullable(),
});
const conversationList = z.object({ conversations: z.array(conversation), next_before: z.guid().nullable() });
const conversationDetail = z.object({ conversation, turns: z.array(chatTurn) });
const sendResponse = z.object({ conversation_id: z.guid(), turn: chatTurn });

type Conversation = Pick<z.infer<typeof conversation>, "id" | "title">;
type Turn = z.infer<typeof chatTurn>;
type Ask = Pick<Turn, "question" | "idempotency_key"> & {
  conversation_id?: string;
  context?: z.infer<typeof recordRef>;
};
type Session = {
  verify(options: { fresh: boolean; waitForBudget?: boolean }): Promise<unknown>;
  fetch(path: string, init: RequestInit, options: { boundRead: boolean; waitForBudget: boolean }): Promise<Response>;
};

const api = "/api/engine/doc";
const initialId = new URLSearchParams(location.search).get("chat");
const statusText = {
  signIn: "Sign in again to open your chats.",
  loadFailed: "Chats couldn’t be loaded.",
  sendFailed: "The question couldn’t be sent. Try again.",
  unavailable: "Conversation unavailable",
};
const stateText = {
  queued: "Doc is waiting.",
  working: "Doc is working.",
  answered: "Answered",
  failed: "Doc couldn’t answer.",
};

function chatHref(id: string | null) {
  const query = new URLSearchParams(location.search);
  if (id) query.set("chat", id);
  else query.delete("chat");
  return location.pathname + (query.size ? `?${query}` : "");
}

function conversationPath(id: string) {
  return `/conversations/${encodeURIComponent(id)}`;
}

function recordHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//") && !/[\\\s]/.test(href) ? href : undefined;
}

class ConversationUnavailable extends Error {}

async function docFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  { ask, signal, boundRead = false }: { ask?: Ask; signal?: AbortSignal; boundRead?: boolean } = {},
): Promise<T> {
  const { privateSession }: { privateSession: () => Session | null } = await import(
    new URL("./private-session.js", import.meta.url).href
  );
  const session = privateSession();
  if (!session) throw Error(statusText.signIn);
  signal?.throwIfAborted();
  const waitForBudget = Boolean(ask);
  if (!boundRead) await session.verify({ fresh: true, waitForBudget });
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(12000);
  const response = await session.fetch(
    api + path,
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(ask && {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ask),
      }),
    },
    { boundRead, waitForBudget },
  );
  signal?.throwIfAborted();
  const unavailable = response.status === 404 && path.startsWith("/conversations/");
  if (!boundRead || unavailable) await session.verify({ fresh: true, waitForBudget });
  signal?.throwIfAborted();
  if (unavailable) throw new ConversationUnavailable();
  if (!response.ok) throw Error(`Doc request failed with status ${response.status}`);
  const result = schema.safeParse(await response.json());
  if (!result.success) throw Error("Invalid Doc response");
  return result.data;
}

function DocChat() {
  const [id, setId] = useState(initialId);
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pendingAsk, setPendingAsk] = useState<Ask | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<keyof typeof statusText | null>(null);
  const retired = useRef(false);
  const active = useRef(false);
  const latest = turns.at(-1);
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
          ...(latest.context ? { context: latest.context } : {}),
        }
      : null);
  const text = question.trim();
  const canSend =
    ready &&
    !busy &&
    !waiting &&
    status !== "loadFailed" &&
    !pendingAsk &&
    text.length > 0 &&
    [...text].length <= 4000 &&
    !text.includes("\0");

  const showUnavailable = useCallback(() => {
    setTurns([]);
    setReady(false);
    setStatus("unavailable");
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
        const { conversations } = await docFetch("/conversations", conversationList);
        if (retired.current) return;
        setRecent(conversations);
        if (chatId) {
          const { turns: saved } = await docFetch(conversationPath(chatId), conversationDetail);
          if (retired.current) return;
          setTurns(saved);
        }
        setReady(true);
      });
    },
    [run],
  );

  useEffect(() => {
    function clear() {
      retired.current = true;
      setId(null);
      setRecent([]);
      setTurns([]);
      setQuestion("");
      setPendingAsk(null);
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
          return waitingReason === macOffline || waitingReason === planPaused ? 120_000 : 30_000;
        },
      },
    );
    window.addEventListener("doctorcre-session-invalidated", stop, { once: true });
    return () => {
      window.removeEventListener("doctorcre-session-invalidated", stop);
      stop();
    };
  }, [id, waitingTurnId, showUnavailable]);

  function send(ask: Ask) {
    void run("send", async () => {
      setPendingAsk(ask);
      const { conversation_id, turn } = await docFetch("/turns", sendResponse, { ask });
      if (retired.current) return;
      if (id !== conversation_id) {
        history.replaceState(history.state, "", chatHref(conversation_id));
        setId(conversation_id);
        setRecent((rows) => [{ id: conversation_id, title: [...turn.question].slice(0, 80).join("") }, ...rows]);
      }
      setTurns((rows) => [...rows.filter((row) => row.id !== turn.id), turn]);
      setPendingAsk(null);
      if (latest?.idempotency_key !== ask.idempotency_key) setQuestion("");
    });
  }

  return (
    <>
      <header className="doc-chat__header">
        <h1>Ask Doc</h1>
        <nav className="doc-chat__actions" aria-label="Chat navigation">
          <a href="/">Home</a>
          <a className="btn" href={chatHref(null)}>
            New chat
          </a>
        </nav>
      </header>
      <div className="doc-chat__layout">
        <aside className="doc-chat__recent" aria-labelledby="docRecent">
          <h2 id="docRecent">Recent chats</h2>
          <ul>
            {recent.map((chat) => (
              <li key={chat.id}>
                <a href={chatHref(chat.id)} aria-current={chat.id === id ? "page" : undefined}>
                  {chat.title}
                </a>
              </li>
            ))}
          </ul>
          {ready && recent.length === 0 && <p>No conversations yet</p>}
        </aside>
        <section aria-label="Conversation">
          <ol className="doc-chat__turns" aria-live="polite">
            {turns.map((turn) => {
              const sources = turn.answer?.sources ?? [];
              return (
                <li key={turn.id}>
                  <p className="doc-chat__question">{turn.question}</p>
                  <p className="doc-chat__reply">{turn.answer?.text ?? turn.waiting_reason ?? stateText[turn.state]}</p>
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
                </li>
              );
            })}
          </ol>
          <p role="status">
            {busy ? (pendingAsk ? "Sending question…" : "Loading chats…") : status && statusText[status]}
          </p>
          <div className="doc-chat__actions">
            {!pendingAsk && status === "loadFailed" && (
              <button className="btn" type="button" disabled={busy} onClick={() => void load(id)}>
                Retry loading
              </button>
            )}
            {retry && status !== "loadFailed" && (
              <button className="btn" type="button" disabled={busy} onClick={() => send(retry)}>
                Retry
              </button>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend)
                send({
                  question: text,
                  idempotency_key: crypto.randomUUID(),
                  ...(id ? { conversation_id: id } : {}),
                });
            }}
          >
            <label htmlFor="docQuestion">Question for Doc</label>
            <textarea
              id="docQuestion"
              rows={3}
              value={question}
              disabled={(!ready && status !== "unavailable") || !!pendingAsk}
              readOnly={status === "unavailable"}
              onChange={(event) => setQuestion(event.currentTarget.value)}
            />
            <div className="doc-chat__actions">
              <button className="btn btn-primary" type="submit" disabled={!canSend}>
                Send
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

const root = document.querySelector("#docChat");
if (root) createRoot(root).render(<DocChat />);
