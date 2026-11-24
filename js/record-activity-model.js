import { compareInstants } from './change-receipts.mjs';
import { clientNoteText } from './workspace-business-model.js';
import { knownAuthor } from './client.js';

export const ACTIVITY_LIMIT = 10;
const QUERY_MAX = 200;

/** The one request, or null when the answer could never be verified. */
export function activityRequest(record, dataset) {
  const name = typeof record?.name === "string" ? record.name.trim() : "";
  const ref = typeof record?.ref === "string" ? record.ref.trim() : "";
  if (!name || !ref || name.length > QUERY_MAX) return null;
  return { query: name, limit: dataset === "clients" ? 50 : ACTIVITY_LIMIT, ref };
}

function words(slug) {
  const text = String(slug || "").replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Recorded change";
}

/** Only the fields a person reads; the raw `detail` object never leaves here. */
function timelineRow(row) {
  return {
    when: typeof row?.occurred_at === "string" ? row.occurred_at : null,
    actor: knownAuthor(row?.actor) ?? null,
    what: typeof row?.summary === "string" && row.summary.trim() ? row.summary.trim() : words(row?.verb),
    kind: row?.entry_kind === "event" ? "event" : "activity",
    owed: typeof row?.owed === "string" && row.owed ? row.owed : null,
  };
}

const FILED_KINDS = new Set(["deal", "company", "person"]);

function clientTimelineRow(source) {
  const row = timelineRow(source);
  const isEmail = /^email(?:_in|_out)?$/.test(source?.verb);
  const subject = (typeof source?.email_subject === "string" ? source.email_subject : row.what.replace(/^Email (?:from|to) [^:\n]+:\s*/i, "")).trim();
  const emailLabel = !subject || /^(?:\(no subject\)|email(?: in| out)?)$/i.test(subject)
    ? "Email without a subject"
    : `Email · ${subject}`;
  const what = clientNoteText(isEmail ? emailLabel : row.what);
  const dealId = typeof source?.deal_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.deal_id) ? source.deal_id : null;
  const filed = source?.filed_on;
  const filedOn = FILED_KINDS.has(filed?.kind) && typeof filed.name === "string" && filed.name.trim()
    ? `on ${filed.kind} ${filed.name.trim()}` : null;
  return {
    when: row.when,
    actor: row.actor,
    filedOn,
    what: what.replace(/[^\s<>@,;]+@[^\s<>@,;]+/g, "").replace(/\s+/g, " ").trim() || "Recorded activity",
    dealId,
    email: isEmail && typeof source?.detail === "string" ? source.detail : null,
  };
}

/** What a find-and-catch-up answer means for THIS record. */
export function activityState(record, answer, dataset) {
  const ref = typeof record?.ref === "string" ? record.ref.trim() : "";
  if (!ref) return { state: "no_ref" };
  if (!answer || typeof answer !== "object") return { state: "unavailable" };
  if (answer.state === "not_found") return { state: "not_found" };
  if (answer.state === "needs_disambiguation") {
    const count = Number.isInteger(answer.candidate_count) ? answer.candidate_count
      : Array.isArray(answer.candidates) ? answer.candidates.length : 0;
    return { state: "ambiguous", count };
  }
  if (answer.state !== "completed") return { state: "unavailable" };
  const target = typeof answer.match?.target === "string" ? answer.match.target.trim() : "";
  if (!target || target.toUpperCase() !== ref.toUpperCase()) return { state: "mismatch" };
  const timeline = answer.catch_up?.timeline;
  if (!Array.isArray(timeline)) return { state: "unavailable" };
  const rows = timeline.map(dataset === "clients" ? clientTimelineRow : timelineRow).sort((a, b) => compareInstants(a.when, b.when));
  return rows.length ? { state: "ready", rows } : { state: "empty", rows: [] };
}

/** Plain copy for every state that is not a list of rows. */
export function activityCopy({ state, count = 0 } = {}) {
  switch (state) {
    case "loading": return "Loading activity…";
    case "empty": return "No recent activity";
    case "not_found": return "Activity unavailable";
    case "ambiguous": return `${count} matching records. Activity unavailable.`;
    case "mismatch": return "Activity belongs to a different record.";
    case "no_ref": return "Activity unavailable";
    default: return "Activity temporarily unavailable";
  }
}
