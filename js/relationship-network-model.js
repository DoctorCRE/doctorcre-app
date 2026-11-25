import { dealName } from "./pipeline-model.js";

export const NODE_LABELS = { vendor: "Vendor", client: "Client", lead: "Lead", deal: "Deal", contact: "Contact" };

const NETWORK_SCHEMA = "carr-relationship-network.v1";
export const EDGE_LABELS = Object.freeze({
  knows: "Knows",
  works_with: "Works with",
  can_introduce: "Can introduce",
  intro_requested: "Introduction requested",
  introduced: "Introduced",
  intro: "Introduced",
  intro_received: "Introduction received",
  referral: "Referred",
  referred: "Referred",
  worked: "Worked on",
  client_deal: "Client deal",
});
export { escapeText as escapeHtml } from './change-receipts.mjs';
export function validNetwork(value) {
  if (
    value?.schema !== NETWORK_SCHEMA ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !Number.isFinite(Date.parse(value.valid_until)) ||
    Date.parse(value.valid_until) <= Date.parse(value.observed_at) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.referrals) ||
    !Array.isArray(value.suggestions)
  )
    return false;
  const ids = new Set();
  for (const node of value.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      ids.has(node.id) ||
      typeof node.name !== "string" ||
      !node.name.trim() ||
      !["vendor", "client", "lead", "deal", "contact"].includes(node.kind) ||
      !Array.isArray(node.verticals) ||
      node.verticals.some((v) => typeof v !== "string") ||
      !["territory", "owner", "summary", "contact_state"].every(
        key => node[key] == null || typeof node[key] === "string")
    )
      return false;
    ids.add(node.id);
  }
  const edges = new Set();
  for (const edge of value.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      edges.has(edge.id) ||
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      edge.from === edge.to ||
      (edge.via && !ids.has(edge.via)) ||
      !Object.hasOwn(EDGE_LABELS, edge.kind) ||
      !["summary", "detail", "when"].every(
        key => edge[key] == null || typeof edge[key] === "string")
    )
      return false;
    edges.add(edge.id);
  }
  const referrers = new Set();
  if (
    !value.referrals.every((row) => {
      if (
        !row || !ids.has(row.node_id) ||
        referrers.has(row.node_id) ||
        !["deals", "won", "lost"].every(
          (k) => Number.isInteger(row[k]) && row[k] >= 0,
        ) ||
        row.won + row.lost > row.deals ||
        row.win_rate !==
          (row.won + row.lost ? row.won / (row.won + row.lost) : null)
      )
        return false;
      referrers.add(row.node_id);
      return true;
    })
  )
    return false;
  return value.suggestions.every(
    (row) =>
      row && edges.has(row.id) &&
      ids.has(row.from) &&
      ids.has(row.to) &&
      (!row.via || ids.has(row.via)) &&
      typeof row.reason === "string" &&
      row.reason.trim() &&
      value.edges.some(
        (edge) =>
          edge.id === row.id &&
          edge.kind === "can_introduce" &&
          edge.from === row.from &&
          edge.to === row.to &&
          edge.via === row.via,
      ),
  );
}
export function filterNetwork(
  snapshot,
  { territory = "", vertical = "", q = "", kind = "" } = {},
) {
  const nodes = snapshot.nodes.filter(
    (n) =>
      (!kind || n.kind === kind) &&
      (!territory || n.territory === territory) &&
      (!vertical || n.verticals.includes(vertical)) &&
      (!q ||
        `${n.name} ${n.summary || ""}`
          .toLocaleLowerCase()
          .includes(q.toLocaleLowerCase())),
  );
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...snapshot,
    nodes,
    edges: snapshot.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to) && (!e.via || ids.has(e.via)),
    ),
    referrals: snapshot.referrals.filter((r) => ids.has(r.node_id)),
    suggestions: snapshot.suggestions.filter(
      (r) => ids.has(r.from) && ids.has(r.to) && (!r.via || ids.has(r.via)),
    ),
  };
}
export function introductionSuggestions(
  snapshot,
  { scope = "team", actor, limit = 3, now = Date.now() } = {},
) {
  if (!validNetwork(snapshot) || Date.parse(snapshot.valid_until) <= now)
    return [];
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  return snapshot.suggestions
    .filter(
      (s) =>
        scope !== "mine" ||
        (actor &&
          [s.from, s.to, s.via].some((id) => nodes.get(id)?.owner === actor)),
    )
    .slice(0, limit)
    .map((s) => ({
      ...s,
      path: [s.from, s.via, s.to].filter(Boolean).map(id => nodes.get(id)),
    }));
}
export function introductionRouteLabel(path) {
  return path.map(node => node.name).join(" → ");
}
// Old record codes, such as C-013, L-9001 or V-CPA-006, as whole words.
const CODE = String.raw`(?:[CLP]|V-[A-Z]{2,4})-\d+`;
const OLD_CODE = new RegExp(String.raw`(?<![\w-])${CODE}(?![\w-])`, "g");
const CODE_ONLY = new RegExp(`^${CODE}$`);
const CODE_TAG = new RegExp(String.raw`\s*\(${CODE}\)`, "g");
// "Suite C-100", "Unit P-2" and "lot L-12" are places, not old records.
const PLACE_BEFORE = /(?:\b(?:suite|ste|unit|lot|bldg|building|apt|space)\.?|#)\s*$/i;
// The old system left a bracketed note, a bare website or a number where a name belongs.
// Anything else, such as "Dr.Lee" or "Realtor.com", is a real name.
const PLACEHOLDER = /^(?:\(([^()]*)\)|(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|us|biz|info)\/?|\d+)$/;

const baseName = node => {
  const name = node.kind === "deal" ? dealName(node.name) : node.name.trim();
  return name.replace(CODE_TAG, "").trim() || name;
};
const resolveCodes = (text, names) =>
  text.replace(OLD_CODE, (code, at) => PLACE_BEFORE.test(text.slice(0, at)) ? code : names.get(code) ?? "an old record");

function readableName(node, names) {
  const name = baseName(node), kind = NODE_LABELS[node.kind];
  if (CODE_ONLY.test(name)) {
    const owner = names.get(name);
    return owner ? { name: `${kind} at ${owner}` } : { name: "An old record", unnamed: true };
  }
  const placeholder = PLACEHOLDER.exec(name);
  if (!placeholder) return { name: resolveCodes(name, names) };
  return { name: `Unnamed ${kind.toLowerCase()} (${resolveCodes(placeholder[1] ?? name, names)})`, unnamed: true };
}

// The one place a network name is shaped: every name reads as a name, records without one
// follow the named ones, and an old code reads as its record's name, else "an old record" (#1493).
export function readableNetwork(network) {
  const names = new Map(network.nodes.flatMap(node => {
    const name = node.ref && baseName(node);
    return name && !CODE_ONLY.test(name) && !PLACEHOLDER.test(name) ? [[node.ref, name]] : [];
  }));
  const text = value => value == null ? value : resolveCodes(value, names);
  const nodes = network.nodes.map(node => ({ ...node, ...readableName(node, names) }));
  return {
    ...network,
    nodes: [...nodes.filter(node => !node.unnamed), ...nodes.filter(node => node.unnamed)],
    edges: network.edges.map(edge => ({ ...edge, summary: text(edge.summary), detail: text(edge.detail) })),
    suggestions: network.suggestions.map(row => ({ ...row, reason: text(row.reason), detail: text(row.detail) })),
  };
}
function compareIds(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function indexConnections({ nodes, edges }) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const links = edges.map((edge) => {
    const time = Date.parse(edge.when);
    return {
      ...edge,
      label: EDGE_LABELS[edge.kind],
      introducer: nodesById.get(edge.via),
      time: Number.isNaN(time) ? -Infinity : time,
    };
  }).sort((a, b) => b.time - a.time || compareIds(a, b));

  const byNode = new Map();
  for (const link of links) {
    for (const id of new Set([link.from, link.to, link.via])) {
      if (!id) continue;
      // An introducer's connection opens the source of the introduction.
      const otherId = id === link.from ? link.to : link.from;
      if (!byNode.has(id)) byNode.set(id, new Map());
      const byOther = byNode.get(id);
      if (!byOther.has(otherId)) byOther.set(otherId, { other: nodesById.get(otherId), links: [] });
      byOther.get(otherId).links.push(link);
    }
  }
  return new Map([...byNode].map(([id, byOther]) => [
    id,
    [...byOther.values()].sort((a, b) =>
      b.links[0].time - a.links[0].time ||
      a.other.name.localeCompare(b.other.name, "en-US") ||
      compareIds(a.other, b.other),
    ),
  ]));
}
export function focusedNetwork(snapshot, focus, limit = 12) {
  const candidates = new Set([focus]);
  snapshot.edges.forEach((e) => {
    if ([e.from, e.to, e.via].includes(focus))
      [e.from, e.to, e.via].filter(Boolean).forEach((id) => candidates.add(id));
  });
  const ordered = [...candidates, ...snapshot.nodes.map((n) => n.id)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const ids = new Set(ordered.slice(0, limit));
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((n) => ids.has(n.id)),
    edges: snapshot.edges.filter((e) =>
      [e.from, e.to, e.via].filter(Boolean).every((id) => ids.has(id)),
    ),
    total: snapshot.nodes.length,
  };
}
export function shortSummary(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

export function closestFocus({ key, index }, keys) {
  const match = keys.indexOf(key);
  return match < 0 ? Math.min(index, keys.length - 1) : match;
}
