const path = "/api/engine/doc/link";

export const docLinkMessages = {
  not_set_up: "Doc isn't set up on your Mac yet.",
  mac_off: "Doc answers when your Mac is on.",
  signed_out: "On your Mac, sign in to the app you use for Doc: Claude Code or Codex.",
  plan_limited: "Doc is paused until your model's plan resets.",
  ready: "Doc is ready on your Mac.",
} as const;

export type DocLinkStatus = keyof typeof docLinkMessages;
export type DocBackend = "claude" | "codex" | null;
export type DocLink = { status: DocLinkStatus; backend: DocBackend };

const codeStatuses: Record<string, DocLinkStatus> = {
  doc_not_set_up: "not_set_up",
  doc_mac_off: "mac_off",
  doc_signed_out: "signed_out",
  doc_plan_limit: "plan_limited",
  doc_ready: "ready",
};

function statusForCode(code: unknown): DocLinkStatus | undefined {
  return typeof code === "string" && Object.hasOwn(codeStatuses, code) ? codeStatuses[code] : undefined;
}

export function docLinkMessage(status: DocLinkStatus, backend: DocBackend) {
  const model = backend === "claude" ? "Claude Code" : backend === "codex" ? "Codex" : null;
  if (model && status === "signed_out") return `Sign in to ${model} on your Mac.`;
  if (model && status === "plan_limited") return `Doc is paused until your ${model} plan resets.`;
  return docLinkMessages[status];
}

export function waitingMessage(text: string | null, code: string | null | undefined, backend: DocBackend) {
  const status = statusForCode(code);
  if (status) return docLinkMessage(status, backend);
  if (text === "Sign in to Claude Code on your Mac.") return docLinkMessage("signed_out", backend);
  if (text === "Doc is paused until your Claude plan resets.") return docLinkMessage("plan_limited", backend);
  return text;
}

export type DocLinkRequest = (path: string, init: RequestInit) => Promise<Response>;

function isDocLinkStatus(value: unknown): value is DocLinkStatus {
  return typeof value === "string" && Object.hasOwn(docLinkMessages, value);
}

export async function requestDocLink(
  request: DocLinkRequest,
  method: "GET" | "POST",
  suffix = "",
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await request(path + suffix, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw Error("Doc link unavailable");
  return response;
}

export async function readDocLinkStatus(request: DocLinkRequest, signal?: AbortSignal): Promise<DocLink | null> {
  try {
    const response = await requestDocLink(request, "GET", "", signal);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return null;
    const status =
      statusForCode("readiness_code" in data ? data.readiness_code : null) ??
      ("status" in data && isDocLinkStatus(data.status) ? data.status : undefined);
    if (!status) return null;
    const backend = "backend" in data && (data.backend === "claude" || data.backend === "codex") ? data.backend : null;
    return { status, backend };
  } catch {
    return null;
  }
}
