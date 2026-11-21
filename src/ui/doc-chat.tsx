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
  context: Ask["context"] | null;
  state: "queued" | "working" | "answered" | "failed";
  answer: { text: string } | null;
  waiting_reason: string | null;
};
type Session = {
  verify(options: { fresh: boolean }): Promise<unknown>;
  fetch(path: string, init: RequestInit): Promise<Response>;
};

const api = "/api/engine/doc";
const initialId = new URLSearchParams(location.search).get("id");
const signIn = "Sign in again to open your chats.";
const loadError = "Chats couldn’t be loaded.";
const stateText = {
  queued: "Doc is waiting.",
  working: "Doc is working.",
  answered: "Answered",
  failed: "Doc couldn’t answer.",
};

function chatHref(id: string | null) {
  const query = new URLSearchParams(location.search);
  if (id) query.set("id", id);
  else query.delete("id");
  return location.pathname + (query.size ? `?${query}` : "");
}

async function docFetch(path: string, ask?: Ask) {
  const { privateSession }: { privateSession: () => Session | null } = await import(
    new URL("./private-session.js", import.meta.url).href
  );
  const session = privateSession();
  if (!session) throw Error(signIn);
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
  return response;
}

function DocChat() {
  const [id, setId] = useState(initialId);
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pendingAsk, setPendingAsk] = useState<Ask | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
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
    status !== loadError &&
    !pendingAsk &&
    text.length > 0 &&
    [...text].length <= 4000 &&
    !text.includes("\0");

  const run = useCallback(async (work: () => Promise<void>, onError: () => void) => {
    if (active.current || retired.current) return;
    active.current = true;
    setBusy(true);
    setStatus("");
    try {
      await work();
    } catch {
      if (!retired.current) onError();
    } finally {
      active.current = false;
      if (!retired.current) setBusy(false);
    }
  }, []);

  const load = useCallback(
    async (chatId: string | null) => {
      await run(
        async () => {
          const response = await docFetch("/conversations");
          if (!response.ok) throw Error();
          const data: { conversations: Conversation[] } = await response.json();
          if (retired.current) return;
          setRecent(data.conversations);
          if (chatId) {
            const detail = await docFetch(`/conversations/${encodeURIComponent(chatId)}`);
            if (detail.status === 404) {
              setTurns([]);
              setReady(false);
              setStatus("Conversation unavailable");
              return;
            }
            if (!detail.ok) throw Error();
            const { turns: saved }: { turns: Turn[] } = await detail.json();
            if (retired.current) return;
            setTurns(saved);
          }
          setReady(true);
        },
        () => setStatus(loadError),
      );
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
      setStatus(signIn);
    }
    window.addEventListener("doctorcre-session-invalidated", clear);
    void load(initialId);
    return () => window.removeEventListener("doctorcre-session-invalidated", clear);
  }, [load]);

  function send(ask: Ask) {
    void run(
      async () => {
        setPendingAsk(ask);
        const response = await docFetch("/turns", ask);
        if (response.status >= 400 && response.status < 500) {
          setPendingAsk(null);
          setStatus("Doc couldn’t take that question. Check the chat and try again.");
          return;
        }
        if (!response.ok) throw Error();
        const { conversation_id, turn }: { conversation_id: string; turn: Turn } = await response.json();
        if (retired.current) return;
        if (id !== conversation_id) {
          history.replaceState(history.state, "", chatHref(conversation_id));
          setId(conversation_id);
          setRecent((rows) => [{ id: conversation_id, title: [...turn.question].slice(0, 80).join("") }, ...rows]);
        }
        setTurns((rows) => [...rows.filter((row) => row.id !== turn.id), turn]);
        setPendingAsk(null);
        if (latest?.idempotency_key !== ask.idempotency_key) setQuestion("");
      },
      () => setStatus("The question couldn’t be sent. Try again."),
    );
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
          <p role="status">{busy ? (pendingAsk ? "Sending question…" : "Loading chats…") : status}</p>
          <div className="doc-chat__actions">
            {!pendingAsk && (status === loadError || (id && ready)) && (
              <button className="btn" type="button" disabled={busy} onClick={() => void load(id)}>
                {status === loadError ? "Retry loading" : waiting ? "Check for answer" : "Refresh chat"}
              </button>
            )}
            {retry && (
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
