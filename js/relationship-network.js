import { BUSINESS_TIME_ZONE } from "./business-date.js";
import { mountIntroductionRequest, mountRelationshipKindFilter, relationshipKind } from "./ui-relationship-kind-filter.generated.js";
import { mountLocalTicker } from './visibility-poll.mjs';
import { TOUCH_LAYOUT } from "./touch-layout.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import {
  mountAutoRefresh,
  readWithDeadline,
  updatedLabel,
} from "./auto-refresh.mjs";
import {
  EDGE_LABELS,
  NODE_LABELS,
  validNetwork,
  filterNetwork,
  introductionSuggestions,
  introductionRouteLabel,
  indexConnections,
  focusedNetwork,
  readableNetwork,
  escapeHtml as E,
} from "./relationship-network-model.js";
import { mountRelationshipDialog, preserveRelationshipFocus } from "./relationship-dialog.js";

const DIRECTORY_PAGE = 50;

export function mountRelationshipNetwork({
  document,
  window,
  client,
  intervalMs,
}) {
  const $ = (id) => document.getElementById(id),
    intro = mountIntroductionRequest({ document, client, validNetwork, onConfirmed: () => auto.refresh(), recoveryHost: $('networkIntroductions').parentElement }),
    dialog = mountRelationshipDialog({
      document,
      onReviewIntroduction: id => intro.open(snapshot, id),
      onRefresh: () => auto.refresh(),
      onSelect: id => select(id),
    });
  let snapshot = null,
    epoch = 0,
    disposed = false,
    focus = null,
    limit = 12,
    listed = DIRECTORY_PAGE,
    zoom = 1,
    positions = new Map();
  const params = new URLSearchParams(window.location.search);
  const currentFilters = {
    q: params.get("q") || "",
    territory: params.get("territory") || "",
    vertical: params.get("vertical") || "",
    kind: relationshipKind(params.get("kind")),
  };
  $("networkSearch").value = currentFilters.q;
  focus = params.get("node");
  const step = params.get("step");
  let stepId = focus?.startsWith("party:") && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(step ?? "") ? step : null;
  let openLinkedRecord = Boolean(focus);
  const address = () => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({
      ...currentFilters,
      view:
        $("referralsTab").getAttribute("aria-selected") === "true"
          ? "referrals"
          : "",
      node: focus || "",
      step: stepId || "",
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url);
  };
  const select = (id) => {
    if (focus !== id) stepId = null;
    focus = id;
    address();
    highlight(id);
  };
  const open = (id, trigger) => {
    select(id);
    const active = document.activeElement;
    const heading = $("referralsView").hidden ? $("networkHeading") : $("referralsView").querySelector("h2");
    dialog.open(snapshot, id, trigger ?? (active === document.body ? heading : active));
  };
  const highlight = (id) => {
    $("networkCanvas")
      .querySelectorAll("[data-node]")
      .forEach((n) => n.classList.toggle("selected", n.dataset.node === id));
    $("networkCanvas")
      .querySelectorAll("[data-edge-from]")
      .forEach((n) =>
        n.classList.toggle(
          "active",
          [n.dataset.edgeFrom, n.dataset.edgeTo, n.dataset.edgeVia].includes(
            id,
          ),
        ),
      );
  };
  const wireCards = (target) =>
    target
      .querySelectorAll("[data-node]")
      .forEach((b) => (b.onclick = () => open(b.dataset.node, b)));
  const paintNetwork = () => {
    for (const id of ["networkZoomIn", "networkZoomOut", "networkFit"])
      $(id).disabled = !snapshot;
    if (!snapshot) {
      $("networkCount").textContent = "";
      $("networkMore").hidden = true;
      $("networkMoreNodes").hidden = true;
      for (const id of [
        "networkCanvas",
        "networkNodes",
        "networkIntroductions",
        "networkReferrals",
      ])
        $(id).replaceChildren();
      return;
    }
    const view = filterNetwork(snapshot, currentFilters),
      phone = window.matchMedia(TOUCH_LAYOUT).matches;
    const directory = $("networkNodes").parentElement, graphView = $("graphView");
    if (phone && graphView.firstElementChild !== directory) graphView.prepend(directory);
    else if (!phone && graphView.lastElementChild !== directory) graphView.append(directory);
    // A record hidden by the filters stays selected; only a filter change or its removal drops it.
    if (focus && !snapshot.nodes.some(n => n.id === focus)) {
      focus = null;
      stepId = null;
      address();
    }
    const selected = view.nodes.some((n) => n.id === focus)
      ? focus
      : view.suggestions[0]?.to || view.nodes[0]?.id;
    const graph = focusedNetwork(
      view,
      selected,
      phone ? Math.max(6, limit - 6) : limit,
    );
    const height = phone
        ? Math.max(155, Math.ceil(graph.nodes.length / 2) * 125 + 30)
        : Math.max(155, Math.ceil(graph.nodes.length / 4) * 125 + 30),
      width = phone ? 400 : 820;
    const visiblePositions = new Map(
      graph.nodes.map((n, i) => {
        const cols = phone ? 2 : 4,
          x = phone ? 20 + (i % cols) * 190 : 20 + (i % cols) * 200,
          y = 35 + Math.floor(i / cols) * 125;
        return [n.id, positions.get(`${phone}:${n.id}`) || { x, y }];
      }),
    );
    const lines = graph.edges
      .map((e) => {
        const a = visiblePositions.get(e.from),
          b = visiblePositions.get(e.to),
          dx = b.x - a.x,
          dy = b.y - a.y,
          t = 1 / Math.max(Math.abs(dx) / 84, Math.abs(dy) / 40, 1),
          start = { x: a.x + 80 + dx * t, y: a.y + 35 + dy * t },
          end = { x: b.x + 80 - dx * t, y: b.y + 35 - dy * t };
        return `<path class="relationship-edge" data-kind="${E(e.kind)}" data-edge-from="${E(e.from)}" data-edge-to="${E(e.to)}" data-edge-via="${E(e.via || "")}" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#relationshipArrow)"><title>${E(EDGE_LABELS[e.kind])}${e.via ? ` · via ${E(view.nodes.find((n) => n.id === e.via)?.name || "")}` : ""}</title></path>${
          e.via
            ? (() => {
                const v = visiblePositions.get(e.via);
                return `<path class="relationship-edge" d="M${v.x + 80},${v.y + 35}L${(a.x + b.x) / 2 + 80},${(a.y + b.y) / 2 + 35}" stroke-dasharray="3 5"><title>Introducer</title></path>`;
              })()
            : ""
        }`;
      })
      .join("");
    $("networkCanvas").innerHTML = graph.nodes.length
      ? `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Connected relationships"><defs><marker id="relationshipArrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="relationship-arrow" d="M0 0L10 5L0 10"/></marker></defs><g id="networkScene" transform="translate(${(width * (1 - zoom)) / 2} ${(height * (1 - zoom)) / 2}) scale(${zoom})">${lines}${graph.nodes
          .map((n) => {
            const p = visiblePositions.get(n.id);
            const territory = n.territory || "";
            return `<g class="relationship-node" data-node="${E(n.id)}" data-kind="${E(n.kind)}" role="button" tabindex="0" aria-label="Open ${E([NODE_LABELS[n.kind], n.name, territory].filter(Boolean).join(", "))}" transform="translate(${p.x} ${p.y})"><rect width="160" height="74" rx="12"/><text aria-hidden="true" class="node-icon" x="12" y="24">${{ vendor: "◇", client: "○", lead: "◎", deal: "▣", contact: "◉" }[n.kind]}</text><text class="node-kind" x="39" y="23">${E(NODE_LABELS[n.kind])} </text><foreignObject x="12" y="32" width="136" height="38"><div xmlns="http://www.w3.org/1999/xhtml"><div class="node-name" title="${E(n.name)}">${E(n.name)} </div><div class="node-territory" title="${E(territory)}">${E(territory)}</div></div></foreignObject></g>`;
          })
          .join("")}</g></svg>`
      : '<p class="relationship-empty">No matching relationships</p>';
    $("networkCount").textContent = `${view.nodes.length}`;
    $("networkMore").hidden = graph.nodes.length === view.nodes.length;
    $("networkMoreNodes").hidden = view.nodes.length <= listed;
    $("networkNodes").innerHTML = view.nodes
      .slice(0, listed)
      .map((n) => {
        const count = snapshot.connectionsByNode.get(n.id)?.length ?? 0;
        return `<button type="button" class="relationship-card" data-node="${E(n.id)}"><strong>${E(n.name)}</strong><span>${E(NODE_LABELS[n.kind])}${n.territory ? ` · ${E(n.territory)}` : ""} · ${count} ${count === 1 ? "connection" : "connections"}</span></button>`;
      })
      .join("");
    const intros = introductionSuggestions(view, { limit: 6 });
    $("networkIntroductions").innerHTML =
      intros
        .map(
          (s) =>
            `<button type="button" class="relationship-card" data-node="${E(s.to)}"><span class="intro-route">${E(introductionRouteLabel(s.path))}</span><strong>${E(s.reason)}</strong><small>Willingness unconfirmed</small></button>`,
        )
        .join("") ||
      '<p class="relationship-empty">No offered introductions</p>';
    const max = Math.max(1, ...view.referrals.map((r) => r.deals));
    $("networkReferrals").innerHTML =
      [...view.referrals]
        .sort((a, b) => b.deals - a.deals || a.node_id.localeCompare(b.node_id))
        .map((r) => {
          const n = view.nodes.find((n) => n.id === r.node_id);
          return `<button type="button" class="relationship-card relationship-referral" data-node="${E(n.id)}"><strong>${E(n.name)}</strong><b>${r.deals}</b><span>${E(NODE_LABELS[n.kind])}</span>${r.win_rate === null ? "" : `<span class="referral-rate">${Math.round(r.win_rate * 100)}% win rate</span>`}<svg viewBox="0 0 300 16" role="img" aria-label="${r.deals} recorded deals sent; ${r.won} won, ${r.lost} lost, ${r.deals - r.won - r.lost} unresolved"><rect class="referral-track" width="300" height="10" rx="5"/><rect width="${(r.deals / max) * 300}" height="10" rx="5" class="referral-fill"/></svg><small>${r.won} won · ${r.lost} lost · ${r.deals - r.won - r.lost} open</small></button>`;
        })
        .join("") ||
      '<p class="relationship-empty">No deal referrals recorded</p>';
    for (const id of [
      "networkNodes",
      "networkIntroductions",
      "networkReferrals",
    ])
      wireCards($(id));
    $("networkCanvas")
      .querySelectorAll("[data-node]")
      .forEach((g) => {
        g.onclick = () => {
          if (!g.dataset.dragged) open(g.dataset.node, g);
          delete g.dataset.dragged;
        };
        g.onkeydown = (e) => {
          if (["Enter", " "].includes(e.key)) {
            e.preventDefault();
            open(g.dataset.node, g);
          }
        };
        g.onpointerdown = (e) => {
          if (e.button !== 0) return;
          g.setPointerCapture(e.pointerId);
          const svg = g.ownerSVGElement,
            start = { x: e.clientX, y: e.clientY },
            p = visiblePositions.get(g.dataset.node);
          const rect = svg.getBoundingClientRect();
          g.onpointermove = (event) => {
            const dx = ((event.clientX - start.x) * width) / rect.width / zoom,
              dy = ((event.clientY - start.y) * height) / rect.height / zoom;
            if (Math.abs(dx) + Math.abs(dy) > 5) g.dataset.dragged = "true";
            const next = {
              x: Math.max(0, Math.min(width - 160, p.x + dx)),
              y: Math.max(0, Math.min(height - 74, p.y + dy)),
            };
            positions.set(`${phone}:${g.dataset.node}`, next);
            g.setAttribute("transform", `translate(${next.x} ${next.y})`);
          };
          g.onpointerup = () => {
            g.onpointermove = null;
            if (g.dataset.dragged) {
              render();
            }
          };
        };
        g.onmouseenter = () => highlight(g.dataset.node);
        g.onmouseleave = () => highlight(focus);
        g.onfocus = () => highlight(g.dataset.node);
      });
    highlight(focus);
  };
  const render = () => {
    const restoreFocus = preserveRelationshipFocus(document.activeElement);
    paintNetwork();
    restoreFocus();
  };
  const facets = () => {
    for (const [id, field, label] of [
      ["networkTerritory", "territory", "All territories"],
      ["networkVertical", "verticals", "All verticals"],
    ]) {
      const select = $(id),
        value = currentFilters[field === "verticals" ? "vertical" : field];
      const values = [
        ...new Set(
          (snapshot?.nodes || [])
            .flatMap((n) => (field === "verticals" ? n.verticals : [n[field]]))
            .filter(Boolean),
        ),
      ].sort();
      select.innerHTML =
        `<option value="">${label}</option>` +
        values.map((v) => `<option value="${E(v)}">${E(v)}</option>`).join("");
      if (snapshot && value && !values.includes(value))
        select.add(new window.Option(value, value));
      select.value = value;
    }
  };
  const invalidate = () => {
    snapshot = null;
    if (!openLinkedRecord) {
      focus = null;
      stepId = null;
    }
    positions.clear();
    facets();
    render();
    dialog.clear({ restoreFocus: true });
    $("networkUpdated").textContent = "Updating…";
  };
  const refresh = async ({ signal } = {}) => {
    const seq = ++epoch;
    $("networkRefresh").setAttribute("aria-busy", "true");
    try {
      const next = await readWithDeadline(
        (s) => client.getRelationshipNetwork({ signal: s, ...(stepId && { step: stepId }) }),
        { signal },
      );
      if (disposed || seq !== epoch) return;
      if (!validNetwork(next) || Date.parse(next.valid_until) <= Date.now())
        throw Error("invalid_network");
      const network = readableNetwork(next);
      snapshot = { ...network, connectionsByNode: indexConnections(network) };
      facets();
      $("networkNotice").hidden = true;
      $("networkUpdated").textContent = updatedLabel(next.observed_at, BUSINESS_TIME_ZONE);
      render();
      dialog.update(snapshot);
      if (openLinkedRecord && snapshot.nodes.some(node => node.id === focus)) open(focus);
      openLinkedRecord = false;
    } catch (error) {
      if (disposed || seq !== epoch) return;
      const expired = [401, 403].includes(error.status);
      if (expired) intro.retire();
      if (
        expired ||
        !snapshot ||
        Date.parse(snapshot.valid_until) <= Date.now()
      ) {
        invalidate();
      }
      $("networkNotice").hidden = false;
      $("networkNotice").innerHTML = expired
        ? '<a href="/auth/login?return_to=%2Frelationships">Sign in</a>'
        : 'Connections temporarily unavailable. <button type="button">Retry</button>';
      if (!expired) {
        $("networkNotice").querySelector("button").onclick = auto.refresh;
        dialog.showReadError();
      }
      $("networkUpdated").textContent = "Updating…";
    } finally {
      if (seq === epoch) $("networkRefresh").setAttribute("aria-busy", "false");
    }
  };
  const auto = mountAutoRefresh({ document, window, refresh, intervalMs });
  const selectTab = (value) => {
    const refs = value === "referrals";
    for (const id of ["graphTab", "referralsTab"]) {
      const active = (id === "referralsTab") === refs;
      $(id).setAttribute("aria-selected", String(active));
      $(id).tabIndex = active ? 0 : -1;
    }
    $("graphView").hidden = refs;
    $("referralsView").hidden = !refs;
    address();
  };
  ["graphTab", "referralsTab"].forEach((id) => {
    $(id).onclick = () => selectTab(id === "referralsTab" ? "referrals" : "");
    $(id).onkeydown = (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const next =
          e.key === "Home"
            ? "graphTab"
            : e.key === "End"
              ? "referralsTab"
              : id === "graphTab"
                ? "referralsTab"
                : "graphTab";
        $(next).click();
        $(next).focus();
      }
    };
  });
  const localEvents = new window.AbortController();
  const phoneFilters = window.matchMedia(TOUCH_LAYOUT);
  const foldFilters = () => { $("networkFilters").open = !phoneFilters.matches; };
  foldFilters();
  phoneFilters.addEventListener("change", foldFilters, { signal: localEvents.signal });
  window.addEventListener('doctorcre-session-invalidated', () => intro.retire(), { signal: localEvents.signal });
  const applyFilters = () => {
    if (disposed) return;
    const filteredOut = Boolean(snapshot && focus)
      && !filterNetwork(snapshot, currentFilters).nodes.some(n => n.id === focus);
    if (filteredOut) {
      focus = null;
      stepId = null;
    }
    limit = 12;
    listed = DIRECTORY_PAGE;
    positions.clear();
    render();
    address();
    if (filteredOut) dialog.clear({ restoreFocus: true });
  };
  const kindControl = mountRelationshipKindFilter($("networkKindFilter"), {
    value: currentFilters.kind,
    onChange(kind) {
      $("networkKind").focus();
      currentFilters.kind = kind;
      applyFilters();
    },
  });
  for (const id of ["networkSearch", "networkTerritory", "networkVertical"])
    // eslint-disable-next-line no-restricted-syntax -- Registers input/change callbacks for only 3 network filters; 0 lifecycle reads.
    $(id).addEventListener(id === "networkSearch" ? "input" : "change", () => {
      currentFilters.q = $("networkSearch").value;
      currentFilters.territory = $("networkTerritory").value;
      currentFilters.vertical = $("networkVertical").value;
      applyFilters();
    }, { signal: localEvents.signal });
  $("networkReset").onclick = () => {
    for (const id of ["networkSearch", "networkTerritory", "networkVertical"])
      $(id).value = "";
    Object.assign(currentFilters, { q: "", territory: "", vertical: "", kind: "" });
    kindControl.setValue("");
    applyFilters();
  };
  $("networkRefresh").onclick = auto.refresh;
  $("networkMoreNodes").onclick = () => {
    listed += DIRECTORY_PAGE;
    render();
  };
  $("networkMore").onclick = () => {
    limit += 12;
    render();
  };
  $("networkZoomIn").onclick = () => {
    zoom = Math.min(2, zoom + 0.2);
    render();
  };
  $("networkZoomOut").onclick = () => {
    zoom = Math.max(0.6, zoom - 0.2);
    render();
  };
  $("networkFit").onclick = () => {
    zoom = 1;
    positions.clear();
    render();
  };
  const resize = () => render();
  window.addEventListener("resize", resize);
  const expiry = mountLocalTicker({ document, window, intervalMs: 1000, tick: () => {
    if (!snapshot || Date.parse(snapshot.valid_until) > Date.now()) return;
    invalidate();
    auto.poll();
  } });
  selectTab(params.get("view"));
  render();
  auto.refresh();
  return {
    refresh: auto.refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      localEvents.abort();
      kindControl.dispose();
      epoch++;
      auto.dispose();
      dialog.dispose();
      intro.dispose();
      expiry.dispose();
      window.removeEventListener("resize", resize);
    },
  };
}
if (
  typeof document !== "undefined" &&
  document.getElementById("networkCanvas")
) {
  const boot = resolveDealroomBoot(location);
  const client =
    boot.mode === "live"
      ? (await import("./live-client.js")).createLiveClient()
      : await (await import("./fixture-client.js")).createFixtureClient(boot.options);
  mountRelationshipNetwork({ document, window, client });
}
