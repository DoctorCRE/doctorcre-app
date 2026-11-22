import { withoutRecordCodes } from './visual-system.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { stepOriginLabel } from './email-source-line.js';
import {
  escapeHtml as E,
  NODE_LABELS,
  indexConnections,
  shortSummary,
} from "./relationship-network-model.js";
const relationshipDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const PAGE_SIZE = 20;

function renderConnection({ other, links }) {
  const introducersByLabel = new Map();
  for (const { label, introducer } of links) {
    if (!introducersByLabel.has(label)) introducersByLabel.set(label, new Set());
    if (introducer) introducersByLabel.get(label).add(withoutRecordCodes(introducer.name));
  }
  const labels = [...introducersByLabel].map(([label, names]) =>
    names.size ? `${label} · via ${[...names].join(", ")}` : label,
  ).join(" · ");
  const latest = links[0];
  const date = Number.isFinite(latest.time)
    ? `<time datetime="${E(latest.when)}">${E(latest.label)} · ${E(relationshipDate.format(latest.time))}</time>`
    : "";
  const evidence = links.map(({ id, summary, detail }) => {
    const excerpt = shortSummary(summary);
    const notes = detail && detail.trim().replace(/\s+/g, " ") !== excerpt
      ? `<details data-entry="${E(id)}"><summary data-card-key="detail:${E(id)}">Details</summary><p>${E(detail)}</p></details>`
      : "";
    return `${excerpt ? `<p>${E(excerpt)}</p>` : ""}${notes}`;
  }).join("");
  return `<article class="relationship-entry"><span>${E(labels)}</span><button type="button" data-open-node="${E(other.id)}" data-card-key="connection:${E(other.id)}">${E(withoutRecordCodes(other.name))} <span aria-hidden="true">↗</span></button>${date}${evidence}</article>`;
}

export function mountRelationshipDialog({ document, onReviewIntroduction, onRefresh, onOpenNode, activeStep }) {
  const dialog = document.createElement("dialog");
  dialog.className = "relationship-dialog";
  dialog.setAttribute("aria-labelledby", "relationshipTitle");
  document.body.append(dialog);
  let snapshot, selected, returnFocus;
  let visibleConnections = PAGE_SIZE;
  let readFailed = false;
  const setSnapshot = (value) => {
    snapshot = { ...value, connectionsByNode: value.connectionsByNode ?? indexConnections(value) };
  };
  const paint = () => {
    const node = snapshot?.nodes.find((n) => n.id === selected);
    if (!node) {
      dialog.close();
      return;
    }
    const expanded = new Set(
      [...dialog.querySelectorAll("details[open]")].map((d) => d.dataset.entry),
    );
    const focused = dialog.contains(document.activeElement)
      ? document.activeElement.dataset.cardKey
      : null;
    const connections = snapshot.connectionsByNode.get(node.id) ?? [];
    const headingCount = readFailed && !connections.length ? "" : ` ${connections.length}`;
    const readNotice = readFailed
      ? '<p role="status">Connections temporarily unavailable.</p><button type="button" data-retry-connections data-card-key="retry-connections">Retry</button>'
      : "";
    const empty = !readFailed && !connections.length ? "<p>No connections recorded</p>" : "";
    const more = connections.length > visibleConnections
      ? '<button type="button" data-more-connections data-card-key="more-connections">Show more</button>'
      : "";
    const destinations = { deal: ["deals", "deal"], client: ["clients", "record"], vendor: ["vendors", "record"] };
    const destination = Object.hasOwn(destinations, node.kind) && destinations[node.kind];
    const recordLink = destination && typeof node.record_id === "string" && node.record_id
      ? `<a data-card-key="record" href="/${destination[0]}?${destination[1]}=${E(encodeURIComponent(node.record_id))}">Open ${E(node.kind)} record</a>` : "";
    const refs = snapshot.referrals.find((r) => r.node_id === node.id);
    const step = snapshot.focused_step;
    const showStep = step && (!activeStep || activeStep() === step.id) && node.id === `party:${step.party_id}` && typeof step.what === "string";
    const origin = showStep && stepOriginLabel(step);
    const nextStep = showStep ? `<p class="relationship-summary" tabindex="-1" data-card-key="next-step"><strong>${step.status === "done" ? "Done" : "Next step"}:</strong> ${E(step.what)}${origin ? `<small> · ${E(origin)}</small>` : ""}</p>` : "";
    dialog.innerHTML = `<header><div><span class="relationship-kicker">${E(NODE_LABELS[node.kind])}</span><h2 id="relationshipTitle" tabindex="-1">${E(withoutRecordCodes(node.name))}</h2></div><button data-card-key="close" data-close-card type="button" aria-label="Close relationship">×</button></header><div class="relationship-detail-grid"><section>${recordLink}${nextStep}${node.contact_state && node.contact_state !== "active" ? `<span class="relationship-hold">Contact hold</span>` : ""}${node.summary ? `<p class="relationship-summary">${E(shortSummary(node.summary))}</p>${node.summary.trim().replace(/\s+/g, " ") !== shortSummary(node.summary) ? `<details data-entry="summary"><summary data-card-key="summary">Details</summary><p>${E(node.summary)}</p></details>` : ""}` : ""}${refs ? `<div class="relationship-metrics"><div><strong>${refs.deals}</strong><span>Deals sent</span></div>${refs.win_rate === null ? "" : `<div><strong>${Math.round(refs.win_rate * 100)}%</strong><span>Win rate · ${refs.won} won / ${refs.won + refs.lost} resolved</span></div>`}</div>` : ""}</section><section><h3>Connections${headingCount}</h3>${readNotice}${empty}${
      connections.slice(0, visibleConnections).map(renderConnection).join("")
    }${more}</section></div>`;
    if (onReviewIntroduction && snapshot.can_request_introductions !== false) for (const offer of snapshot.suggestions.filter(s => [s.from, s.to, s.via].includes(node.id))) {
      const action = document.createElement('button');
      action.type = 'button';
      action.dataset.reviewIntroduction = offer.id;
      action.className = 'relationship-review-action';
      action.textContent = `Review introduction: ${withoutRecordCodes([offer.from, offer.via, offer.to].filter(Boolean).map(id => snapshot.nodes.find(n => n.id === id)?.name).join(' → '))}`;
      action.onclick = () => onReviewIntroduction(offer.id);
      dialog.querySelector('.relationship-detail-grid').append(action);
    }
    dialog.querySelector("[data-close-card]").onclick = () => dialog.close();
    const retry = dialog.querySelector("[data-retry-connections]");
    if (retry) retry.onclick = onRefresh;
    const showMore = dialog.querySelector("[data-more-connections]");
    if (showMore) showMore.onclick = () => {
      const firstNew = visibleConnections;
      visibleConnections += PAGE_SIZE;
      paint();
      dialog.querySelectorAll("[data-open-node]")[firstNew]?.focus();
    };
    dialog.querySelectorAll("[data-open-node]").forEach(
      (b) =>
        (b.onclick = () => {
          if (onOpenNode) onOpenNode(b.dataset.openNode);
          else {
            selected = b.dataset.openNode;
            visibleConnections = PAGE_SIZE;
            paint();
            dialog.querySelector("h2").focus();
          }
        }),
    );
    dialog.querySelectorAll("details").forEach((d) => {
      d.open = expanded.has(d.dataset.entry);
    });
    if (focused)
      (
        [...dialog.querySelectorAll("[data-card-key]")].find(
          (n) => n.dataset.cardKey === focused,
        ) || dialog.querySelector("[data-close-card]")
      ).focus();
  };
  onDialogClosed(dialog, () => {
    selected = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
      return;
    }
    const key = returnFocus?.dataset.node || returnFocus?.dataset.introNode;
    if (key) {
      const replacement = [
        ...document.querySelectorAll("[data-node],[data-intro-node]"),
      ].find((n) => (n.dataset.node || n.dataset.introNode) === key);
      replacement?.focus();
    }
  });
  return {
    open(value, id, trigger = document.activeElement) {
      setSnapshot(value);
      selected = id;
      visibleConnections = PAGE_SIZE;
      if (!dialog.open) returnFocus = trigger;
      paint();
      if (selected) {
        if (!dialog.open) dialog.showModal();
        (dialog.querySelector('[data-card-key="next-step"]') ?? dialog.querySelector("h2")).focus();
      }
    },
    update(value) {
      setSnapshot(value);
      readFailed = false;
      if (dialog.open) paint();
    },
    showReadError() {
      if (readFailed) return;
      readFailed = true;
      if (dialog.open) paint();
    },
    clear() {
      snapshot = null;
      selected = null;
      returnFocus = null;
      dialog.close();
      dialog.replaceChildren();
    },
    dispose() {
      dialog.close();
      dialog.remove();
    },
  };
}
