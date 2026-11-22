import { formatClock } from "./visual-system.js";

/** The one sentence any refusal becomes, whatever the server said. */
export const REFUSAL_SENTENCE = "Temporarily unavailable";

export const APP_READ_ID = "app";
const APP_READ_LABEL = "app";
const APP_REFUSAL_SENTENCE = "the app did not answer";

export const SNAPSHOT_KEY = "doctorcre.status-snapshot.v1";
const SNAPSHOT_SCHEMA = "doctorcre-status-snapshot.v1";

/** The only keys a stored read may carry. Anything else is a payload leak. */
export const SNAPSHOT_READ_KEYS = Object.freeze(["id", "state", "observed_at", "reason", "coverage_word"]);

/** Coverage boundaries of the scoped assurance verb; unknown never means zero. */
export const INTEGRATION_GAPS = Object.freeze([
  Object.freeze({ id: "v5-a01", title: "Truthful health and scoped degradation (V5-A01)", word: "unknown", reason: "Choose a workflow and version" }),
  Object.freeze({ id: "v5-f08", title: "Backup, restore and degraded-operation posture (V5-F08)", word: "unknown", reason: "Backup status unavailable" }),
  Object.freeze({ id: "v5-f07", title: "Supervisor and job health (V5-F07)", word: "unknown", reason: "Job status unavailable" }),
]);

/** Anchors only. The page never fetches these: CSP connect-src is 'self'. */
export const PROVIDER_LINKS = Object.freeze([
  Object.freeze({ id: "cloudflare", label: "Cloudflare status", href: "https://www.cloudflarestatus.com/" }),
  Object.freeze({ id: "neon", label: "Neon status", href: "https://neonstatus.com/" }),
  Object.freeze({ id: "github", label: "GitHub status", href: "https://www.githubstatus.com/" }),
]);

const ACTION_PROVIDERS = "Check the provider status pages below.";

const answered = (read) => read?.state === "read";

export function appChip(release) {
  const clock = answered(release) ? formatClock(release.observed_at) : null;
  if (clock) return { id: APP_READ_ID, name: APP_READ_LABEL, state: "read", text: `${APP_READ_LABEL}: updated ${clock}` };
  const reason = answered(release) ? "the read carried no readable time" : APP_REFUSAL_SENTENCE;
  return { id: APP_READ_ID, name: APP_READ_LABEL, state: "unknown", reason, text: `${APP_READ_LABEL}: unknown (${reason})` };
}

export function statusHeadline({ release, snapshot = null }) {
  if (answered(release)) {
    return { scenario: 1, headline: "DoctorCRE is available.", action: "Nothing to do.", lastKnown: false };
  }
  const savedAt = snapshot?.saved_at;
  return {
    scenario: savedAt ? 3 : 4,
    headline: "The DoctorCRE app itself did not answer.",
    action: ACTION_PROVIDERS,
    lastKnown: Boolean(savedAt),
    lastKnownTitle: "Last known",
    lastKnownAsOf: savedAt ? `as of ${formatClock(savedAt)}` : null,
  };
}

/**
 * The stored picture: which reads answered and when, and nothing else. No
 * titles, no refs, no counts of operational items — a device cache of business
 * rows is exactly the stale-looks-live failure the service worker already
 * refuses for /api/, and this file will not reintroduce it.
 */
export function snapshotFromReads(reads, now) {
  const source = reads && typeof reads === "object" ? reads : {};
  const ids = source[APP_READ_ID] ? [APP_READ_ID] : [];
  return {
    schema: SNAPSHOT_SCHEMA,
    saved_at: new Date(now || Date.now()).toISOString(),
    reads: ids.map((id) => {
      const read = source[id] || {};
      const ok = answered(read);
      return {
        id,
        state: ok ? "read" : "unknown",
        observed_at: ok && typeof read.observed_at === "string" ? read.observed_at : null,
        reason: ok ? null : (id === APP_READ_ID ? APP_REFUSAL_SENTENCE : REFUSAL_SENTENCE),
        coverage_word: ok ? "read" : "unknown",
      };
    }),
  };
}

/** Never throws, never returns a half-read shape: a bad store is simply absent. */
export function readSnapshot(storage) {
  try {
    const raw = storage?.getItem?.(SNAPSHOT_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.schema !== SNAPSHOT_SCHEMA) return null;
    if (typeof parsed.saved_at !== "string" || !formatClock(parsed.saved_at)) return null;
    if (!Array.isArray(parsed.reads)) return null;
    const reads = parsed.reads
      .filter((row) => row && typeof row === "object" && row.id === APP_READ_ID)
      .map((row) => Object.fromEntries(SNAPSHOT_READ_KEYS.map((key) => [key, row[key] ?? null])));
    return { schema: parsed.schema, saved_at: parsed.saved_at, reads };
  } catch {
    return null;
  }
}

/** Returns whether the write landed; a refusing store is not an error here. */
export function writeSnapshot(storage, snapshot) {
  try {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}
