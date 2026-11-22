type Lifecycle = "stale" | "resolved" | "retired";
export type ExactCard = {
  kind: "reply_draft";
  id: string;
  state: Lifecycle;
  source_version: number;
  subject?: string;
  body?: string;
  to?: string[];
  cc?: string[];
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string";
export function parseExactCard(value: unknown, ref: string): ExactCard | null {
  if (!object(value) || value.schema_version !== "action-link-resolve.v2" || value.ref !== ref || !object(value.card))
    return null;
  if (Object.keys(value).sort().join(",") !== "card,ref,schema_version") return null;
  const c = value.card;
  if (c.kind !== "reply_draft") return null;
  const allowed = [
    "kind",
    "id",
    "state",
    "source_version",
    "actions",
    ...(c.state === "stale" ? ["subject", "body", "to", "cc"] : []),
  ];
  if (Object.keys(c).length !== allowed.length || !allowed.every((key) => Object.hasOwn(c, key))) return null;
  if (!uuid(c.id) || !Array.isArray(c.actions)) return null;
  let decoded: string;
  try {
    decoded = atob(ref.slice(4).replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (`al1_${btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}` !== ref) return null;
  const [code, id, version, replyVersion, ...rest] = decoded.split(":");
  if (id !== c.id || rest.length) return null;
  const state = c.state;
  if (state !== "stale" && state !== "resolved" && state !== "retired") return null;
  if (
    code !== "rd" ||
    !["joe", "dell"].includes(version || "") ||
    !/^[1-9][0-9]*$/.test(replyVersion || "") ||
    typeof c.source_version !== "number" ||
    !Number.isSafeInteger(c.source_version) ||
    c.source_version < 1 ||
    c.actions.length
  )
    return null;
  if (state === "stale") {
    if (
      !text(c.subject) ||
      !text(c.body) ||
      !Array.isArray(c.to) ||
      !c.to.every(text) ||
      !Array.isArray(c.cc) ||
      !c.cc.every(text)
    )
      return null;
    return {
      kind: c.kind,
      id: c.id,
      state,
      source_version: c.source_version,
      subject: c.subject,
      body: c.body,
      to: c.to,
      cc: c.cc,
    };
  }
  return { kind: c.kind, id: c.id, state, source_version: c.source_version };
}
