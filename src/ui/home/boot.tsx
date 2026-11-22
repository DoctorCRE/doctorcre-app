import type { DocLinkRequest } from "../doc-link";
import { fixtureInboxRpc } from "./fixture.tsx";
import { inboxRefusal, markHomeReady, mountInbox } from "./home.tsx";
import { createInboxClient } from "./inbox.tsx";

type Rpc = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
type McpResult = { kind: string; status?: number; isError?: boolean; payload?: unknown };
const sibling = (path: string) => import(/* runtime module beside ui-inbox.js */ new URL(path, import.meta.url).href);

export async function bootInbox(host: HTMLElement) {
  const legacy = new Set([
    "homeCallTasks",
    "homeEmailFollowups",
    "homeOverdueReviews",
    "homeBrief",
    "homeMeetingReviews",
    "homeMissingNextStep",
    "homeCalendar",
    "homeMeetings",
    "homeCallOutcomes",
    "homeEmailFilings",
    "homeInvoices",
    "homePastClients",
    "homeIntroductions",
    "homeContactReasons",
    "homeLeads",
    "dealAttention",
    "dealFlags",
    "homeEmailActivity",
    "homeReplyOutcomes",
  ]);
  const migrate = () => {
    if (location.pathname !== "/" || !legacy.has(location.hash.slice(1))) return false;
    if (document.documentElement.hasAttribute("data-home-today-from-engine")) {
      history.replaceState(history.state, "", location.pathname + location.search);
      return false;
    }
    location.replace(`/review-workflows${location.search}${location.hash}`);
    return true;
  };
  if (migrate()) return;
  addEventListener("hashchange", migrate);
  try {
    const { resolveDealroomBoot } = await sibling("./boot-mode.js");
    let rpc: Rpc = fixtureInboxRpc();
    let docLinkRequest: DocLinkRequest | undefined;
    if (resolveDealroomBoot(location).mode === "live") {
      const [{ privateSession }, { createMcpRequests }] = await Promise.all([
        sibling("./private-session.js"),
        sibling("./mcp-requests.mjs"),
      ]);
      const session = privateSession();
      await session.verify();
      if (session.engineSignIn) docLinkRequest = session.fetch;
      const request = createMcpRequests();
      rpc = async (name, args, signal) => {
        const result: McpResult = await request(name, args, { signal, timeoutMs: 10000 });
        if (result.kind !== "payload") {
          const status = result.status;
          if (name === "decide-engine-home-proposal" && status !== undefined && status >= 400 && status < 500) {
            const payload = result.payload && typeof result.payload === "object" ? result.payload : {};
            throw Object.assign(Error("Suggestion refused."), { payload: { ...payload, http_status: status } });
          }
          throw Error("Server confirmation unavailable.");
        }
        if (result.isError) {
          const code =
            result.payload && typeof result.payload === "object" && "error" in result.payload
              ? result.payload.error
              : null;
          throw Object.assign(Error(inboxRefusal(code)), { payload: result.payload });
        }
        return result.payload;
      };
    }
    if (location.pathname === "/") await sibling("./app-shell.js");
    mountInbox(host, createInboxClient(rpc), docLinkRequest);
  } catch {
    host.replaceChildren();
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = "Inbox unavailable. Sign in or refresh to try again.";
    const link = document.createElement("a");
    link.href = "/auth/login";
    link.textContent = "Sign in";
    host.append(notice, link);
    if (location.pathname === "/") markHomeReady(host);
  }
}
