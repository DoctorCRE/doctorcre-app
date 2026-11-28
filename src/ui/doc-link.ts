const path = "/api/engine/doc/link";

export const docLinkMessages = {
  not_set_up: "Doc isn't set up on your Mac yet.",
  mac_off: "Doc answers when your Mac is on.",
  signed_out: "Sign in to Doc's model on your Mac.",
  plan_limited: "Doc is paused until your model's plan resets.",
  ready: "Doc is ready on your Mac.",
} as const;

export type DocLinkStatus = keyof typeof docLinkMessages;
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

export async function readDocLinkStatus(request: DocLinkRequest, signal?: AbortSignal) {
  try {
    const response = await requestDocLink(request, "GET", "", signal);
    const data: unknown = await response.json();
    return data && typeof data === "object" && "status" in data && isDocLinkStatus(data.status) ? data.status : null;
  } catch {
    return null;
  }
}
