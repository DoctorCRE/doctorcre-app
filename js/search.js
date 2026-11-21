import { privateSession } from './private-session.js';
import { setDocFilters } from './doc-context.js';
import { createCurrentRead } from "./current-read.mjs";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { columnBySlug, columnByValue, dealName } from "./pipeline-model.js";
import { partnerName } from "./task-records-model.js";
import {
  SAVED_VIEW_SENTENCE, SEARCH_STATE_COPY, applyScope, buildFindArguments,
  classifySearchFailure, displaySearchGroups, parseSearchAddress, queryIsSendable,
  readSavedViews, renameView, saveView, scopeChips, toggleSearchScope, searchAddress,
  usesLegacyRelationScope, validSearchPayload, validSearchRecords, visibleCount, writeSavedViews,
} from "./search-model.js";

const IDLE_REREAD_MS = 300;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what the Search tab believes; nothing else keeps a copy. */
const view = {
  status: "idle", query: "", kinds: [], payload: null, views: [],
};

let client = null;
let savedViewActor = null;
let storage = null;
let idleTimer = null;
const searchReads = createCurrentRead();

/* -------------------------------------------------------------------- painting */

function rowHtml(row, group) {
  const isDeal = ["deals", "deals_via_link"].includes(group.id);
  const title = escapeHtml(isDeal ? dealName(row.name) : row.name);
  const phase = row.phase ?? row.facts?.find(fact => fact.label === "Phase")?.value;
  const owner = row.owner ?? row.facts?.find(fact => fact.label === "Owner")?.value;
  const meta = isDeal
    ? ["Deal", phase === "dead" ? "Lost" : (columnBySlug(phase) || columnByValue(phase))?.label, ["joe", "dell"].includes(owner) && partnerName(owner)]
    : row.meta || [({ clients: "Client", leads: "Lead", vendors: "Vendor", organizations: "Company", people: "Person" })[group.id],
      ...((row.facts || []).map(fact => fact.value))];
  return `<li class="search-row">
    <div><h3>${row.link ? `<a href="${escapeHtml(row.link)}">${title}</a>` : title}</h3>
    <p class="work-meta">${meta.filter(Boolean).map(escapeHtml).join(" · ")}</p>
    ${row.deals?.length ? `<ul class="search-deal-links">${row.deals.map(deal => `<li><a href="${escapeHtml(deal.link)}">${escapeHtml(dealName(deal.name))}</a></li>`).join("")}</ul>` : ""}
    </div>
  </li>`;
}

function renderChips(groups) {
  const bar = $("searchChips");
  if (!bar) return;
  const focusKey = bar.contains(document.activeElement) ? document.activeElement.dataset.chip : null;
  const chips = scopeChips(groups, view.kinds);
  bar.innerHTML = chips.map((chip) => `<button class="chip" type="button" data-chip="${escapeHtml(chip.id)}" aria-pressed="${chip.selected}">${escapeHtml(chip.label)}</button>`).join("");
  if (focusKey) [...bar.querySelectorAll("[data-chip]")].find(node => node.dataset.chip === focusKey)?.focus();
}

function renderSavedViews() {
  const list = $("savedViewList");
  if (!list) return;
  list.innerHTML = view.views.map((saved) => `<span class="saved-view"><a class="chip" href="${escapeHtml(searchAddress(saved))}" data-view="${escapeHtml(saved.name)}">${escapeHtml(saved.name)}</a><button class="chip" type="button" data-rename="${escapeHtml(saved.name)}">Rename</button></span>`).join("");
}

function renderState(phase) {
  const block = $("searchState");
  const copy = SEARCH_STATE_COPY[phase];
  block.hidden = phase === "idle" || phase === "ready";
  block.setAttribute("data-state", phase);
  block.innerHTML = block.hidden ? "" : `<p>${escapeHtml(copy.title)}</p>${
    phase === "refused" ? '<a href="/auth/login">Sign in</a>' : ""}`;
  $("searchLive").textContent = block.hidden ? $("searchCount").textContent : copy.title;
}

function render() {
  const groups = view.payload ? displaySearchGroups(view.payload, view.kinds) : [];
  const shown = applyScope(groups, view.kinds);
  const phase = view.status === "ready" && !groups.length ? "no_match" : view.status;
  document.querySelector('[data-search="scope"]').hidden = !groups.length;
  document.querySelector('[data-search="views"]').hidden = !view.query.trim();

  const input = $("searchQuery");
  if (input && input.value !== view.query) input.value = view.query;

  const results = $("searchResults");
  if (results) {
    results.setAttribute("aria-busy", String(phase === "loading"));
    results.innerHTML = shown.map((group) => `<section data-group="${escapeHtml(group.id)}" aria-label="${escapeHtml(group.label)}">
      <h2 class="search-group-title">${escapeHtml(group.label)}</h2>
      <ul class="work-list">${group.rows.map(row => rowHtml(row, group)).join("")}</ul>
    </section>`).join("");
  }

  const total = $("searchCount");
  const count = visibleCount(shown);
  total.textContent = view.payload ? `${count} ${count === 1 ? "result" : "results"}` : "";
  renderChips(groups);
  renderState(phase);
}

async function read({ push = true, signal } = {}) {
  const query = view.query;
  setDocFilters({query, kinds:view.kinds});
  if (!queryIsSendable(query)) {
    searchReads.invalidate();
    if (push) pushAddress();
    view.status = "idle"; view.payload = null;
    render();
    return;
  }
  view.status = "loading";
  if (push) view.payload = null;
  render();
  if (push) pushAddress();
  const searchRecords = !usesLegacyRelationScope(view.kinds);
  return searchReads.run(async ({ signal, read: step }) => {
    const payload = await step(client.find(buildFindArguments(query), { signal, searchRecords }));
    return validSearchRecords(payload) || validSearchPayload(payload)
      ? { status: "ready", payload }
      : { status: "unknown", payload: null };
  }, {
    signal,
    success(result) { Object.assign(view, result); render(); },
    failure(error) {
      view.status = classifySearchFailure(error);
      view.payload = null;
      render();
    },
  });
}

/* ------------------------------------------------------------------ the address */

function pushAddress() {
  const address = searchAddress({ query: view.query, kinds: view.kinds });
  if (globalThis.history?.pushState) globalThis.history.pushState({ q: view.query, kinds: [...view.kinds] }, "", address);
}

function replaceAddress() {
  const address = searchAddress({ query: view.query, kinds: view.kinds });
  if (globalThis.history?.replaceState) globalThis.history.replaceState({ q: view.query, kinds: [...view.kinds] }, "", address);
}

/**
 * Back. The query and the chips are restored from the URL and the page
 * reads results for that query rather than reusing another query’s payload.
 */
function restoreFromAddress({ reread = true } = {}) {
  const address = parseSearchAddress(globalThis.location?.search || "");
  if (view.query !== address.query) view.payload = null;
  view.query = address.query;
  view.kinds = [...address.kinds];
  if (reread) read({ push: false });
  else render();
  return address;
}

/* ------------------------------------------------------------------ the wiring */

function wire() {
  $("searchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    view.query = $("searchQuery")?.value ?? "";
    clearTimeout(idleTimer);
    read({ push: true });
  });

  // Typing invalidates the current answer immediately, then reads once idle.
  $("searchQuery")?.addEventListener("input", () => {
    view.query = $("searchQuery")?.value ?? "";
    searchReads.invalidate();
    setDocFilters({ query: view.query });
    if (idleTimer) clearTimeout(idleTimer);
    view.payload = null;
    view.status = "idle";
    if (!view.query.trim()) { read({ push: true }); return; }
    render();
    // eslint-disable-next-line no-restricted-syntax -- Search keeps one 300ms debounce and cancels its predecessor.
    idleTimer = setTimeout(() => read({ push: false }), IDLE_REREAD_MS);
  });

  $("searchChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    const id = chip.dataset.chip;
    // A chip hides rows from the answer already in hand. Nothing is re-read and
    // the outgoing argument object is untouched.
    const available = [...$("searchChips").querySelectorAll("[data-chip]")].map(node => node.dataset.chip);
    view.kinds = toggleSearchScope(view.kinds, id, available);
    replaceAddress();
    render();
  });

  $("saveViewButton")?.addEventListener("click", () => {
    const name = $("saveViewName")?.value ?? "";
    // No verb is sent. There is none to send.
    view.views = writeSavedViews(storage, saveView(view.views, { name, query: view.query, kinds: view.kinds }), savedViewActor);
    const field = $("saveViewName");
    if (field) field.value = "";
    renderSavedViews();
  });

  $("savedViewList")?.addEventListener("click", (event) => {
    const rename = event.target.closest("[data-rename]");
    if (rename) {
      event.preventDefault();
      const next = globalThis.prompt?.("New name for this saved view", rename.dataset.rename);
      if (typeof next === "string") view.views = writeSavedViews(storage, renameView(view.views, rename.dataset.rename, next), savedViewActor);
      [...$("savedViewList").children].forEach((row, index) => {
        const saved = view.views[index], link = row.querySelector("[data-view]");
        link.textContent = saved.name;
        link.dataset.view = saved.name;
        link.href = searchAddress(saved);
        row.querySelector("[data-rename]").dataset.rename = saved.name;
      });
      return;
    }
    const open = event.target.closest("[data-view]");
    if (!open) return;
    event.preventDefault();
    const saved = view.views.find((entry) => entry.name === open.dataset.view);
    if (!saved) return;
    view.query = saved.query;
    view.kinds = [...saved.kinds];
    read({ push: true });
  });

  $("resetViewsButton")?.addEventListener("click", () => {
    view.views = writeSavedViews(storage, Object.freeze([]), savedViewActor);
    renderSavedViews();
  });

  globalThis.addEventListener?.("popstate", () => restoreFromAddress({ reread: true }));
}

/**
 * Mount the Search tab. `storageImpl` is injectable so a test can watch every
 * key this surface writes and assert that the workspace preference key is never
 * one of them.
 */
export function mountSearch({ client: searchClient, storage: storageImpl } = {}) {
  client = searchClient;
  storage = storageImpl === undefined ? (globalThis.localStorage || null) : storageImpl;
  view.views = [];
  const boundary = privateSession();
  const identity = boundary ? boundary.verify() : Promise.resolve({actor:{slug:client.selfActor}});
  void identity.then(session => {
    if (boundary?.revoked) return;
    savedViewActor = session.actor.slug;
    view.views = readSavedViews(storage, savedViewActor);
    renderSavedViews();
  }).catch(() => {});
  globalThis.addEventListener?.('doctorcre-session-invalidated', () => {
    savedViewActor = null; view.views = []; view.query = ''; view.payload = null; view.status = 'idle';
    searchReads.invalidate(); clearTimeout(idleTimer);
    renderSavedViews();
    render();
  }, {once:true});
  renderSavedViews();
  $("savedViewNote").textContent = SAVED_VIEW_SENTENCE;
  wire();
  const address = restoreFromAddress({ reread: true });
  mountAutoRefresh({ document, window: globalThis.window, refresh: ({ signal }) => view.query ? read({ push: false, signal }) : undefined });
  return { view, address };
}
