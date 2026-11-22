// Shared presentation preferences, notification badge and local page tabs.
// The app shell owns header controls. Legacy preference keys migrate on entry.
import { DEFAULT_PREFERENCES, preferenceAttributes, resolvePreferences } from "./visual-system.js";
import { updatesFromEngine } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";

export const PREFERENCES_KEY = "doctorcre.visual-preferences";
const LEGACY_PREFERENCE_KEYS = Object.freeze(["doctorcre.presentation.v1"]);

const PREF_WORDS = {
  theme: { light: "Light theme", dark: "Dark theme" },
  density: { compact: "Compact density", comfortable: "Comfortable density" },
  motion: { reduced: "Motion paused", full: "Motion on" },
};

function parse(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What is stored for this person, after the one-time move off any legacy key.
 *
 * A legacy key is read ONLY when the current key holds nothing: a person who has
 * since made a choice under the current key is never taken back to an older one.
 * The legacy entry is removed as it is migrated, so the read happens once and the
 * page writes exactly one key from then on.
 *
 * Storage is a convenience and never a requirement: a browser that refuses it
 * (private mode, blocked site data) falls through to the defaults.
 *
 * @param {Storage|null} storage
 * @param {{storageKey?: string, legacyKeys?: string[]}} [options]
 */
export function migratePreferences(storage, { storageKey = PREFERENCES_KEY, legacyKeys = LEGACY_PREFERENCE_KEYS } = {}) {
  if (!storage) return {};
  let current = {};
  try {
    current = parse(storage.getItem(storageKey));
  } catch {
    return {};
  }
  if (Object.keys(current).length > 0) {
    for (const key of legacyKeys) {
      try { storage.removeItem(key); } catch { /* a convenience, never a requirement */ }
    }
    return current;
  }
  for (const key of legacyKeys) {
    let legacy = {};
    try { legacy = parse(storage.getItem(key)); } catch { continue; }
    try { storage.removeItem(key); } catch { /* a convenience, never a requirement */ }
    if (Object.keys(legacy).length === 0) continue;
    try { storage.setItem(storageKey, JSON.stringify(legacy)); } catch { /* a convenience, never a requirement */ }
    return legacy;
  }
  return current;
}

function systemPreferences() {
  return { prefersReducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true };
}

/** Each preference is ONE icon button: filled is on, hollow is off, and the only words are the label. */
function applyPreferences(preferences) {
  for (const [name, value] of Object.entries(preferenceAttributes(preferences))) document.documentElement.setAttribute(name, value);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => {
    const key = button.dataset.pref;
    const on = preferences[key] === button.dataset.on;
    button.setAttribute("aria-pressed", String(on));
    const words = key === "theme" ? "Dark mode" : PREF_WORDS[key][preferences[key]];
    button.setAttribute("aria-label", words);
    button.setAttribute("title", words);
  });
  try { localStorage.setItem("dealroom-theme", preferences.theme === "dark" ? "night" : "light"); } catch {}
  const live = document.getElementById("prefsLive");
  if (live) live.textContent = `${PREF_WORDS.theme[preferences.theme]}.`;
}

/**
 * Wire the three presentation icons on the page that is already rendered.
 *
 * @param {{storageKey?: string, legacyKeys?: string[], storage?: Storage|null}} [options]
 * @returns {{current: () => object, hasSeenWalkthrough: (actor: string) => boolean, rememberWalkthrough: (actor: string) => void}}
 */
const mountedPrefs = new WeakMap();

export function mountPrefs({ storageKey = PREFERENCES_KEY, legacyKeys = LEGACY_PREFERENCE_KEYS, storage } = {}) {
  if (mountedPrefs.has(document)) return mountedPrefs.get(document);
  let store = storage ?? null;
  if (storage === undefined) {
    try { store = globalThis.localStorage || null; } catch { /* storage access may be blocked */ }
  }
  const system = systemPreferences();
  const saved = migratePreferences(store, { storageKey, legacyKeys });
  try { if (!saved.theme && store?.getItem("dealroom-theme") === "light") saved.theme = "light"; } catch {}
  let current = resolvePreferences({ ...DEFAULT_PREFERENCES, ...saved, density: "comfortable", motion: system.prefersReducedMotion ? "reduced" : "full" }, system);
  let walkthroughSeen = {};
  const readWalkthrough = () => {
    let stored;
    try { stored = parse(store?.getItem(storageKey)).walkthroughSeen; } catch {}
    walkthroughSeen = Object.fromEntries(['joe', 'dell'].map(actor => [actor, walkthroughSeen[actor] === true || stored?.[actor] === true]));
    return walkthroughSeen;
  };
  const persist = () => {
    const seen = readWalkthrough();
    const value = Object.values(seen).some(Boolean) ? { ...current, walkthroughSeen: seen } : current;
    try { store?.setItem(storageKey, JSON.stringify(value)); } catch { /* a convenience, never a requirement */ }
  };
  applyPreferences(current);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.pref;
    const next = current[key] === button.dataset.on ? button.dataset.off : button.dataset.on;
    current = resolvePreferences({ ...current, [key]: next }, system);
    persist();
    applyPreferences(current);
  }));
  const mounted = {
    current: () => ({ ...current }),
    hasSeenWalkthrough: actor => readWalkthrough()[actor] === true,
    rememberWalkthrough(actor) {
      if (!['joe', 'dell'].includes(actor)) return;
      walkthroughSeen[actor] = true;
      persist();
    },
  };
  mountedPrefs.set(document, mounted);
  return mounted;
}

export function renderNotificationBadge(count, badge = document.getElementById("navUnreadBadge")) {
  if (!badge) return;
  const visible = Number.isInteger(count) && count > 0;
  badge.hidden = !visible;
  badge.textContent = visible ? String(count) : "";
  if (visible) badge.setAttribute("aria-label", count === 1 ? "1 unread notification" : `${count} unread notifications`);
  else badge.removeAttribute("aria-label");
}

/**
 * V5-UX-B12b — the unread-count badge every page's top bar carries next to
 * "Notifications".
 *
 * Loaded on page entry and once for each return to the page, from
 * `notification-feed`'s own `unread_count`
 * (the count is over every row the recipient holds, never recomputed from a
 * capped list — the same field `js/notifications-model.js`'s `unreadLine`
 * prints). The return read uses the same event boundary as the Notifications
 * page; background refresh keeps the count current. It fails QUIET — a failed
 * or malformed read hides the badge rather than printing a stale or fabricated
 * number, matching `notification-feed`'s
 * B12a rule that a refusal is never drawn as an empty result.
 *
 * `client.notificationFeed` is the same method every dealroom client
 * implements (`js/live-client.js`, `js/fixture-client.js`); this function
 * takes an already-constructed client rather than building one, so it never
 * decides live vs. fixture mode itself.
 *
 * @param {{notificationFeed: (args?: object) => Promise<object>, updates?: () => Promise<object>}} client
 * @param {{elementId?: string}} [options]
 */
export async function mountNotificationBadge(client, { elementId = "navUnreadBadge" } = {}) {
  const badge = document.getElementById(elementId);
  const fromEngine = updatesFromEngine();
  if (!badge || typeof client?.[fromEngine ? "updates" : "notificationFeed"] !== "function") return;
  let readSequence = 0;
  const read = async () => {
    const sequence = ++readSequence;
    renderNotificationBadge(null, badge);
    try {
      const feed = await (fromEngine ? client.updates() : client.notificationFeed({ limit: 1 }));
      if (sequence !== readSequence) return;
      renderNotificationBadge(feed?.unread_count, badge);
    } catch {
      // Fail quiet: no fake number, no error drawn into the top bar.
      return false;
    }
  };
  if (typeof document.addEventListener === "function" && typeof globalThis.window?.addEventListener === "function") {
    mountAutoRefresh({ document, window: globalThis.window, refresh: read });
  }
  await read();
}
