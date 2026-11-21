import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Conversation = { id: string; title: string };
type Ask = {
  question: string;
  idempotency_key: string;
  conversation_id?: string;
  context?: { kind: string; id: string };
};
type Turn = Pick<Ask, "question" | "idempotency_key"> & {
  id: string;
  position: number;
  context: NonNullable<Ask["context"]> | null;
  state: "queued" | "working" | "answered" | "failed";
  answer: { text: string } | null;
  waiting_reason: string | null;
};
type Session = {
  verify(options: { fresh: boolean }): Promise<unknown>;
  fetch(path: string, init: RequestInit): Promise<Response>;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isConversation(value: unknown): value is Conversation {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.created_at === "string"
  );
}

function isTurn(value: unknown): value is Turn {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.created_at === "string" &&
    typeof value.position === "number" &&
    Number.isInteger(value.position) &&
    value.position > 0 &&
    typeof value.question === "string" &&
    typeof value.idempotency_key === "string" &&
    (value.state === "queued" || value.state === "working" || value.state === "answered" || value.state === "failed") &&
    (value.context === null ||
      (isObject(value.context) && typeof value.context.kind === "string" && typeof value.context.id === "string")) &&
    (value.answer === null || (isObject(value.answer) && typeof value.answer.text === "string")) &&
    (value.confirmation === null || isObject(value.confirmation)) &&
    (value.waiting_reason === null || typeof value.waiting_reason === "string")
  );
}

function isConversationList(value: unknown): value is { conversations: Conversation[] } {
  return (
    isObject(value) &&
    Array.isArray(value.conversations) &&
    value.conversations.every(isConversation) &&
    (value.next_before === null || typeof value.next_before === "string")
  );
}

function isConversationDetail(value: unknown): value is { turns: Turn[] } {
  return (
    isObject(value) && isConversation(value.conversation) && Array.isArray(value.turns) && value.turns.every(isTurn)
  );
}

function isTurnResponse(value: unknown): value is { conversation_id: string; turn: Turn } {
  return isObject(value) && typeof value.conversation_id === "string" && isTurn(value.turn);
}

class ConversationUnavailable extends Error {}

async function docFetch<T>(path: string, isResponse: (value: unknown) => value is T, ask?: Ask): Promise<T> {
  const { privateSession }: { privateSession: () => Session | null } = await import(
    new URL("./private-session.js", import.meta.url).href
  );
  const session = privateSession();
  if (!session) throw Error(statusText.signIn);
  await session.verify({ fresh: true });
  const response = await session.fetch(api + path, {
    signal: AbortSignal.timeout(12000),
    ...(ask && {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ask),
    }),
  });
  await session.verify({ fresh: true });
  if (response.status === 404 && path.startsWith("/conversations/")) throw new ConversationUnavailable();
  if (!response.ok) throw Error(`Doc request failed with status ${response.status}`);
  const value: unknown = await response.json();
  if (!isResponse(value)) throw Error("Invalid Doc response");
  return value;
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

  const run = useCallback(async (operation: "load" | "send", work: () => Promise<void>) => {
    if (active.current || retired.current) return;
    active.current = true;
    setBusy(true);
    setStatus(null);
    try {
      await work();
    } catch (error) {
      if (retired.current) return;
      if (error instanceof ConversationUnavailable) {
        setTurns([]);
        setReady(false);
        setStatus("unavailable");
      } else {
        setStatus(operation === "load" ? "loadFailed" : "sendFailed");
      }
    } finally {
      active.current = false;
      if (!retired.current) setBusy(false);
    }
  }, []);

  const load = useCallback(
    async (chatId: string | null) => {
      await run("load", async () => {
        const { conversations } = await docFetch("/conversations", isConversationList);
        if (retired.current) return;
        setRecent(conversations);
        if (chatId) {
          const { turns: saved } = await docFetch(`/conversations/${encodeURIComponent(chatId)}`, isConversationDetail);
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

  function send(ask: Ask) {
    void run("send", async () => {
      setPendingAsk(ask);
      const { conversation_id, turn } = await docFetch("/turns", isTurnResponse, ask);
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
            {turns.map((turn) => (
              <li key={turn.id}>
                <p className="doc-chat__question">{turn.question}</p>
                <p className="doc-chat__reply">{turn.answer?.text ?? turn.waiting_reason ?? stateText[turn.state]}</p>
              </li>
            ))}
          </ol>
          <p role="status">
            {busy ? (pendingAsk ? "Sending question…" : "Loading chats…") : status && statusText[status]}
          </p>
          <div className="doc-chat__actions">
            {!pendingAsk && (status === "loadFailed" || (id && ready)) && (
              <button className="btn" type="button" disabled={busy} onClick={() => void load(id)}>
                {status === "loadFailed" ? "Retry loading" : waiting ? "Check for answer" : "Refresh chat"}
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
              disabled={!ready || !!pendingAsk}
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
