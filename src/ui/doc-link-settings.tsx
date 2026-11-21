import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const path = "/api/engine/doc/link";
const messages = {
  not_set_up: "Doc isn't set up on your Mac yet.",
  mac_off: "Doc answers when your Mac is on.",
  signed_out: "Sign in to Claude Code on your Mac.",
  plan_limited: "Doc is paused until your Claude plan resets.",
  ready: "Doc is ready on your Mac.",
};
type Status = keyof typeof messages;
type Transport = (path: string, init: RequestInit) => Promise<Response>;

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

async function send(request: Transport, method: "GET" | "POST", suffix = "") {
  const response = await request(path + suffix, { method, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Doc link unavailable");
  return response;
}

async function readStatus(request: Transport) {
  try {
    const response = await send(request, "GET");
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "status" in data && isStatus(data.status)) return data.status;
  } catch {
    return null;
  }
  return null;
}

function DocLinkSettings({ request }: { request: Transport }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const codeView = useRef(0);

  useEffect(() => {
    const lifetime = new AbortController();
    function clearCode() {
      codeView.current++;
      flushSync(() => setCode(""));
    }
    addEventListener("pagehide", clearCode, { signal: lifetime.signal });
    addEventListener("doctorcre-session-invalidated", clearCode, { signal: lifetime.signal });
    return () => lifetime.abort();
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setNotice("");
    setStatus(await readStatus(request));
    setBusy(false);
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function change(action: "issue" | "revoke") {
    const view = codeView.current;
    setBusy(true);
    setNotice("");
    try {
      if (action === "revoke") {
        await send(request, "POST", "/revoke");
        setStatus("not_set_up");
      } else {
        const response = await send(request, "POST");
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("credential" in data) ||
          typeof data.credential !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(data.credential)
        )
          throw new Error("Doc link code unavailable");
        setStatus("mac_off");
        if (view === codeView.current) setCode(data.credential);
      }
    } catch {
      const current = await readStatus(request);
      setStatus(current);
      if (action === "issue" && current && current !== "not_set_up")
        setNotice("The code could not be shown. Replace it to get a new one.");
      else if (action === "issue" && current === "not_set_up") setNotice("Couldn't make a link code. Try again.");
      else if (action !== "revoke" || current !== "not_set_up")
        setNotice("Couldn't confirm the change. Refresh Doc status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card glass" aria-labelledby="docLinkTitle">
      <div className="card-heading">
        <h2 id="docLinkTitle">Doc link</h2>
      </div>
      <p role="status">{status ? messages[status] : busy ? "Checking Doc status…" : "Couldn't load Doc status."}</p>
      {notice && <p role="status">{notice}</p>}
      {code ? (
        <>
          <p>Paste this code at the Doc setup prompt on your Mac. The app shows it once.</p>
          <p className="mono">
            <code>{code}</code>
          </p>
          <button className="btn" type="button" onClick={() => setCode("")}>
            Done
          </button>
        </>
      ) : (
        <div className="pref-act">
          {status && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void change("issue")}>
              {status === "not_set_up" ? "Make link code" : "Replace link code"}
            </button>
          )}
          {status && status !== "not_set_up" && (
            <button className="btn" type="button" disabled={busy} onClick={() => void change("revoke")}>
              Revoke link code
            </button>
          )}
          <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>
            Refresh Doc status
          </button>
        </div>
      )}
    </section>
  );
}

export function mountDocLinkSettings(element: Element, request: Transport) {
  createRoot(element).render(<DocLinkSettings request={request} />);
}
