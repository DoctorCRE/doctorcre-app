import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  type DocLinkRequest,
  type DocLinkStatus,
  docLinkMessages,
  readDocLinkStatus,
  requestDocLink,
} from "./doc-link";

function DocLinkSettings({ request }: { request: DocLinkRequest }) {
  const [status, setStatus] = useState<DocLinkStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const codeView = useRef(0);
  const codeText = useRef<HTMLElement>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    function clearCode() {
      codeView.current++;
      flushSync(() => {
        setCode("");
        setNotice("");
      });
    }
    addEventListener("hashchange", clearCode, { signal: lifetime.signal });
    addEventListener("pagehide", clearCode, { signal: lifetime.signal });
    addEventListener("doctorcre-session-invalidated", clearCode, { signal: lifetime.signal });
    return () => lifetime.abort();
  }, []);

  useEffect(() => {
    if (!copiedCode) return;
    // eslint-disable-next-line no-restricted-syntax -- Single 2 s Copied label, cleared on code change or unmount.
    const timer = setTimeout(() => setCopiedCode(""), 2000);
    return () => clearTimeout(timer);
  }, [copiedCode]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setNotice("");
    setStatus(await readDocLinkStatus(request));
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
        await requestDocLink(request, "POST", "/revoke");
        setStatus("not_set_up");
      } else {
        const response = await requestDocLink(request, "POST");
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
      const current = await readDocLinkStatus(request);
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

  async function copyCode() {
    setNotice("");
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      if (codeText.current) getSelection()?.selectAllChildren(codeText.current);
      setNotice("Press Cmd+C to copy.");
    }
  }

  return (
    <section className="card glass" aria-labelledby="docLinkTitle">
      <div className="card-heading">
        <h2 id="docLinkTitle">Doc link</h2>
      </div>
      <p role="status">
        {status ? docLinkMessages[status] : busy ? "Checking Doc status…" : "Couldn't load Doc status."}
      </p>
      {notice && <p role="status">{notice}</p>}
      {code ? (
        <>
          <p>Paste this code at the Doc setup prompt on your Mac. The app shows it once.</p>
          <p className="mono">
            <code ref={codeText}>{code}</code>
          </p>
          <div className="pref-act">
            <button className="btn doc-link-copy" type="button" onClick={() => void copyCode()}>
              {copiedCode === code ? "Copied" : "Copy"}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setCode("");
                setNotice("");
              }}
            >
              Done
            </button>
          </div>
        </>
      ) : (
        <div className="pref-act">
          {status && (
            <button className="btn" type="button" disabled={busy} onClick={() => void change("issue")}>
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

export function mountDocLinkSettings(element: Element, request: DocLinkRequest) {
  createRoot(element).render(<DocLinkSettings request={request} />);
}
