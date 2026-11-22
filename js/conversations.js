import { createPageBudget } from './read-budget.mjs';
import { mountAnswerBlocks, disposeAnswerBlocks } from './ui-answers.generated.js';
import { selectDocRecord } from './doc-context.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from "./auto-refresh.mjs";
import { createCommandDock } from "./command-dock.js";
import { performCommand } from "./command-feedback.mjs";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import {
  EXPOSURE_STATEMENT, LIST_EMPTY, LIST_SCOPE,
  PARTNER_SLUGS, SHARING_CAVEAT, TITLE_HISTORY_UNREADABLE,
  accessRows, archiveOperationKey, classifyReadFailure, conversationState, createArgs,
  createOperationKey, conversationRoute, idFromSearch, identityHeader, listArgs, listPagingState, listRows,
  pagingState, pinOperationKey, renameArgs, renameOperationKey, shareArgs,
  shareCandidates, shareOperationKey, turnRows, visibleCountLine,
} from "./conversations-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** The page of turns this page asks for. */
const LIMIT = 50;
let focusedRoute = null;
const renderedTurns = new Map();
/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  route: { state: "missing", id: null, given: null },
  sequence: 0,
  conversation: { state: "pending" },
  list: { state: "pending", payload: null, rows: [] },
  includeArchived: false,
};

let client = null;
// A cancelled traversal must settle even if its adapter ignores abort. Live
// reads also forward the signal to the transport, outside the verb arguments.
const readClient = (method, args, signal) => signal
  ? readWithDeadline(current => client[method](args, { signal: current }), { signal })
  : client[method](args);
const loadedPages = { conversation: 1, list: 1 };
function invalidateConversations() {
  view.sequence++;
  view.conversation = {state:'refused'};
  view.list = {state:'unavailable',payload:null,rows:[],sentence:'Sign in to continue'};
  render();
}
globalThis.addEventListener?.('doctorcre-session-invalidated', invalidateConversations);

let commandState = {};
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $("conversationLive");
  if (live && text && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : "unknown");

const payloadOf = () => (view.conversation.state === "read" ? view.conversation.payload : null);

/* -------------------------------------------------------------------- painting */

function renderHero() {
  const payload = payloadOf();
  const header = identityHeader(payload);
  const badge = $("visibilityBadge");
  // With no thread selected the hero carries only the page title: no
  // placeholder or unknown-status copy sits above the list.
  const asOfText = asOf(view.conversation);
  const heroPieces = [$("conversationId"), $("conversationAsOf"), badge, $("heroFacts"), $("titleHistoryLine")];
  for (const piece of heroPieces) piece.hidden = !header;
  if (!header) {
    $("pageTitle").textContent = "Conversations";
    $("conversationId").textContent = "";
    $("conversationAsOf").textContent = "";
    $("visibilityWord").textContent = "";
    $("heroFacts").innerHTML = "";
    return;
  }
  $("conversationAsOf").textContent = asOfText;
  $("pageTitle").textContent = header.title;
  $("conversationId").textContent = header.id;
  badge.setAttribute("data-visibility", header.visibility);
  $("visibilityGlyph").textContent = header.glyph;
  $("visibilityWord").textContent = header.word;
  const facts = [
    `Version ${header.version}`,
    `Created by ${header.createdBy}`,
    header.pinned ? `Pinned at ${header.pinnedClock}` : "Not pinned",
    header.archived ? `Archived at ${header.archivedClock}` : "Not archived",
  ];
  $("heroFacts").innerHTML = facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
}

function renderTurns() {
  const payload = payloadOf();
  const state = conversationState(view.conversation, view.route);
  const block = $("turnsState");
  block.setAttribute("data-state", state.state);
  $("turnsStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  $("conversationOrb").setAttribute(
    "data-state",
    state.state === "ready" || state.state === "empty" ? "healthy"
      : ["refused", "unavailable", "not_found", "malformed"].includes(state.state) ? "urgent" : "still",
  );
  const turns = turnRows(payload);
  const keep = new Set();
  for (const [index, turn] of turns.entries()) {
    const identity = JSON.stringify([view.route.id, turn.msgId ?? turn.sequence]);
    keep.add(identity);
    let item = renderedTurns.get(identity);
    if (!item) {
      const element = document.createElement('li');
      element.className = 'turn';
      element.tabIndex = -1;
      element.innerHTML = '<div class="turn-top"><span class="turn-role"></span><span class="turn-clock"></span></div><p class="turn-body"></p><div class="turn-answer"></div>';
      item = {element, host:element.querySelector('.turn-answer')};
      renderedTurns.set(identity, item);
    }
    const {element, host} = item;
    element.dataset.role = turn.role;
    element.dataset.sequence = String(turn.sequence);
    element.dataset.msgId = turn.msgId ?? '';
    element.dataset.target = String(turn.msgId === view.route.targetMsgId);
    for (const [selector, text] of [['.turn-role',turn.role],['.turn-clock',turn.clock],['.turn-body',turn.body]]) {
      const node = element.querySelector(selector);
      if (node.textContent !== text) node.textContent = text;
    }
    if ($('turnList').children[index] !== element) $('turnList').insertBefore(element, $('turnList').children[index] ?? null);
    mountAnswerBlocks(host, turn.answerBlocks, identity);
  }
  for (const [identity, item] of renderedTurns) if (!keep.has(identity)) {
    disposeAnswerBlocks(item.host);
    item.element.remove();
    renderedTurns.delete(identity);
  }
  const paging = pagingState(payload);
  $("pagingBlock").hidden = !paging.more && !view.conversation.catchup;
  $("pagingTitle").textContent = view.conversation.catchup
    ? 'Conversation refresh is incomplete. Show more to finish refreshing.' : 'More turns are held';
  if (view.route.targetMsgId && view.conversation.state === 'read'
      && !turnRows(payload).some(turn => turn.msgId === view.route.targetMsgId)) {
    block.hidden = false;
    block.setAttribute('data-state', paging.more ? 'target_pending' : 'target_missing');
    $("turnsStateTitle").textContent = paging.more
      ? 'The linked turn has not been reached. Show more to continue toward it.'
      : 'The linked turn is unavailable in this conversation.';
  }
}

function renderAccess() {
  const payload = payloadOf();
  const rows = accessRows(payload);
  $("accessList").innerHTML = rows.map((row) => `<li class="work-item" data-priority="ordinary" data-grantee="${escapeHtml(row.grantee)}">
    <div><h3 class="access-row">${escapeHtml(row.grantee)}</h3>
    <div class="work-meta"><span>granted by ${escapeHtml(row.grantedBy)} · ${escapeHtml(row.clock)}</span></div></div>
    <div class="stack-end"></div>
  </li>`).join("") || (payload
    ? `<li class="work-item" data-priority="ordinary"><div><h3 class="access-row">Nobody else can read this conversation</h3><div class="work-meta"><span></span></div></div><div class="stack-end"></div></li>`
    : "");
  $("shareControls").innerHTML = shareCandidates(payload, PARTNER_SLUGS).map((row) => `<button class="btn share-toggle" type="button" data-share="${escapeHtml(row.slug)}" aria-pressed="${row.granted}">${row.granted ? "Shared with" : "Not shared with"} ${escapeHtml(row.slug)}</button>`).join("");
  const header = identityHeader(payload);
  for (const id of ["renameInput", "renameSave", "pinToggle", "archiveToggle"]) $(id).disabled = !header;
  $("pinToggle").setAttribute("aria-pressed", header ? String(header.pinned) : "false");
  $("pinToggle").textContent = header?.pinned ? "Unpin this conversation" : "Pin this conversation";
  $("archiveToggle").setAttribute("aria-pressed", header ? String(header.archived) : "false");
  $("archiveToggle").textContent = header?.archived ? "Take this out of the archive" : "Archive this conversation";
}

function renderList() {
  const list = $("conversationList");
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.open : null;
  const payload = view.list.state === "read" ? view.list.payload : null;
  $("visibleCountLine").textContent = visibleCountLine(payload);
  const loading = view.list.state === "pending";
  $("visibleCountLine").hidden = loading;
  const rows = view.list.rows;
  // IN THE VERB'S ORDER. `.map` walks the array as the record layer handed it
  // over; nothing here sorts, filters or regroups, because pinned-first then
  // most-recently-updated is the store's rule and not this page's.
  list.innerHTML = rows.map((row) => `<li class="work-item" data-priority="${row.pinned ? "deadline" : "ordinary"}" data-conversation="${escapeHtml(row.id)}" data-visibility="${escapeHtml(row.visibility)}">
    <div>
      <h3 class="list-title">${escapeHtml(row.title)}</h3>
      <p class="list-meta">${escapeHtml(row.visibility === "shared" ? "shared" : "private")}${row.pinned ? " · pinned" : ""}${row.archived ? " · archived" : ""}${row.latestClock ? ` · last said ${escapeHtml(row.latestClock)}` : ""} · <span class="mono">${escapeHtml(row.id)}</span></p>
      <div class="list-open"><button class="btn" type="button" data-open="${escapeHtml(row.id)}">Open this conversation</button></div>
    </div>
  </li>`).join("");
  if (focusedId) [...list.querySelectorAll("[data-open]")].find(button => button.dataset.open === focusedId)?.focus({ preventScroll: true });
  $("archivedToggle").setAttribute("aria-pressed", String(view.includeArchived));
  $("archivedToggle").textContent = view.includeArchived ? "Hide archived" : "Show archived";
  $("listPagingBlock").hidden = !listPagingState(payload).more;
  const block = $("listState");
  const bare = view.list.state === "read" && rows.length === 0;
  block.hidden = !(loading || bare || view.list.state === "unavailable");
  block.dataset.state = loading ? "loading" : view.list.state === "unavailable" ? "unavailable" : bare ? "empty" : "ready";
  $("listStateTitle").textContent = loading ? "Reading conversations…" : view.list.state === "unavailable"
    ? view.list.sentence
    : (bare ? LIST_EMPTY : "");
}

/**
 * V5-UX-B09 — persistent outcome/owner/phase/next-check/result cards, with
 * qualified routing state. This is a wholly separate read from the open
 * conversation: it is actor-scoped, not conversation-scoped, so it renders
 * regardless of whether a conversation is open.
 *
 * `intentKind` (recommendation vs submission) and `result.available`
 * distinguish recommendation, submission and outcome on the card itself,
 * exactly as the spec's third included-scope clause asks — none of the three
 * is inferred; each is the field the producer actually returned. Rule
 * The V2 look keeps motion to real state changes, so the card adds three
 * still signals and one transition: a freshness dot read from the SERVER's
 * own `as_of` comparison (filled when fresh, hollow when stale), the
 * recommendation → submission → outcome flow line (solid where reached,
 * dashed where not), and `.is-changed` on any field that differed from the
 * previous read, which settles in rather than cutting.
 */
function render() {
  if (!$("listScope")) return;
  renderHero();
  renderTurns();
  renderAccess();
  renderList();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, settled on its own. A failure is classified from its STATUS and its
 * CODE, and a read that lands after a newer one was issued is discarded — the
 * page paints the latest picture it asked for, never the last one that arrived.
 */
async function takeConversation({ after = null, background = false, signal } = {}) {
  if (view.route.state !== "ok") {
    view.conversation = view.route.state === "malformed" ? { state: "malformed" } : { state: "pending" };
    render();
    return;
  }
  const sequence = view.sequence;
  const held = payloadOf();
  if (view.conversation.state === "read") view.conversation = { ...view.conversation, refreshing: true };
  render();
  try {
    const args = { conversation_id: view.route.id, limit: LIMIT };
    const catchup = background ? view.conversation.catchup : null;
    const prefix = catchup?.payload || (Number.isInteger(after) ? held : null);
    if (catchup) args.after_sequence = pagingState(catchup.payload).after;
    else if (Number.isInteger(after)) args.after_sequence = after;
    let payload = await readClient("readDocConversation", args, signal);
    if (view.sequence !== sequence || signal?.aborted) return;
    let pages = catchup ? catchup.pages + 1 : Number.isInteger(after) ? loadedPages.conversation + 1 : 1;
    payload = prefix ? { ...payload, turns: [...prefix.turns, ...payload.turns] } : payload;
    const takePage = createPageBudget();
    takePage();
    // eslint-disable-next-line no-restricted-syntax -- Conversation target traversal has a max of 100 pages; takePage runs before each page read.
    while (pagingState(payload).more && (background ? pages < loadedPages.conversation
      : view.route.targetMsgId && !turnRows(payload).some(turn => turn.msgId === view.route.targetMsgId))) {
      try { takePage(); } catch (error) {
        if (['page_limit', 'read_paused'].includes(error.message)) break;
        throw error;
      }
      const incoming = await readClient("readDocConversation", { ...args, after_sequence: pagingState(payload).after }, signal);
      if (view.sequence !== sequence || signal?.aborted) return;
      if (pagingState(incoming).more && pagingState(incoming).after <= pagingState(payload).after) throw new Error('Conversation paging did not advance');
      payload = { ...incoming, turns: [...payload.turns, ...incoming.turns] };
      pages++;
    }
    if (background && pages < loadedPages.conversation && pagingState(payload).more) {
      view.conversation = { ...view.conversation, refreshing: false, catchup: { payload, pages } };
    } else {
      loadedPages.conversation = pages;
      view.conversation = { state: "read", payload, observed_at: new Date().toISOString() };
    }
  } catch (error) {
    if (view.sequence !== sequence || signal?.aborted) return;
    if ([401,403].includes(error.status)) { invalidateConversations(); return; }
    const failure = classifyReadFailure(error);
    view.conversation = { state: failure.state, sentence: failure.sentence };
  }
  render();
  if (!background && focusedRoute !== view.route && view.route.targetMsgId && view.conversation.state === 'read') {
    const target = [...$("turnList").querySelectorAll('[data-msg-id]')]
      .find(node => node.dataset.msgId === view.route.targetMsgId);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'center' });
      focusedRoute = view.route;
    }
  }
}

/**
 * The list read. One call, one page, and a cursor that is passed back UNREAD.
 *
 * A `cursor` APPENDS: the verb's order is a single sequence across pages, so
 * the next page continues the one on screen and re-sorting the union would
 * destroy the ordering paging exists to preserve. No cursor means a fresh
 * first page, which is what every write settles into.
 */
async function takeList({ cursor = null, background = false, signal } = {}) {
  const sequence = view.sequence;
  const held = cursor ? view.list.rows : [];
  try {
    let payload = await readClient("listDocConversations",
      listArgs({ cursor, includeArchived: view.includeArchived }), signal,
    );
    if (view.sequence !== sequence || signal?.aborted) return;
    if (background) {
      const takePage = createPageBudget();
      // eslint-disable-next-line no-restricted-syntax -- Conversation-list catch-up has a max of 100 pages; takePage runs before each retained-page read.
      for (let page = 1; page < loadedPages.list && listPagingState(payload).more; page++) {
        takePage();
        const incoming = await readClient("listDocConversations", listArgs({ cursor: listPagingState(payload).cursor, includeArchived: view.includeArchived }), signal);
        if (view.sequence !== sequence || signal?.aborted) return;
        payload = { ...incoming, conversations: [...payload.conversations, ...incoming.conversations] };
      }
    } else loadedPages.list = cursor ? loadedPages.list + 1 : 1;
    view.list = { state: "read", payload, rows: [...held, ...listRows(payload)] };
  } catch (error) {
    if ([401,403].includes(error.status)) { invalidateConversations(); return; }
    if (view.sequence !== sequence) return;
    const failure = classifyReadFailure(error);
    view.list = { state: "unavailable", payload: null, rows: held, sentence: failure.sentence };
  }
  render();
}

/**
 * V5-UX-B09's read. Its OWN sequence guard, separate from `view.sequence`,
 * because the outcome cards are actor-scoped rather than tied to whichever
 * conversation happens to be open — a conversation switch must not discard
 * an in-flight cards page, and a cards refresh must not race a slower one.
 *
 * A `cursor` APPENDS, exactly as `takeList` appends: the producer's order is
 * one sequence across pages and re-sorting the union would destroy the
 * `updated_at desc, id desc` ordering paging exists to preserve.
 */
async function load({ background = false, signal } = {}) {
  selectDocRecord('conversation', view.route.state === 'ok' ? view.route.id : null);
  view.sequence += 1;
  await Promise.all([takeConversation({ background, signal }), takeList({ background, signal })]);
  if (signal?.aborted) return;
  const state = conversationState(view.conversation, view.route);
  announce(state.sentence || visibleCountLine(view.list.state === "read" ? view.list.payload : null));

}

/** Opening one sets `?id=` so Back restores the list this page came from. */
function open(id) {
  selectDocRecord('conversation', id);
  const route = idFromSearch(`?id=${id}`);
  view.route = route;
  view.conversation = { state: "pending" };
  try {
    globalThis.history?.pushState?.({ id }, "", `/doc-chats?id=${id}`);
  } catch {
    // A host that refuses history keeps the page; only the address bar lags.
  }
  load();
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary, send) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  if (result.started) operations.set(operationKey, { args: result.request || args, summary, send });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    // eslint-disable-next-line no-restricted-syntax -- Conversation command receipt only; 0 automatic attempts, and any retry requires a fresh user action.
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  // Only the record layer knows what the store now holds, so a settled write
  // re-reads it rather than painting the answer this page hoped for.
  //
  // A conflict re-reads for exactly the same reason and for one more: the
  // re-read is the ONLY source of the version the next attempt may carry. The
  // version the refusal named is evidence that something moved, and using it
  // as the next base would overwrite whatever moved it.
  if (result.status === "ok" || result.status === "conflict") {
    if (result.status === "ok" && operationKey === createOperationKey() && result.response?.conversation_id) {
      open(result.response.conversation_id);
      return result;
    }
    await load();
  }
  return result;
}

function send(operationKey, built, summary, call) {
  if (!built.ok) {
    announce(built.message);
    dock.record(operationKey, { summary, status: "refused", reason: built.message, undo: false });
    return;
  }
  dock.record(operationKey, { summary, status: "sending", undo: false });
  dispatch(operationKey, built.args, summary, call);
}

function create() {
  const built = createArgs({
    title: $("createTitleInput")?.value,
    visibility: $("createVisibility")?.value,
  });
  send(createOperationKey(), built, `Create the conversation "${built.args?.title || ""}"`,
    (request) => client.createDocConversation(request));
}

function rename(change, operationKey, summary) {
  const built = renameArgs(payloadOf(), change);
  send(operationKey, built, summary, (request) => client.renameDocConversation(request));
}

function share(slug, granted) {
  const header = identityHeader(payloadOf());
  const built = shareArgs(header?.id, slug, granted);
  send(shareOperationKey(header?.id, slug), built,
    `${granted ? "Share" : "Stop sharing"} this conversation with ${slug}`,
    (request) => client.shareDocConversation(request));
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so this starts over
    // with the same arguments and a new key, which is the only correct retry.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  const listScope = $("listScope");
  if (!listScope) return;
  mountPrefs();

  mountDock();
  listScope.textContent = LIST_SCOPE;
  $("sharingCaveat").textContent = SHARING_CAVEAT;
  $("titleHistoryLine").textContent = TITLE_HISTORY_UNREADABLE;
  $("exposureStatement").textContent = EXPOSURE_STATEMENT;
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.route = conversationRoute(location);
  $("retryRead")?.addEventListener("click", () => load());
  $("showMore")?.addEventListener("click", () => {
    const paging = pagingState(payloadOf());
    if (view.conversation.catchup) takeConversation({ background: true });
    else if (paging.more) takeConversation({ after: paging.after });
  });
  // The toggle is not a filter over rows this page already holds: it is the
  // verb's `include_archived`, so pressing it costs a fresh read and the page
  // shows exactly what the record layer returns for that argument.
  $("archivedToggle")?.addEventListener("click", () => {
    view.includeArchived = !view.includeArchived;
    view.sequence += 1;
    takeList();
  });
  $("showMoreConversations")?.addEventListener("click", () => {
    const paging = listPagingState(view.list.state === "read" ? view.list.payload : null);
    if (paging.more) takeList({ cursor: paging.cursor });
  });
  for (const list of ["conversationList"]) {
    $(list)?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-open]") : null;
      if (target) open(target.getAttribute("data-open"));
    });
  }
  $("shareControls")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-share]") : null;
    if (target) share(target.getAttribute("data-share"), target.getAttribute("aria-pressed") !== "true");
  });
  $("createSave")?.addEventListener("click", () => create());
  $("renameSave")?.addEventListener("click", () => {
    const header = identityHeader(payloadOf());
    rename({ title: $("renameInput")?.value }, renameOperationKey(header?.id), "Rename this conversation");
  });
  $("pinToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ pinned: !pressed }, pinOperationKey(header?.id), pressed ? "Unpin this conversation" : "Pin this conversation");
  });
  $("archiveToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ archived: !pressed }, archiveOperationKey(header?.id), pressed ? "Unarchive this conversation" : "Archive this conversation");
  });
  globalThis.addEventListener?.("popstate", () => {
    view.route = conversationRoute(globalThis.location);
    view.conversation = { state: "pending" };
    load();
  });
  const boot_ = resolveDealroomBoot(location);
  const outage = params.get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await (await import("./fixture-client.js")).createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  if (!listScope.isConnected) return;
  mountNotificationBadge(client);
  await load();
  if (!listScope.isConnected) return;
  mountAutoRefresh({ document, window: globalThis.window, refresh: ({ signal }) => load({ background: true, signal }) });
}

boot();

export { view };
