import { parseWatch, type Subject, type Watch } from "./model.ts";

type Transport = (verb: string, args: object, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type Outcome =
  | { kind: "confirmed"; watch: Watch | null }
  | { kind: "conflict" }
  | { kind: "denied" }
  | { kind: "missing" }
  | { kind: "unknown" };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export function createWatchClient(transport?: Transport) {
  return async (verb: string, args: Subject & object, signal: AbortSignal): Promise<Outcome> => {
    try {
      const send = transport ?? (await import(new URL("./mcp-requests.mjs", import.meta.url).href)).createMcpRequests();
      const result: unknown = await send(verb, args, { signal, timeoutMs: 10000 });
      if (!object(result)) return { kind: "unknown" };
      if (result.kind === "authorization") return { kind: "denied" };
      if (
        object(result.cause) &&
        (result.cause.status === 401 || result.cause.status === 403 || result.cause.code === "authentication_required")
      )
        return { kind: "denied" };
      if (result.kind !== "payload") return { kind: "unknown" };
      if (object(result.payload) && typeof result.payload.error === "string") {
        if (result.payload.error === "watch_stale_version") return { kind: "conflict" };
        if (result.payload.error === "watch_target_not_found") return { kind: "missing" };
        if (/human|auth|permission|forbidden/.test(result.payload.error)) return { kind: "denied" };
        return { kind: "unknown" };
      }
      if (result.isError) return { kind: "unknown" };
      return { kind: "confirmed", watch: parseWatch(result.payload, args) };
    } catch {
      return { kind: "unknown" };
    }
  };
}
export type WatchClient = ReturnType<typeof createWatchClient>;

export function createEngineWatchClient(request: typeof fetch): WatchClient {
  const commands: Record<string, string> = {
    "watch-subject-v2": "watch",
    "replace-subject-watch-policy-v2": "replace-policy",
    "pause-subject-watch-v2": "pause",
    "resume-subject-watch-v2": "resume",
    "unwatch-subject-v2": "unwatch",
  };
  return createWatchClient(async (verb, args, { signal }) => {
    if (!object(args) || typeof args.subject_id !== "string") return { kind: "failure" };
    const { subject_type, subject_id, ...body } = args;
    if (subject_type !== "deal") return { kind: "failure" };
    const command = commands[verb];
    if (verb !== "read-subject-watch-v2" && !command) return { kind: "failure" };
    const response = await request(`/api/engine/deals/${encodeURIComponent(subject_id)}/watch`, {
      method: command ? "POST" : "GET",
      signal,
      ...(command
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ command, ...body }) }
        : {}),
    });
    if (response.status === 401 || response.status === 403) return { kind: "authorization" };
    if (response.status === 404) return { kind: "payload", payload: { error: "watch_target_not_found" } };
    const payload: unknown = await response.json();
    if (!response.ok) return { kind: "payload", payload };
    if (!object(payload)) return { kind: "failure" };
    if (command) {
      const { rows_changed: _rowsChanged, ...watchPayload } = payload;
      return { kind: "payload", payload: watchPayload };
    }
    return { kind: "payload", payload: { ...payload, ok: true, schema_version: "subject-watch.v2" } };
  });
}
