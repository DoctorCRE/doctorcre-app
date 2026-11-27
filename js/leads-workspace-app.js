import { partnerName, phoneLabel, withoutRecordCodes } from './visual-system.js';
import { scrollAtEdge } from './touch-layout.js';
import { dealsSaveToEngine } from "./boot-mode.js";
import { parseOpportunityTiming, timingMarkup } from './ui-lead-opportunity-timing.generated.js';
import { parseReachability } from './ui-lead-reachability.generated.js';
import { mountLeadResearch } from './ui-lead-research.generated.js';
import { mountLeadGuidance } from './ui-lead.generated.js';
import { createPageBudget } from './read-budget.mjs';
import { mountContactReasons } from './contact-reasons.mjs';
import { workCard } from './work-card.js';
import { linkRecordNames } from './ui-record-links.generated.js';
import { businessDay, BUSINESS_TIME_ZONE } from './business-date.js';
import { shortDay, toDay } from './calendar-model.js';
import { engagementWriterFor, engagementStorage } from './prospect-engagement.mjs';
import { clearPrivateTextDrafts, privateTextDraft } from "./private-session.js";
import {onDialogClosed} from './dialog-lifecycle.js';
import { observeDocRead, pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from './doc-context.js';
import { createLeadBoardClient, hasLeadVersion, validateLeadWorkspace as validateWorkspace, validateLeadDetail as validateDetail } from "./leads-client.js";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import { BOARD_STAGES, FILTER_STAGES, stageLabel, normalizedStage, eligibleLead, leadTitle, leadMarket, marketKey, specialtyKey,
  visibleLeads, marketCounts, quietLeadIndex, quietFollowUp, stageReview, automaticMove, undoReview, leadTimestamp, leadReachability } from "./leads-model.js";
import { mountTerritoryMap } from "./leads-territory-map.js";

const historyKeys = { correspondence: "id", stage_history: "event_id" };
const historyKinds = Object.keys(historyKeys);
const historyTail = (detail, kind) => detail?.[kind].at(-1)?.[historyKeys[kind]];

const validateLeadWorkspace = value => validateWorkspace(value, parseOpportunityTiming);
const validateLeadDetail = (value, id) => validateDetail(value, id, parseOpportunityTiming);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yearIfNeeded = date => businessDay(date).slice(0, 4) !== businessDay().slice(0, 4) ? "numeric" : undefined;
const shortDate = (value, calendarDate = false) => {
  const day = (calendarDate && toDay(value)) || (Number.isFinite(Date.parse(value)) && businessDay(new Date(value)));
  return day ? shortDay(day, businessDay()) : "Date pending";
};
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-US", { timeZone: BUSINESS_TIME_ZONE, month: "short", day: "numeric", year: yearIfNeeded(new Date(value)), hour: "numeric", minute: "2-digit", hour12: true }) : "—";
const summary = value => String(value || "").split(/\n\s*\n/)[0].slice(0, 230);
const ownerName = owner => owner ? partnerName(owner) : "Unclaimed";
const claimButton = lead => !lead.owner && normalizedStage(lead) !== "archived" ? `<button data-claim="${esc(lead.id)}">Claim</button>` : "";
const readOnlyMessage = "Can't edit right now. Refresh to try again.";
const skeletonCard = '<div class="lead-skeleton" aria-hidden="true"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>';
const options = (rows, selected, all) => `<option value="">${all}</option>${rows.map(([key, text]) => `<option value="${esc(key)}"${key === selected ? " selected" : ""}>${esc(text)}</option>`).join("")}`;

export function mountLeadsWorkspace(doc = document, client = createLeadBoardClient(), { mapFactory = mountTerritoryMap } = {}) {
  const $ = id => doc.getElementById(id), win = doc.defaultView || globalThis.window;
  const quietFilter = $("quietFilter");
  quietFilter.hidden = typeof client.getQuietFollowUps !== "function";
  // The closed strip shows how many reasons the panel shows.
  $("contactReasons")?.addEventListener("contact-reasons-shown", ({ detail }) => {
    $("reasonsCount").textContent = detail ? `(${detail.count}${detail.more ? "+" : ""})` : "";
  });
  const reasons = $("contactReasons") && client.listPracticeOrigination ? mountContactReasons({host:$("contactReasons"),window:win,client}) : null;
  // Home's "All reasons" link lands here, so it opens the strip it points into.
  if (win.location.hash === "#contactReasons" && $("reasonsStrip")) $("reasonsStrip").open = true;
  const engagement = engagementWriterFor(client, engagementStorage(win));
  let researchView = null, researchSubject = null, researchKind = '', researchAttention = '';
  function clearResearch() { researchView?.dispose(); researchView = null; researchSubject = null; researchKind = ''; researchAttention = ''; }
  let guidance = null;
  function clearGuidance() { guidance?.dispose(); guidance = null; clearResearch(); }
  const engagementChecks = new Set();
  const expandedStages = new Set();
  let renderedQuiet;
  let drawerEmailAttempted = false;
  const emailAcknowledgements = new Map();
  const state = { board: null, readFailed: false, actor: null, epoch: 0, detailEpoch: 0, reviewEpoch: 0, quietEpoch: 0, quiet: null, openedRequestedLead: false, showEmptyStages: false, filters: { quiet: false, reachability: "", search: "", owner: "", stage: "", market: "", specialty: "" },
    historyRequest: null, historyError: null, selectedId: null, detail: null, detailId: null, resumeDetail: null, resumeReview: null, commandFeedback: null, connectionFeedback: null, proposal: null, reviewTarget: null, pending: null, writing: false, identityReady: false, trigger: null, drag: null, map: null };
  const leadById = id => state.board?.leads.find(lead => lead.id === id && eligibleLead(lead));
  const canEditLead = lead => hasLeadVersion(lead) && hasLeadVersion(leadById(lead.id));
  const reviewComplete = (lead, target, undoEventId) => (undoEventId ? lead.stage : normalizedStage(lead)) === target;
  const reviewAnswer = (actor, id, target, undoEventId) => privateTextDraft(win, actor, "lead-review", id, target, undoEventId);
  function clearReviewAnswer(pending) {
    if (pending.kind === "stage") reviewAnswer(pending.actor, pending.lead.id, pending.stage, pending.review.undo_event_id ?? null).write("");
  }
  function captureReviewDraft() {
    const draft = state.reviewTarget, input = $("stageQuestions").querySelector("textarea");
    if (draft && input) draft.answer = input.value;
    return draft;
  }
  const followUp = lead => state.quiet?.rows && quietFollowUp(state.quiet.rows, lead);
  function paintDetailFollowUp() {
    const lead = leadById(state.detailId);
    const row = lead && followUp(lead);
    const target = $("detailFollowUp");
    target.hidden = !row;
    if (!row) { target.textContent = ""; return; }
    const { last_contact_on: lastContact = row.basis === "last_contact" ? row.anchor_on : null } = row;
    const basis = lastContact ? `Last contact ${shortDate(lastContact, true)}.` : `No contact recorded. Added ${shortDate(row.anchor_on, true)}.`;
    target.textContent = `${basis} Follow-up due ${shortDate(row.due_on, true)}.`;
  }
  function card(lead) {
    const editable = hasLeadVersion(lead);
    const dragHandle = editable ? '<span class="drag-handle" data-drag-handle aria-hidden="true"></span>' : "";
    const badge = lead.new_from_email && emailAcknowledgements.get(lead.id) !== "cleared"
      ? '<span class="lead-email-badge">New from email</span>' : "";
    return workCard({ variant: "tile", className: "lead-card", attributes: `data-lead-id="${esc(lead.id)}" data-selected="${lead.id === state.selectedId}" draggable="${editable}"`,
      title: `${dragHandle}<button class="lead-open" data-open="${esc(lead.id)}" aria-pressed="${lead.id === state.selectedId}">${esc(leadTitle(lead))}</button>`,
      meta: esc(ownerName(lead.owner)),
      status: followUp(lead)?.days_overdue > 0 ? "Follow-up late" : "",
      body: badge + (editable ? "" : `<p>${readOnlyMessage}</p>`),
      actions: claimButton(lead) });
  }
  function focusIdentity(node) {
    const container = node?.closest?.("#leadBoard, #detailBody, #marketCounts, #territoryMapFrame");
    if (container) {
      for (const attr of ["data-claim", "data-undo", "data-link", "data-open", "data-lead-id", "data-market", "data-expand-stage", "data-map-lead", "data-map-marker"]) {
        if (node.hasAttribute(attr)) return { container: container.id, attr, value: node.getAttribute(attr), client: node.dataset.clientId };
      }
    }
    return node?.id ? { id: node.id } : null;
  }
  function restoreFocus(identity) {
    if (!identity) return;
    const node = identity.id ? $(identity.id) : [...$(identity.container).querySelectorAll(`[${identity.attr}]`)]
      .find(node => node.getAttribute(identity.attr) === identity.value && node.dataset.clientId === identity.client);
    (node || $(identity.container === "detailBody" ? "closeDetail" : "refreshBoard")).focus({ preventScroll: true });
  }
  const emptyStagesNote = count => count ? `<p class="stages-hidden"><span>${state.showEmptyStages ? `Showing ${count} stage${count === 1 ? "" : "s"} with no leads` : `${count} stage${count === 1 ? "" : "s"} hidden`}</span> <button type="button" data-toggle-empty-stages aria-pressed="${state.showEmptyStages}"><span aria-hidden="true">${state.showEmptyStages ? "− " : "+ "}</span>${state.showEmptyStages ? "Hide empty stages" : "Show empty stages"}</button></p>` : "";
  function render() {
    renderedQuiet = state.quiet;
    const focused = focusIdentity(doc.activeElement);
    const boardScroll = $("leadBoard").querySelector(".stage-columns")?.scrollLeft || 0;
    const laneScroll = new Map([...$("leadBoard").querySelectorAll("[data-stage]")].map(node => [node.dataset.stage, node.querySelector(".lead-stack").scrollTop]));
    const leads = state.board?.leads || [];
    const owners = [...new Set(leads.filter(eligibleLead).map(l => l.owner).filter(Boolean))].sort();
    const markets = [...new Set(leads.filter(eligibleLead).map(marketKey))].sort();
    const specialties = [...new Set([...leads.filter(eligibleLead).map(specialtyKey), state.filters.specialty].filter(Boolean))].sort();
    if (state.board && state.filters.owner !== "unclaimed" && !owners.includes(state.filters.owner)) state.filters.owner = "";
    if (state.board && !markets.includes(state.filters.market)) state.filters.market = "";
    const cohort = state.filters.quiet ? leads.filter(followUp) : leads;
    const shown = visibleLeads(cohort, state.filters);
    quietFilter.setAttribute("aria-pressed", String(state.filters.quiet));
    quietFilter.disabled = !state.quiet?.rows && !state.filters.quiet;
    if (!shown.some(lead => lead.id === state.selectedId)) state.selectedId = null;
    if (state.detailId && leads.some(lead => lead.id === state.detailId) && !shown.some(lead => lead.id === state.detailId)) {
      clearGuidance(); ++state.detailEpoch; state.detailId = null; state.detail = null; $("leadDetail").close();
    }
    paintDetailFollowUp();
    const contactCohort = visibleLeads(cohort, { ...state.filters, reachability: "" });
    const hasReachability = classification => contactCohort.some(lead => leadReachability(lead) === classification);
    $("reachabilityFilter").value = state.filters.reachability;
    $("reachabilityFilter").parentElement.hidden = !state.filters.reachability &&
      !(hasReachability("reachable") && hasReachability("research"));
    if (state.identityReady) {
      setDocFilters(state.filters);
      if (state.board) publishDocRead("getWorkspace", { ...state.board, leads: shown });
    }
    const loading = !state.board && !state.readFailed;
    $("leadBoard").toggleAttribute("data-unavailable", !state.board && state.readFailed);
    const quietUnavailable = state.filters.quiet && !state.quiet?.rows;
    const resultsReady = state.board && !quietUnavailable;
    const count = `${shown.length} ${shown.length === 1 ? "lead" : "leads"}`;
    const quietStatus = $("quietStatus");
    quietStatus.textContent = state.quiet?.error || (resultsReady && state.filters.quiet
      ? `Showing ${shown.length} quiet ${shown.length === 1 ? "lead" : "leads"}` : "");
    quietStatus.hidden = !quietStatus.textContent;
    $("leadCount").textContent = resultsReady ? count : loading ? "Loading leads…" : "";
    $("filterSummary").textContent = resultsReady ? `${shown.length} matching ${shown.length === 1 ? "lead" : "leads"}` : "";
    const ownerOptions = owners.map(k => [k, ownerName(k)]);
    $("ownerFilter").innerHTML = options([...ownerOptions, ["unclaimed", "Unclaimed"]], state.filters.owner, "All owners");
    const groups = marketCounts(cohort, state.filters, state.map?.locate);
    $("marketFilter").innerHTML = options(markets.map(k => [k, k]), state.filters.market, "All markets");
    $("specialtyFilter").innerHTML = options(specialties.map(k => [k, k]), state.filters.specialty, "All specialties");
    $("clearMarket").hidden = !state.filters.market;
    $("marketCounts").innerHTML = groups.map(g => `<button data-market="${esc(g.key)}" aria-pressed="${g.key === state.filters.market}"><span>${esc(g.key)}</span><b>${g.count}</b></button>`).join("") || (state.board ? '<p class="empty">No leads in these markets</p>' : "");
    foldMarkets();
    state.map?.update(groups, state.selectedId);
    const currentStage = state.filters.stage;
    const stageCount = stage => resultsReady ? ` · ${visibleLeads(cohort, { ...state.filters, stage }).length}` : "";
    $("stageFilter").innerHTML = options(
      FILTER_STAGES.map(([key, label]) => [key, label + stageCount(key)]), currentStage, "All stages" + stageCount("")
    );
    $("territoryMap").setAttribute("aria-busy", String(loading));
    if (loading) {
      $("leadBoard").innerHTML = '<span class="sr-only" role="status">Loading leads…</span><div class="stage-columns" aria-hidden="true">' + BOARD_STAGES.map(() => `<section class="stage-column"><div class="stage-head"><span class="skeleton-line"></span></div><div class="lead-stack">${skeletonCard.repeat(2)}</div></section>`).join("") + '</div>';
    } else if (!resultsReady) {
      $("leadBoard").replaceChildren();
    } else if (!shown.length && Object.values(state.filters).some(Boolean)) {
      $("leadBoard").innerHTML = '<div class="filtered-empty"><p>No leads match these filters.</p><button id="resetFilters">Reset filters</button></div>';
      $("resetFilters").addEventListener("click", () => {
        state.filters = { quiet: false, reachability: "", search: "", owner: "", stage: "", market: "", specialty: "" };
        $("leadSearch").value = "";
        render();
        $("leadSearch").focus({ preventScroll: true });
      });
    } else if (!shown.length) {
      $("leadBoard").innerHTML = '<div class="filtered-empty"><p>No active leads are on the board.</p><button id="refreshEmptyBoard">Refresh leads</button></div>';
      $("refreshEmptyBoard").addEventListener("click", () => refresh());
    } else if (state.filters.stage === "archived") {
      $("leadBoard").innerHTML = `<div class="filtered-list" aria-label="${stageLabel(state.filters.stage)}">${shown.map(card).join("") || '<p class="empty">No matching leads</p>'}</div>`;
    } else {
      $("leadBoard").innerHTML = `<div class="stage-columns">${BOARD_STAGES.map(([key, text]) => {
        const rows = shown.filter(lead => normalizedStage(lead) === key), expanded = rows.length > 5 && expandedStages.has(key);
        return `<section class="stage-column" data-expanded="${expanded}" data-mobile-current="${!currentStage || key === currentStage}"${rows.length ? "" : " data-empty"}${!currentStage && !rows.length && !state.showEmptyStages ? ' data-hide-empty="true"' : ""} data-stage="${key}" aria-label="${text}"><h2 class="stage-head">${text}<span>${rows.length}</span>${rows.length > 5 ? `<button type="button" data-expand-stage="${key}" aria-expanded="${expanded}" aria-controls="leads-${key}" aria-label="${expanded ? `Collapse ${text} to 5 leads` : `Show all ${rows.length} ${text} leads`}">${expanded ? "Collapse" : "Show all"}</button>` : ""}</h2><div class="lead-stack" id="leads-${key}">${(expanded ? rows : rows.slice(0, 5)).map(card).join("") || `<p class="stage-empty">No leads in ${text}</p>`}</div></section>`;
      }).join("")}${emptyStagesNote(currentStage ? 0 : BOARD_STAGES.filter(([key]) => !shown.some(lead => normalizedStage(lead) === key)).length)}</div><button type="button" class="lane-cue" data-lane-step="-1" hidden>‹</button><button type="button" class="lane-cue" data-lane-step="1" hidden></button>`;
    }

    // The time states the snapshot on screen, as Deals does: a failed refresh
    // that keeps the board keeps its time beside the reconnecting line, and
    // only a failed read with nothing to show is "Unavailable".
    $("boardUpdated").textContent = state.board ? updatedLabel(state.board.generated_at, BUSINESS_TIME_ZONE) : state.readFailed ? "Unavailable" : "Updating…";
    $("boardUpdated").dateTime = state.board?.generated_at || "";
    $("searchUpdated").textContent = state.board?.last_search_at ? `New-lead search ${stamp(state.board.last_search_at)}` : "";
    paintWriteControls();
    const columns = $("leadBoard").querySelector(".stage-columns");
    if (columns) columns.scrollLeft = boardScroll;
    paintLaneCue();
    for (const node of $("leadBoard").querySelectorAll('[data-expanded="true"]')) node.querySelector(".lead-stack").scrollTop = laneScroll.get(node.dataset.stage) || 0;
    if (focused?.container) restoreFocus(focused);
  }
  // Names the stages scrolled off either side of the board, so none is missed.
  function paintLaneCue() {
    const columns = $("leadBoard").querySelector(".stage-columns"), [back, ahead] = $("leadBoard").querySelectorAll("[data-lane-step]");
    if (!columns || !ahead) return;
    const edge = columns.getBoundingClientRect();
    const lanes = [...columns.querySelectorAll(".stage-column")].filter(node => node.offsetWidth), boxes = lanes.map(node => node.getBoundingClientRect());
    const stages = count => count === 1 ? "stage" : "stages";
    const before = boxes.filter(box => box.left < edge.left - 1).length, after = boxes.filter(box => box.right > edge.right + 1).length;
    const handoff = doc.activeElement === back && !before ? ahead : doc.activeElement === ahead && !after ? back : null;
    back.hidden = !before; back.setAttribute("aria-label", `${before} earlier ${stages(before)}`);
    ahead.hidden = !after; ahead.setAttribute("aria-label", `${after} more ${stages(after)}`); ahead.innerHTML = `${after} more <span aria-hidden="true">›</span>`;
    columns.style.setProperty("--cue-ahead", `${ahead.offsetWidth}px`);
    for (const [index, lane] of lanes.entries()) {
      lane.toggleAttribute("data-under-back", Boolean(before) && index === before);
      lane.toggleAttribute("data-under-ahead", Boolean(after) && index === lanes.length - after - 1);
    }
    // A cue that runs out of stages hands focus to the other one instead of dropping it.
    if (handoff && !handoff.hidden) handoff.focus({ preventScroll: true });
  }
  function scrollLanes(step) {
    const columns = $("leadBoard").querySelector(".stage-columns");
    const lane = [...columns.querySelectorAll(".stage-column")].find(node => node.offsetWidth);
    if (!lane) return;
    const reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    columns.scrollBy({ left: step * (lane.offsetWidth + parseFloat(win.getComputedStyle(columns).columnGap || "0")), behavior: reduce ? "instant" : "smooth" });
  }
  function paintWriteControls() {
    const disabled = !state.identityReady || state.writing || Boolean(state.pending);
    const detailEditable = canEditLead(state.detail);
    for (const control of $("leadBoard").querySelectorAll("[data-claim]")) {
      control.disabled = disabled || !hasLeadVersion(leadById(control.dataset.claim));
    }
    for (const control of $("detailBody").querySelectorAll("[data-claim], [data-link], [data-undo], #detailStage")) {
      control.disabled = disabled || !detailEditable;
    }
    const note = $("leadReadOnly");
    if (note) note.hidden = detailEditable;
    const activationForm = $("activateProspect");
    if (activationForm) {
      activationForm.elements.reason.disabled = !detailEditable;
      activationForm.querySelector("button").disabled = !state.identityReady || !detailEditable ||
        Boolean(engagement.get(state.detail?.prospect_client_id, state.actor)?.sending);
    }
    $("checkDetailPending").disabled = state.writing;
  }
  function paintCommandFeedback() {
    paintWriteControls();
    const box = $("leadBoardError");
    const pending = state.pending;
    $("leadDetailRecovery").hidden = !($("leadDetail").open && pending && pending.kind !== "stage" && pending.lead.id === state.detailId);
    const command = state.pending ? 'Confirmation pending <button id="checkPending">Check outcome</button>' : esc(state.commandFeedback);
    const engagements = engagement.values(state.actor).map(pending => `${esc(leadTitle(state.board?.leads.find(lead => lead.prospect_client_id === pending.request.client_id) || { name: "Prospect" }))}: Confirmation pending <button data-check-engagement="${esc(pending.request.client_id)}"${pending.sending ? " disabled" : ""}>Check outcome</button>`);
    box.hidden = !state.pending && !engagements.length && !state.commandFeedback && !state.connectionFeedback;
    box.innerHTML = [command, ...engagements, esc(state.connectionFeedback)].filter(Boolean).join(" · ");
    if (!state.actor && state.connectionFeedback === "Sign-in required") box.insertAdjacentHTML("beforeend", ` · <a href="/auth/login?return_to=${encodeURIComponent(win.location.pathname + win.location.search)}">Sign in</a>`);
    if (state.readFailed && state.connectionFeedback && state.connectionFeedback !== "Sign-in required") {
      box.insertAdjacentHTML("beforeend", ' <button type="button" id="retryLeadRead">Retry</button>');
      $("retryLeadRead").addEventListener("click", () => auto.refresh());
    }
    $("checkPending")?.addEventListener("click", executePending);
    for (const button of box.querySelectorAll("[data-check-engagement]")) button.addEventListener("click", () => executeEngagement(engagement.get(button.dataset.checkEngagement, state.actor)?.request));
    const form = $("activateProspect"), activation = engagement.get(state.detail?.prospect_client_id, state.actor);
    if (form) {
      form.elements.reason.readOnly = Boolean(activation);
      if (activation) form.elements.reason.value = activation.request.reason;
      form.querySelector("button").textContent = activation ? "Check outcome" : "Mark active";
    }
    if (state.pending && $("stageDialog").open) {
      $("saveStage").textContent = "Check outcome"; $("saveStage").disabled = state.writing;
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = true;
    }
  }
  function clearPrivateView() {
    clearPrivateTextDrafts(win, state.actor);
    emailAcknowledgements.clear();
    clearGuidance();
    clearQuiet();
    expandedStages.clear();
    pageDocContext?.clear();
    state.historyRequest = null; state.historyError = null;
    state.selectedId = null; state.commandFeedback = null; state.connectionFeedback = null; state.board = null; state.detailId = null; state.detail = null; state.proposal = null; state.reviewTarget = null; state.resumeReview = null; state.resumeDetail = null; state.pending = null;
    state.filters = { quiet: false, reachability: "", search: "", owner: "", stage: "", market: "", specialty: "" }; state.trigger = null; state.drag = null;
    $("leadSearch").value = ""; $("detailTitle").textContent = ""; $("stageTitle").textContent = "";
    $("stageError").textContent = ""; $("moveAnnouncement").textContent = ""; $("saveStage").disabled = true;
    ++state.detailEpoch; ++state.reviewEpoch; $("leadDetail").close(); $("stageDialog").close();
    $("detailBody").innerHTML = ""; $("stageContext").innerHTML = ""; $("stageQuestions").innerHTML = "";
    render();
  }
  function authorizationFailure(error) {
    if (!["unauthorized", "not_authenticated", "forbidden"].includes(error.code) && ![401, 403].includes(error.status)) return false;
    ++state.epoch; state.readFailed = true; state.identityReady = false; clearPrivateView(); state.actor = null;
    $("leadBoard").setAttribute("aria-busy", "false");
    state.connectionFeedback = "Sign-in required";
    paintCommandFeedback();
    return true;
  }
  // Resolves false when the read failed for a reason other than sign-in, so
  // background refresh retries soon; a superseded read resolves undefined.
  const sessionDenied = error => ["unauthorized", "not_authenticated"].includes(error?.code) || [401, 403].includes(error?.status);
  function clearQuiet() {
    ++state.quietEpoch;
    state.quiet = null;
  }
  function startQuietRead(boardEpoch) {
    if (quietFilter.hidden) return;
    const epoch = ++state.quietEpoch;
    const current = () => epoch === state.quietEpoch && boardEpoch === state.epoch;
    const paint = () => {
      if (state.board && $("leadBoard").getAttribute("aria-busy") === "false" && !state.drag && !touch) render();
    };
    client.getQuietFollowUps().then(payload => {
      if (!current()) return;
      state.quiet = { rows: quietLeadIndex(payload.proposals) };
      paint();
    }, error => {
      if (!current() || (sessionDenied(error) && authorizationFailure(error))) return;
      state.quiet = { error: "Quiet leads unavailable. Refresh to try again." };
      paint();
    });
  }
  async function openRequestedLead() {
    if (state.openedRequestedLead || !state.board) return;
    const ref = new URL(win.location.href).searchParams.get("lead");
    if (!ref) return;
    state.openedRequestedLead = true;
    const lead = state.board.leads.find(row => row.registry_ref === ref || row.id === ref);
    if (lead) {
      if (eligibleLead(lead)) return readDetail(lead.id);
      return;
    }
    if (!UUID.test(ref)) return;
    const { actor, detailEpoch } = state;
    try {
      const { detail } = await client.getLeadDetail({ id: ref });
      if (detailEpoch !== state.detailEpoch || actor !== state.actor || !state.identityReady || !detail?.party_id) return;
      // The engine echoes the requested UUID; party_id identifies the board record.
      const row = state.board?.leads.find(lead => lead.party_id === detail.party_id && eligibleLead(lead));
      if (row && eligibleLead(detail)) return readDetail(row.id, { resolvedDetail: { ...detail, id: row.id } });
    } catch (error) {
      if (detailEpoch === state.detailEpoch && actor === state.actor) authorizationFailure(error);
    }
  }
  async function refresh() {
    if (disposed) return false;
    const detailFocus = focusIdentity(doc.activeElement);
    pageDocContext?.clear();
    const epoch = ++state.epoch;
    startQuietRead(epoch);
    state.identityReady = false;
    paintWriteControls();
    $("leadBoard").setAttribute("aria-busy", "true");
    // The board read rides the same session cookie, so it starts beside the identity check; nothing renders until both agree.
    const workspace = client.getWorkspace();
    workspace.catch(() => {});
    try {
      const actor = await client.getActor();
      if (epoch !== state.epoch) return;
      if (!actor) throw Object.assign(new Error("Sign-in required"), { code: "unauthorized" });
      if (state.actor && actor !== state.actor) { clearPrivateView(); startQuietRead(epoch); }
      state.actor = actor;
      state.identityReady = true;
      const response = await observeDocRead("getWorkspace", [], () => workspace);
      if (epoch !== state.epoch) return;
      const next = validateLeadWorkspace(response);
      const leads = next.leads.map(lead => {
        try { parseReachability(lead.reachability); }
        catch (error) {
          if (error?.code !== "invalid_projection") throw error;
          return { ...lead, reachability: null };
        }
        return lead;
      });
      state.connectionFeedback = null;
      state.readFailed = false; state.board = { ...next, leads };
      for (const lead of leads) engagement.confirm({ client_id: lead.prospect_client_id,
        status: lead.prospect_engagement_status, version: lead.prospect_client_version }, state.actor);
      if (state.pending) {
        const current = leads.find(l => l.id === state.pending.lead.id);
        const move = current?.last_stage_move;
        if ((state.pending.kind === "link" && current?.client_id === state.pending.clientId) ||
            (state.pending.kind === "stage" && move?.idempotency_key === state.pending.key) ||
            (state.pending.kind === "claim" && current?.owner === state.pending.actor)) {
          clearReviewAnswer(state.pending);
          state.pending = null; state.commandFeedback = null; $("stageDialog").close();
        }
      }
      render();
      paintCommandFeedback();
      const resumeReview = state.resumeReview;
      state.resumeReview = null;
      if (resumeReview?.actor === state.actor && !state.pending) {
        await openReview(resumeReview.id, resumeReview.target, { undoEventId: resumeReview.undoEventId, draft: resumeReview });
      }
      if (!resumeReview && state.reviewTarget && $("stageDialog").open && !state.writing && !state.pending) {
        const { id, target, undoEventId } = state.reviewTarget, current = leadById(id);
        if (!hasLeadVersion(current) || reviewComplete(current, target, undoEventId)) $("stageDialog").close();
        else await openReview(id, target, { updating: true, undoEventId });
      }
      const resumeDetail = state.resumeDetail;
      if (resumeDetail && (resumeDetail.actor !== state.actor || !leadById(resumeDetail.id))) state.resumeDetail = null;
      if (state.resumeDetail) await readDetail(resumeDetail.id, { intent: resumeDetail });
      else if (state.detailId && $("leadDetail").open) {
        if (leadById(state.detailId)) {
          const detailEpoch = state.detailEpoch, dialog = $("leadDetail");
          const history = state.historyRequest;
          if (history?.epoch === detailEpoch) await history.done;
          if (epoch !== state.epoch) return;
          if (detailEpoch === state.detailEpoch && dialog.open) {
            await readDetail(state.detailId, { open: false });
            if (dialog.open && detailFocus?.container === "detailBody" && detailFocus.value === state.detailId &&
                (doc.activeElement === doc.body || doc.activeElement === dialog)) restoreFocus(detailFocus);
          }
        } else if (leads.some(lead => lead.id === state.detailId)) { state.detail = null; $("leadDetail").close(); }
        else { clearGuidance(); state.detail = null; ++state.detailEpoch; $("detailTitle").textContent = "Lead unavailable"; $("detailBody").innerHTML = '<p class="empty">Unavailable</p>'; }
      }
      openRequestedLead();
      return true;
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.readFailed = true;
      if (authorizationFailure(error)) return;
      // A refused verification/read cannot leave the previous private snapshot visible, nor a board read that ran beside it.
      if (!state.identityReady) { state.board = null; pageDocContext?.clear(); }
      state.identityReady = false; state.detail = null; state.detailId = null;
      ++state.detailEpoch; state.trigger = null;
      clearGuidance(); $("leadDetail").close(); $("detailTitle").textContent = ""; $("detailBody").replaceChildren();
      render();
      state.connectionFeedback = error.code === "invalid_projection" ? `Leads couldn't be loaded.${state.board ? " Showing the last update." : ""}` : state.board ? "Connection interrupted · Source stale · reconnecting…" : "Connection interrupted · reconnecting…";
      paintCommandFeedback();
      return false;
    } finally {
      if (epoch === state.epoch) {
        $("leadBoard").setAttribute("aria-busy", "false");
        if (state.board && state.identityReady && renderedQuiet !== state.quiet && !state.drag && !touch) render();
      }
      paintWriteControls();
    }
  }
  function historySummary(detail, kind) {
    const page = detail[`${kind}_page`];
    if (!page) return '<p>History counts unavailable</p>';
    const count = detail[kind].length;
    const entries = kind === "correspondence" ? "captured entries" : "stage changes";
    const counts = `<p>Showing ${count} of ${page.total} ${entries}${page.has_more ? ". Newest entries first." : "."}</p>`;
    if (!page.has_more) return counts;
    const unavailable = state.historyError?.kind === kind ? '<p role="status">Older entries unavailable. Try again.</p>' : "";
    const label = state.historyRequest?.kind === kind ? "Loading…" : kind === "correspondence" ? "Load older correspondence" : "Load older stage changes";
    return `${counts}${unavailable}<button type="button" id="load-${kind}" data-load-history="${kind}"${state.historyRequest ? " disabled" : ""}>${label}</button>`;
  }
  function paintDetail(detail, intent = null) {
    const active = doc.activeElement;
    const focusedEntry = active?.matches("summary") ? active.closest("#detailBody details")?.dataset.entryKey : null;
    const focusedId = $("detailBody").contains(active) ? active.id : null;
    const focusedAction = focusIdentity(active);
    const expanded = new Set(intent?.expanded ?? [...$("detailBody").querySelectorAll("details[open]")].map(node => node.dataset.entryKey));
    const scroll = intent?.scroll ?? $("leadDetail").scrollTop;
    $("detailTitle").textContent = leadTitle(detail);
    const fields = [
      ["Owner", esc(ownerName(detail.owner_label || detail.owner))],
      ["Phone", detail.phone && `<a href="tel:${esc(detail.phone)}">${esc(phoneLabel(detail.phone))}</a>`],
      ["Email", detail.email && `<a href="mailto:${esc(detail.email)}">${esc(detail.email)}</a>`],
      ["Market", esc(leadMarket(detail))],
      ["Vertical", esc(detail.specialty || detail.vertical)],
    ];
    const plans = (detail.plans ?? detail.notes ?? "").split(/\n\s*\n/)
      .map(text => withoutRecordCodes(text.replace(/\bT\d+\s+(?:open|closed)\b[.]?/gi, ""))).filter(Boolean);
    const [plan, ...planDetails] = plans;
    const leaseDate = toDay(detail.est_lease_event);
    const lastArchive = detail.stage_history.find(entry => entry.stage === "archived");
    const becameDeal = normalizedStage(detail) === "archived" && lastArchive?.reason === "became a deal in the old system";
    const move = automaticMove(detail), undo = undoReview(detail);
    const source = detail.source_email;
    const sourceExcerpt = source && summary(source.summary?.trim() || source.detail?.trim());
    const selectedKind = researchSubject === detail.id ? researchKind : '';
    const selectedAttention = researchSubject === detail.id ? researchAttention : '';
    clearGuidance();
    $("detailBody").innerHTML = `<section class="detail-summary">${detail.score == null ? "" : `<div><h3>Lead score</h3><div class="detail-score">${esc(Math.round(Number(detail.score)))}<span>/ 100</span></div></div>`}<label>Stage<select id="detailStage">${FILTER_STAGES.filter(([key]) => key !== "do_not_contact").map(([key,text]) => `<option value="${key}"${normalizedStage(detail) === key ? " selected" : ""}>${text}</option>`).join("")}</select></label></section>
      ${becameDeal ? '<p class="detail-archive-reason">Became a deal.</p>' : ""}
      <p id="leadReadOnly" hidden>${readOnlyMessage}</p>
      <div class="detail-actions">${claimButton(detail)}
        ${move ? `<div class="auto-move">Moved automatically: ${esc(move.reason || "stage updated")} ${shortDate(move.evidence_date || move.occurred_at, !!move.evidence_date)}${undo ? `<button data-undo="${esc(detail.id)}">Undo</button>` : ""}</div>` : ""}
        ${detail.possible_clients.map(match => `<button class="client-hint" data-link="${esc(detail.id)}" data-client-id="${esc(match.client_id)}">Link to client ${esc(match.name)}</button>`).join("")}
      </div>
      <div class="detail-overview"><section class="detail-panel"><h3>Contact</h3><dl>${fields.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl></section>
      ${plan || leaseDate ? `<section class="detail-panel"><h3>Plans</h3>${plan ? `<p>${linkRecordNames(plan, detail.record_links)}</p>` : ""}${planDetails.length ? `<details class="plan-details" data-entry-key="plans"><summary>More about these plans</summary><div class="original-entry">${linkRecordNames(planDetails.join("\n\n"), detail.record_links)}</div></details>` : ""}${leaseDate ? `<dl class="plan-window"><dt>Estimated lease date</dt><dd><time datetime="${esc(leaseDate)}">${esc(shortDate(leaseDate, true))}</time></dd></dl>` : ""}</section>` : ""}
      </div>
      ${source ? `<section class="detail-panel"><h3>Source email</h3><time>${stamp(source.occurred_at)}</time>${sourceExcerpt ? `<p>${esc(sourceExcerpt)}</p>` : ""}${source.detail?.trim() ? `<details data-entry-key="source-email"><summary>Details</summary><div class="original-entry">${esc(source.detail)}</div></details>` : ""}</section>` : ""}
      ${timingMarkup(detail.opportunity_timing, true, !!leaseDate)}
      <div id="leadGuidance"></div>
      <div id="leadResearch"></div>
      ${!dealsSaveToEngine(doc) && detail.prospect_client_id && detail.prospect_engagement_status === "inactive" ? `<form id="activateProspect"><p>Mark active to return this prospect to the deal board.</p><label>Reason<input name="reason" maxlength="1000" required></label><button type="submit">Mark active</button></form>` : ""}
      <div class="detail-columns"><section class="detail-panel"><h3>Captured correspondence</h3><p>Other communication may not have been captured.</p>${historySummary(detail, "correspondence")}<ol class="correspondence">${(detail.correspondence || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time><p>${esc(summary(entry.summary))}</p><details data-entry-key="${esc(entry.id)}"><summary>Details</summary><div class="original-entry">${esc(entry.detail || entry.summary)}</div></details></li>`).join("") || '<li class="empty">No captured correspondence</li>'}</ol></section><section class="detail-panel"><h3>Stage history</h3>${historySummary(detail, "stage_history")}<ol class="history">${(detail.stage_history || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time>${esc(stageLabel(entry.prior_stage))} → ${esc(stageLabel(entry.stage))}${entry.reason ? `<br><small>${esc(summary(entry.reason))}</small>` : ""}</li>`).join("") || '<li class="empty">No stage changes</li>'}</ol></section></div>`;
    researchSubject = detail.id;
    researchKind = detail.research?.evidence.some(item => item.kind === selectedKind) ? selectedKind : '';
    researchAttention = selectedAttention;
    researchView = mountLeadResearch($("leadResearch"), detail.research, researchKind, kind => { researchKind = kind; }, { attention: researchAttention, onAttention: attention => { researchAttention = attention; } });
    if (!becameDeal || detail.do_not_contact || detail.suppressed) guidance = mountLeadGuidance($("leadGuidance"), detail);
    for (const button of $("detailBody").querySelectorAll("[data-load-history]")) button.addEventListener("click", () => loadHistory(button.dataset.loadHistory));
    $("detailStage").addEventListener("change", event => openReview(detail.id, event.target.value));
    $("activateProspect")?.addEventListener("submit", event => {
      event.preventDefault();
      const reason = event.currentTarget.elements.reason.value.trim();
      if (reason) command({kind:"engagement",lead:detail,reason});
    });
    for (const node of $("detailBody").querySelectorAll("details")) node.open = expanded.has(node.dataset.entryKey);
    const focused = focusedId ? $(focusedId) : [...$("detailBody").querySelectorAll("details")]
      .find(node => node.dataset.entryKey === focusedEntry)?.querySelector("summary");
    if (focusedAction?.container === "detailBody") restoreFocus(focusedAction);
    else focused?.focus({ preventScroll: true });
    $("leadDetail").scrollTop = scroll;
    paintCommandFeedback();
  }
  function appendHistory(detail, nextDetail, kind) {
    const page = detail[`${kind}_page`], next = nextDetail[`${kind}_page`];
    if (!next || (next.has_more && JSON.stringify(next.next_cursor) === JSON.stringify(page.next_cursor))) throw new Error("History did not advance");
    const key = historyKeys[kind];
    const entries = new Map(detail[kind].map(entry => [entry[key], entry]));
    for (const entry of nextDetail[kind]) entries.set(entry[key], entry);
    if (entries.size === detail[kind].length && next.has_more) throw new Error("History did not advance");
    return { ...detail, [kind]: [...entries.values()], [`${kind}_page`]: next };
  }
  function loadHistory(kind) {
    const detail = state.detail, page = detail?.[`${kind}_page`];
    if (!state.identityReady || !detail || !page?.has_more || !page.next_cursor || state.historyRequest) return;
    const request = { kind, epoch: state.detailEpoch, actor: state.actor, detail };
    state.historyRequest = request; state.historyError = null;
    request.done = readHistoryPage(request, page.next_cursor);
  }
  async function readHistoryPage(request, cursor) {
    const { kind, detail } = request;
    paintDetail(detail);
    const current = () => request.epoch === state.detailEpoch && request.actor === state.actor &&
      state.detail === detail && state.detailId === detail.id && $("leadDetail").open;
    try {
      const response = await client.getLeadDetail(detail, { [`${kind}_cursor`]: cursor });
      if (!current()) return;
      if (!response.detail || !leadById(detail.id) || !eligibleLead(response.detail)) {
        state.detail = null; $("leadDetail").close(); return;
      }
      validateLeadDetail(response.detail, detail.id);
      state.detail = appendHistory(detail, response.detail, kind);
    } catch (error) {
      if (!current() || authorizationFailure(error)) return;
      state.historyError = { kind };
    } finally {
      if (state.historyRequest === request) {
        state.historyRequest = null;
        if (request.epoch === state.detailEpoch && request.actor === state.actor && state.detail && $("leadDetail").open) paintDetail(state.detail);
      }
    }
  }
  function clearEmailBadge(id) {
    emailAcknowledgements.set(id, "cleared");
    if (!state.drag && !touch) render();
  }
  async function acknowledgeDrawerEmail(lead, actor) {
    if (!canEditLead(lead) || !lead.new_from_email || drawerEmailAttempted || emailAcknowledgements.has(lead.id)) return;
    drawerEmailAttempted = true;
    const attempt = Symbol();
    emailAcknowledgements.set(lead.id, attempt);
    try {
      const saved = await client.acknowledgeLeadEmail(lead, crypto.randomUUID(), actor);
      if (saved.lead_id === lead.id && emailAcknowledgements.get(lead.id) === attempt) clearEmailBadge(lead.id);
    } catch {
      // Keep the badge until a confirmed save or a later read clears it.
    } finally {
      if (emailAcknowledgements.get(lead.id) === attempt) emailAcknowledgements.delete(lead.id);
    }
  }
  const COPY_LINK_DONE = "Link copied";
  const COPY_LINK_FAILED = "Could not copy link. Copy the address from your browser.";
  let copyLinkTimer = null;
  function setCopyLinkStatus(text) {
    if (copyLinkTimer !== null) {
      clearTimeout(copyLinkTimer);
      copyLinkTimer = null;
    }
    $("copyLeadStatus").textContent = text;
  }
  async function copyLeadLink() {
    const id = state.detailId;
    if (!id) return;
    setCopyLinkStatus("");
    const url = `${win.location.origin}/leads?lead=${encodeURIComponent(id)}`;
    const clipboard = win.navigator?.clipboard;
    try {
      if (typeof clipboard?.writeText !== "function") throw new Error("clipboard unavailable");
      await clipboard.writeText(url);
    } catch {
      if (state.detailId === id && $("leadDetail").open) setCopyLinkStatus(COPY_LINK_FAILED);
      return;
    }
    if (state.detailId !== id || !$("leadDetail").open) return;
    setCopyLinkStatus(COPY_LINK_DONE);
    // eslint-disable-next-line no-restricted-syntax -- Single 2 s status, cleared on the next copy, lead change or close.
    copyLinkTimer = setTimeout(() => setCopyLinkStatus(""), 2000);
  }

  async function readDetail(id, { open = true, intent = null, resolvedDetail = null } = {}) {
    const lead = leadById(id), epoch = ++state.detailEpoch, actor = state.actor;
    state.historyRequest = null;
    if (open) state.historyError = null;
    if (!lead || !state.identityReady) return;
    if (open && !intent) drawerEmailAttempted = false;
    if (open) { setCopyLinkStatus(""); clearGuidance(); state.resumeDetail = intent; state.selectedId = id; render(); selectDocRecord("lead", id); state.detailId = id; state.detail = null; paintDetailFollowUp(); state.trigger = focusIdentity(doc.activeElement); $("detailTitle").textContent = leadTitle(lead); $("detailBody").innerHTML = '<p class="empty">Updating…</p>'; $("leadDetail").showModal(); }
    const current = () => epoch === state.detailEpoch && actor === state.actor &&
      state.detailId === id && $("leadDetail").open;
    try {
      const response = resolvedDetail ? { detail: resolvedDetail } : await client.getLeadDetail(lead);
      if (!current()) return;
      if (!leadById(id) || !response.detail || response.detail.id !== id || !eligibleLead(response.detail)) { state.resumeDetail = null; $("leadDetail").close(); state.detail = null; return; }
      validateLeadDetail(response.detail, id);
      if (resolvedDetail) publishDocRead("getLeadDetail", response, [lead]);
      selectDocRecord("lead", id);
      const budgets = new Map(historyKinds.map(kind => [kind, createPageBudget({ document: doc })]));
      // eslint-disable-next-line no-restricted-syntax -- Max 100 continuation reads per history kind.
      for (;;) {
        if (state.historyRequest) {
          await state.historyRequest.done;
          if (!current()) return;
        }
        const kind = historyKinds.find(kind => {
          const tail = intent?.historyTails[kind] ?? historyTail(open ? null : state.detail, kind);
          return tail && response.detail[`${kind}_page`]?.has_more &&
            !response.detail[kind].some(entry => entry[historyKeys[kind]] === tail);
        });
        if (!kind) break;
        budgets.get(kind)();
        const older = await client.getLeadDetail(lead, { [`${kind}_cursor`]: response.detail[`${kind}_page`].next_cursor });
        if (!current()) return;
        if (!older.detail || !eligibleLead(older.detail)) { $("leadDetail").close(); state.detail = null; return; }
        validateLeadDetail(older.detail, id);
        response.detail = appendHistory(response.detail, older.detail, kind);
      }
      const failedKind = state.historyError?.kind;
      if (failedKind && !response.detail[`${failedKind}_page`]?.has_more) state.historyError = null;
      const unchanged = JSON.stringify(state.detail) === JSON.stringify(response.detail);
      state.detail = response.detail; if (!unchanged || !researchView) paintDetail(response.detail, intent);
      state.resumeDetail = null;
      if ($("leadDetail").open && state.identityReady) void acknowledgeDrawerEmail(state.detail, actor);
    } catch (error) { if (epoch !== state.detailEpoch || authorizationFailure(error)) return; clearGuidance(); state.detail = null; const unreachable = error?.code === "network_error" || error?.code === "read_timeout"; $("detailBody").innerHTML = `<p class="empty" role="alert">${unreachable ? "Connection interrupted · reconnecting…" : "Lead details were refused."}</p>`; }
  }
  async function openReview(id, target, { updating = false, undoEventId = null, draft = null } = {}) {
    const lead = leadById(id);
    if (!hasLeadVersion(lead) || !state.identityReady || state.writing || state.pending || reviewComplete(lead, target, undoEventId) || (!undoEventId && !FILTER_STAGES.some(([key]) => key === target))) return;
    if (updating) draft = captureReviewDraft();
    if (!draft || draft.actor !== state.actor || draft.id !== id || draft.target !== target || draft.undoEventId !== undoEventId) {
      draft = { id, target, undoEventId, actor: state.actor, question: null, answer: "" };
    }
    const priorQuestion = draft.question;
    state.proposal = null;
    if (!updating) { if (!$("leadDetail").open) state.trigger = focusIdentity(doc.activeElement); ++state.detailEpoch; $("leadDetail").close(); }
    selectDocRecord("lead", id);
    state.reviewTarget = draft;
    const epoch = ++state.reviewEpoch, actor = state.actor;
    $("stageTitle").textContent = `Doc · ${leadTitle(lead)}`;
    if (!updating) { $("stageContext").innerHTML = '<p class="empty">Checking correspondence…</p>'; $("stageQuestions").innerHTML = ""; $("stageDialog").showModal(); }
    $("saveStage").disabled = true; $("stageError").hidden = true;
    try {
      const response = await client.getLeadDetail(lead);
      if (epoch !== state.reviewEpoch || actor !== state.actor || state.reviewTarget !== draft || !$("stageDialog").open) return;
      const detail = response.detail;
      if (!canEditLead(detail) || detail.id !== id || !eligibleLead(detail) || reviewComplete(detail, target, undoEventId)) { state.proposal = null; $("stageDialog").close(); return; }
      validateLeadDetail(detail, id);
      const undo = undoEventId ? undoReview(detail) : null;
      if (undoEventId && (undo?.stage_review.undo_event_id !== undoEventId || undo.stage !== target)) { $("stageDialog").close(); return; }
      const review = undo ? { evidence: [], question: undo.question, reason: undo.stage_review.reason } : stageReview(detail, target);
      if (review.question !== priorQuestion) {
        draft.answer = !updating && review.question ? reviewAnswer(actor, id, target, undoEventId).read() : "";
      }
      draft.question = review.question;
      state.proposal = { lead: detail, target, review, actor, undoEventId };
      $("stageContext").innerHTML = `<div class="stage-proposal">${esc(stageLabel(normalizedStage(detail)))} <span>→</span> ${esc(stageLabel(target))}</div><ul class="stage-evidence">${review.evidence.map(entry => `<li><b>${esc(summary(entry.summary))}</b> · ${shortDate(entry.occurred_at)}</li>`).join("") || '<li>No supporting mail or calendar entry</li>'}</ul>`;
      if (!updating || review.question !== priorQuestion) {
        $("stageQuestions").innerHTML = review.question ? `<label>${esc(review.question)}<textarea name="answer" required maxlength="1000" autofocus></textarea></label>` : "";
        const input = $("stageQuestions").querySelector("textarea");
        if (input) input.value = draft.answer;
      }
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = false;
      $("saveStage").disabled = false; $("saveStage").textContent = undo ? "Restore stage" : target === "archived" ? "Archive lead" : `Confirm ${stageLabel(target)}`;
      if (!updating || review.question !== priorQuestion) $("stageQuestions").querySelector("textarea")?.focus();
    } catch (error) {
      if (epoch !== state.reviewEpoch || authorizationFailure(error)) return;
      $("stageError").textContent = "Correspondence unavailable · reconnecting…"; $("stageError").hidden = false;
    }
  }
  async function command(intent) {
    if (!state.identityReady || !canEditLead(intent.lead)) return;
    if (intent.kind === "engagement") {
      const clientId = intent.lead.prospect_client_id;
      return executeEngagement({ client_id: clientId, base_version: intent.lead.prospect_client_version,
        status: "active", reason: intent.reason, human_quote: intent.reason, expected_actor: state.actor });
    }
    if (state.writing || state.pending) return;
    state.commandFeedback = null;
    state.pending = { ...intent, key: win.crypto.randomUUID(), actor: state.actor };
    return executePending();
  }
  async function executeEngagement(args) {
    if (!args || engagement.get(args.client_id, state.actor)?.sending || engagementChecks.has(args.client_id)) return;
    if (!engagement.get(args.client_id, state.actor)) {
      engagementChecks.add(args.client_id);
      try {
        const lead = state.board?.leads.find(lead => lead.prospect_client_id === args.client_id);
        if (!lead) throw new Error("Prospect unavailable");
        const current = (await client.getLeadDetail(lead)).detail;
        validateLeadDetail(current, lead.id);
        if (state.actor !== args.expected_actor) return;
        if (!canEditLead(current) || current.prospect_client_id !== args.client_id || current.prospect_client_version !== args.base_version) {
          await refresh();
          const form = $("activateProspect");
          if (form && state.detail?.prospect_client_id === args.client_id) form.elements.reason.value = args.reason;
          state.commandFeedback = "This prospect changed. Review the current record and your kept reason before confirming again.";
          paintCommandFeedback();
          return;
        }
      } catch (error) {
        if (authorizationFailure(error)) return;
        state.commandFeedback = "Change not sent. The current prospect could not be verified.";
        paintCommandFeedback();
        return;
      } finally { engagementChecks.delete(args.client_id); }
    }
    const status = engagement.get(args.client_id, state.actor)?.request.status || args.status;
    state.commandFeedback = null;
    const operation = engagement(args, {
      readBack: async () => {
        if (await refresh() !== true) return null;
        const lead = state.board?.leads.find(lead => lead.prospect_client_id === args.client_id);
        return { client_id: lead?.prospect_client_id, status: lead?.prospect_engagement_status, version: lead?.prospect_client_version };
      },
      beforeSend: async request => {
        const actor = await client.getActor();
        if (actor !== request.expected_actor) {
          clearPrivateView(); state.actor = actor; await refresh();
          throw Object.assign(new Error("Account changed"), { code: "account_changed" });
        }
      },
    });
    paintCommandFeedback();
    try {
      await operation;
      if (state.actor !== args.expected_actor) return;
      $("moveAnnouncement").textContent = status === "active" ? "Prospect returned to the deal board" : "Prospect returned to Leads";
      await refresh();
    } catch (error) {
      if (state.actor !== args.expected_actor || authorizationFailure(error)) return;
      if (!engagement.get(args.client_id, state.actor)) state.commandFeedback = error.code === "version_conflict" ? "Lead updated" : "Change unavailable";
      await refresh();
    } finally { paintCommandFeedback(); }
  }
  async function executePending() {
    if (state.writing || !state.pending) return;
    state.writing = true;
    paintWriteControls();
    $("saveStage").disabled = true;
    const pending = state.pending, epoch = state.epoch;
    let mutationAttempted = false;
    try {
      const actor = await client.getActor();
      if (epoch !== state.epoch) return;
      if (!actor) { authorizationFailure({ code: "unauthorized" }); return; }
      if (actor !== pending.actor) { clearPrivateView(); state.actor = actor; await refresh(); return; }
      // A review can remain open while a partner edits. Check the exact lead
      // once before sending; an unanswered write keeps its reviewed request.
      if (!pending.attempted) {
        const current = (await client.getLeadDetail(pending.lead)).detail;
        if (epoch !== state.epoch || state.pending !== pending) return;
        validateLeadDetail(current, pending.lead.id);
        if (current.base_version !== pending.lead.base_version) {
          state.pending = null; state.writing = false;
          await refresh();
          const message = "This lead changed. Review the current record before confirming again.";
          state.commandFeedback = message;
          $("stageError").textContent = message; $("stageError").hidden = false;
          paintCommandFeedback();
          return;
        }
        pending.attempted = true;
      }
      mutationAttempted = true;
      let claim;
      if (pending.kind === "link") await client.linkClient(pending.lead, pending.clientId, pending.key, pending.actor);
      else if (pending.kind === "claim") claim = await client.claimLead(pending.lead, pending.key, pending.actor);
      else await client.recordStage(pending.lead, pending.stage, pending.review, pending.key, pending.actor);
      if (state.pending !== pending || state.actor !== actor) return;
      clearReviewAnswer(pending);
      if (claim?.lead_id === pending.lead.id && leadById(pending.lead.id)?.new_from_email) clearEmailBadge(pending.lead.id);
      state.pending = null; state.commandFeedback = null; $("stageDialog").close();
      $("moveAnnouncement").textContent = pending.kind === "link" ? "Client linked" : pending.kind === "claim" ? "Lead claimed" : pending.review.undo_event_id ? "Stage restored" : `Moved to ${stageLabel(pending.stage)}`;
      await refresh();
    } catch (error) {
      if (state.pending !== pending) return;
      if (authorizationFailure(error)) return;
      if (mutationAttempted && error.code !== "unknown_outcome") state.pending = null;
      const refusals = {
        lead_not_claimable: "This lead is no longer available to claim. Reload to see its current status.",
        lead_not_linkable: "This lead cannot be linked to a client now. Reload to see its current status.",
        client_not_found: "That client could not be found. Reload and choose an existing client.",
        client_not_suggested: "That client isn't one of this lead's matches. Reload and pick one of the suggested clients.",
        account_changed: "Your account changed. Reload Leads before saving again."
      };
      const message = error.code === "unknown_outcome" ? "Confirmation pending · checking current stage…" :
        ["version_conflict", "undo_changed"].includes(error.code) ? "Lead updated" : refusals[error.code] || "Change unavailable";
      state.commandFeedback = message;
      $("stageError").textContent = message; $("stageError").hidden = false;
      paintCommandFeedback();
      if (error.code !== "unknown_outcome") state.writing = false;
      await refresh(); // Read only. An unknown write is never sent again automatically.
      paintCommandFeedback();
    } finally { state.writing = false; paintCommandFeedback(); }
  }
  $("reachabilityFilter")?.addEventListener("change", event => { state.filters.reachability = event.target.value; render(); });
  quietFilter.addEventListener("click", () => { state.filters.quiet = !state.filters.quiet; render(); });
  // Markets past the strip's one line fold into a "+N" chip; folded chips leave the tab order.
  function foldMarkets() {
    const strip = $("marketCounts"), more = $("moreMarkets");
    const open = more.getAttribute("aria-expanded") === "true";
    const bottom = strip.getBoundingClientRect().bottom;
    const chips = [...strip.querySelectorAll("[data-market]")];
    for (const chip of chips) {
      chip.inert = !open && chip.getBoundingClientRect().top >= bottom;
      // The native tip, as Calendar's chips use, names a truncated market in full.
      const name = chip.firstElementChild;
      chip.title = name.scrollWidth > name.clientWidth ? chip.dataset.market : "";
    }
    const folded = chips.filter(chip => chip.inert).length;
    more.hidden = !open && !folded;
    more.textContent = open ? "Fewer" : `+${folded}`;
    if (open || folded) more.setAttribute("aria-label", open ? "Show fewer markets" : `Show ${folded} more markets`);
    else more.removeAttribute("aria-label");
  }
  function selectMarket(key) { state.filters.market = state.filters.market === key ? "" : key; render(); }
  for (const [id, key] of [["leadSearch", "search"], ["ownerFilter", "owner"], ["marketFilter", "market"], ["specialtyFilter", "specialty"]]) {
    // eslint-disable-next-line no-restricted-syntax -- Registers input/change handlers for only 4 filter controls; 0 lifecycle reads.
    $(id).addEventListener(id === "leadSearch" ? "input" : "change", event => { state.filters[key] = event.target.value; render(); });
  }
  $("stageFilter").addEventListener("change", event => {
    state.filters.stage = event.target.value;
    render();
    $("stageFilter").scrollIntoView?.({ block: "start" });
  });
  $("clearMarket").addEventListener("click", () => { state.filters.market = ""; render(); });
  $("marketCounts").addEventListener("click", event => { const button = event.target.closest("[data-market]"); if (button) selectMarket(button.dataset.market); });
  $("moreMarkets").addEventListener("click", event => { const more = event.currentTarget; more.setAttribute("aria-expanded", String(more.getAttribute("aria-expanded") !== "true")); foldMarkets(); });
  if (win.ResizeObserver) new win.ResizeObserver(foldMarkets).observe($("marketCounts"));
  // A late web font rewraps the chips without resizing the strip.
  doc.fonts?.ready.then(foldMarkets);
  $("refreshBoard").addEventListener("click", () => { refresh(); });
  $("checkDetailPending").addEventListener("click", executePending);
  $("copyLeadLink").addEventListener("click", () => { void copyLeadLink(); });
  $("leadDetail").addEventListener("close", () => setCopyLinkStatus(""));
  $("closeDetail").addEventListener("click", () => $("leadDetail").close());
  $("closeStage").addEventListener("click", () => $("stageDialog").close());
  for (const id of ["leadDetail", "stageDialog"]) onDialogClosed($(id), () => {
    if (id === "stageDialog") { ++state.reviewEpoch; state.reviewTarget = null; state.proposal = null; }
    else { setCopyLinkStatus(""); clearGuidance(); ++state.detailEpoch; if (state.detailId) state.resumeDetail = null; state.detailId = null; state.detail = null; }
    paintCommandFeedback();
    if (!$("leadDetail").open && !$("stageDialog").open) {
      selectDocRecord("lead", null);
      pageDocContext?.release("getLeadDetail");
      if (doc.activeElement === doc.body || $(id).contains(doc.activeElement)) restoreFocus(state.trigger);
      const stage = id === "leadDetail" && doc.activeElement?.closest(".lead-card")?.closest('.stage-column[data-expanded="true"]');
      const heading = stage && stage.querySelector(".stage-head");
      const headerBottom = doc.querySelector(".app-layout-tabbar")?.getBoundingClientRect().bottom ?? 0;
      if (heading && heading.getBoundingClientRect().top < headerBottom) {
        stage.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
      }
    }
  });
  $("stageQuestions").addEventListener("input", () => {
    const draft = captureReviewDraft();
    if (draft?.question) reviewAnswer(draft.actor, draft.id, draft.target, draft.undoEventId).write(draft.answer);
  });
  $("stageForm").addEventListener("submit", event => {
    event.preventDefault(); if (state.pending) { executePending(); return; } const p = state.proposal;
    if (!p || p.actor !== state.actor || $("saveStage").disabled) return;
    const answer = String(new win.FormData(event.target).get("answer") || "").trim();
    if (p.review.question && !answer) return;
    command({ kind: "stage", lead: p.lead, stage: p.target, review: p.undoEventId ? undoReview(p.lead, answer).stage_review : { reason: p.review.reason || answer,
      evidence_ids: p.review.evidence.map(entry => entry.id), ...(answer ? { human_quote: answer } : {}) } });
  });
  function clickLead(event) {
    const step = event.target.closest("[data-lane-step]"); if (step) { scrollLanes(Number(step.dataset.laneStep)); return; }
    if (event.target.closest("[data-toggle-empty-stages]")) { state.showEmptyStages = !state.showEmptyStages; render(); return; }
    const expand = event.target.closest("[data-expand-stage]");
    if (expand) { const key = expand.dataset.expandStage; if (expandedStages.has(key)) expandedStages.delete(key); else expandedStages.add(key); render(); return; }
    const undo = event.target.closest("[data-undo]"); if (undo) { const lead = state.detail, review = lead && undoReview(lead); if (review) openReview(lead.id, review.stage, { undoEventId: review.stage_review.undo_event_id }); return; }
    const link = event.target.closest("[data-link]"); if (link) { const lead = state.detail; if (lead) command({ kind: "link", lead, clientId: link.dataset.clientId }); return; }
    const claim = event.target.closest("[data-claim]"); if (claim) { const lead = $("leadDetail").contains(claim) ? state.detail : leadById(claim.dataset.claim); if (lead) command({ kind: "claim", lead }); return; }
    const card = event.target.closest("[data-lead-id]"); if (card && !event.target.closest("[data-drag-handle]")) readDetail(card.dataset.leadId);
  }
  $("detailBody").addEventListener("click", clickLead);
  const board = $("leadBoard");
  board.addEventListener("click", clickLead);
  board.addEventListener("scroll", paintLaneCue, { capture: true, passive: true });
  const boardResize = win.ResizeObserver ? new win.ResizeObserver(paintLaneCue) : null;
  boardResize?.observe(board);
  board.addEventListener("keydown", event => {
    if (event.target.closest("button:not([data-open])")) return;
    const card = event.target.closest("[data-lead-id]"); if (!card) return;
    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); const lead = leadById(card.dataset.leadId);
      const index = BOARD_STAGES.findIndex(([key]) => key === normalizedStage(lead));
      const next = BOARD_STAGES[index + (event.key === "ArrowRight" ? 1 : -1)]; if (next) openReview(lead.id, next[0]);
    }
  });
  board.addEventListener("dragstart", event => { const card = event.target.closest("[data-lead-id][draggable='true']"); if (!card || state.pending) { event.preventDefault(); return; } state.drag = card.dataset.leadId; event.dataTransfer.setData("text/plain", state.drag); event.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
  board.addEventListener("dragover", event => { const column = event.target.closest("[data-stage]"); if (column && state.drag) { event.preventDefault(); column.dataset.dropActive = "true"; } });
  board.addEventListener("dragleave", event => { const column = event.target.closest("[data-stage]"); if (column) delete column.dataset.dropActive; });
  board.addEventListener("drop", event => { event.preventDefault(); const column = event.target.closest("[data-stage]"); if (column && state.drag) openReview(state.drag, column.dataset.stage); state.drag = null; });
  board.addEventListener("dragend", () => { state.drag = null; for (const node of board.querySelectorAll(".dragging")) node.classList.remove("dragging"); for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive; render(); });
  let touch = null, scrollFrame = null;
  function highlightDrop(x, y) {
    const column = doc.elementFromPoint?.(x, y)?.closest("[data-stage]");
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
    if (column) column.dataset.dropActive = "true";
    return column;
  }
  function stopTouch() {
    const prior = touch; touch = null;
    delete board.dataset.touchDragging;
    if (scrollFrame !== null) win.cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
    if (prior?.handle.hasPointerCapture?.(prior.pointer)) prior.handle.releasePointerCapture(prior.pointer);
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
    if (prior) render();
  }
  function scrollTouch() {
    if (!touch) return;
    if (doc.visibilityState === 'hidden' || ++touch.frames >= 1800) { stopTouch(); return; }
    if (Math.hypot(touch.x-touch.startX, touch.y-touch.startY)>8) {
      scrollAtEdge(doc, touch.y);
      highlightDrop(touch.x, touch.y);
    }
    // eslint-disable-next-line no-restricted-syntax -- 1800 drag frames, then stopTouch. No reads or retries; browser frame cadence Stops when hidden, on pointer release/cancel, when touch is absent, or at the frame cap
    scrollFrame = win.requestAnimationFrame(scrollTouch);
  }
  board.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-drag-handle]"); if (!handle || state.pending || !state.identityReady) return;
    stopTouch(); const card = handle.closest("[data-lead-id]");
    board.dataset.touchDragging = "true";
    touch = { frames: 0, id: card.dataset.leadId, handle, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    // eslint-disable-next-line no-restricted-syntax -- 1800 drag frames, then stopTouch. No reads or retries; browser frame cadence Stops when hidden, on pointer release/cancel, when touch is absent, or at the frame cap
    handle.setPointerCapture?.(event.pointerId); scrollFrame = win.requestAnimationFrame(scrollTouch);
  });
  board.addEventListener("pointermove", event => { if (!touch || touch.pointer !== event.pointerId) return; touch.x = event.clientX; touch.y = event.clientY; highlightDrop(touch.x, touch.y); });
  board.addEventListener("pointerup", event => {
    if (!touch || touch.pointer !== event.pointerId) return;
    const { id, startX, startY } = touch, column = highlightDrop(event.clientX, event.clientY);
    stopTouch();
    if (column && Math.hypot(event.clientX-startX,event.clientY-startY)>8) openReview(id,column.dataset.stage);
  });
  board.addEventListener("pointercancel", stopTouch);
  board.addEventListener("lostpointercapture", stopTouch);
  const retireDetail = () => { clearGuidance(); ++state.detailEpoch; };
  win.addEventListener("pagehide", retireDetail);
  render();
  let disposed = false;
  $("showTerritory").addEventListener("click", async () => {
    if (disposed) return;
    const button = $("showTerritory"), root = $("territoryMap");
    button.disabled = true; button.textContent = "Loading territory…";
    button.setAttribute("aria-expanded", "true"); root.hidden = false;
    try {
      const map = await mapFactory(root, readDetail, { describeLead: id => leadTitle(leadById(id) || {}) });
      if (disposed) { map.dispose(); return; }
      state.map = map; button.hidden = true;
      if (!state.drag && !touch) render();
    } catch {
      if (disposed) return;
      button.hidden = true;
      root.innerHTML = '<p class="empty" role="status">Map unavailable. Use the Market filter to find leads.</p>';
    }
  }, { once: true });
  function suspendPrivateView() {
    emailAcknowledgements.clear();
    clearQuiet();
    pageDocContext?.clear();
    if (state.reviewTarget && $("stageDialog").open) state.resumeReview = captureReviewDraft();
    if (state.detailId && $("leadDetail").open && !state.resumeDetail) state.resumeDetail = {
      historyTails: Object.fromEntries(historyKinds.map(kind => [kind, historyTail(state.detail, kind)])),
      actor: state.actor, id: state.detailId, scroll: $("leadDetail").scrollTop,
      expanded: [...$("detailBody").querySelectorAll("details[open]")].map(node => node.dataset.entryKey),
    };
    clearGuidance();
    stopTouch(); ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch;
    state.identityReady = false; state.selectedId = null; state.board = null; state.detail = null; state.detailId = null;
    state.proposal = null; state.reviewTarget = null; state.trigger = null; state.drag = null;
    $("leadDetail").close(); $("stageDialog").close();
    for (const id of ["detailTitle", "detailBody", "stageTitle", "stageContext", "stageQuestions", "stageError", "moveAnnouncement"]) $(id).replaceChildren();
    render();
  }
  win.addEventListener("doctorcre-session-invalidated", suspendPrivateView);
  const auto = mountAutoRefresh({ document: doc, window: win, refresh: async () => { if (await refresh() === false) throw new Error("Lead board read failed"); }, onResume: suspendPrivateView, shouldRefresh: () => !state.writing && !touch && !state.drag });
  const resume = () => { if (doc.visibilityState === "hidden") { clearQuiet(); clearResearch(); pageDocContext?.clear(); stopTouch(); state.identityReady = false; ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch; render(); } };
  // eslint-disable-next-line no-restricted-syntax -- Hidden-state events only clear lead identity, document context, and drag state; they perform no HTTP reads.
  doc.addEventListener("visibilitychange", resume);
  auto.refresh();
  return { state, refresh, openReview, readDetail, dispose() { if (disposed) return; disposed = true; suspendPrivateView(); reasons?.dispose(); boardResize?.disconnect(); auto.dispose(); win.removeEventListener("doctorcre-session-invalidated", suspendPrivateView); state.map?.dispose(); win.removeEventListener("pagehide", retireDetail); doc.removeEventListener("visibilitychange", resume); } };
}
if (typeof document !== "undefined" && document.getElementById("leadBoard")) mountLeadsWorkspace();
