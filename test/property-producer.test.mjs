import { init, parse } from 'es-module-lexer';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { transform } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from 'node:crypto';
import { handleDoctorcreRequest } from "../src/worker.js";

import { carrInterface } from "./carr-contract.mjs";
import { committedTourWebModule } from "./tour-producer.mjs";

const contract = carrInterface;


const producerModules = new Map();
async function producerModuleUrl(path) {
  if (producerModules.has(path)) return producerModules.get(path);
  let source = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  // Erase type-only imports before resolving runtime dependencies from the pin.
  source = (await transform(source, { loader: path.endsWith(".json") ? "json" : path.endsWith(".ts") ? "ts" : "js", format: "esm", target: "es2022" })).code;
  for (const match of [...source.matchAll(/from\s+(["'])(\.\.?\/[^"'\n]+)\1/g)]) {
    const dependency = await producerModuleUrl(posix.join(posix.dirname(path), match[2]));
    source = source.replace(match[1] + match[2] + match[1], JSON.stringify(dependency));
  }
  const resolvePackage = createRequire(`${process.env.CARR_PRODUCER_CHECKOUT}/mcp-server/package.json`);
  await init;
  const [imports] = parse(source);
  for (const entry of imports.toReversed()) {
    if (!entry.n || entry.n.startsWith('.') || /^[a-z][a-z0-9+.-]*:/i.test(entry.n)) continue;
    source = source.slice(0, entry.s) + pathToFileURL(resolvePackage.resolve(entry.n)).href + source.slice(entry.e);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  producerModules.set(path, url);
  return url;
}

test("the runtime pin binds the checklist and feature-switch reads to one producer", () => {
  const seam = contract.mcp_read_contracts["get-deal-room"].checklist;
  assert.equal(seam.producer.source_commit, contract.producer.source_commit);
  assert.equal(contract.mcp_read_contracts["get-deal-room"].producer.source_commit, contract.producer.source_commit);
  assert.equal(contract.mcp_read_contracts["list-feature-switches"].producer.source_commit, contract.producer.source_commit);
});

test("the advertised runtime registers inherited conversation, notification, session and room contracts", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify inherited registrations",
}, async () => {
  const registry = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:mcp-server/src/tools.js`], { encoding: "utf8" });
  for (const [module, factory, verbs] of [
    ["client-portal.ts", "clientPortalTools", ["register-client-portal"]],
    ["doc-conversation.js", "docConversationTools", ["read-doc-conversation", "list-doc-conversations", "create-doc-conversation", "rename-doc-conversation", "share-doc-conversation"]],
    ["notifications.ts", "notificationTools", ["notification-feed", "acknowledge-notification", "read-notification-preferences", "set-notification-preference"]],
    ["codex-continuity.js", "codexContinuityTools", ["list-my-codex-sessions"]],
    ["session-identity.ts", "sessionIdentityTools", ["read-session-identity", "read-dispatch-history"]],
    ["partner-room.js", "partnerRoomTools", ["read-room", "read-room-latest", "read-room-queue", "add-room-turn"]],
    ["dispatch-spine.ts", "dispatchSpineTools", ["record-dispatch-link", "acknowledge-dispatch"]],
    ["tour-property-search.js", "tourPropertySearchTools", ["search-tour-properties", "read-tour-selection-cart", "append-tour-selection-cart-version"]],
  ]) {
    assert.match(registry, new RegExp(`registerTools\\(${factory}\\(`), `${factory} must be registered`);
    const producer = await import(await producerModuleUrl(`mcp-server/src/${module}`));
    const tools = producer[factory]({});
    for (const verb of verbs) {
      assert.ok(contract.mcp_operations.includes(verb), `${verb} must remain in the app interface`);
      assert.equal(typeof tools[verb]?.handler, "function", `${verb} must exist at the advertised runtime`);
      assert.equal(tools[verb].inputSchema.type, "object");
    }
  }
});

test("the same advertised producer derives the versioned checklist consumed by the app", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify checklist derivation",
}, async () => {
  const { deriveDealChecklist, CHECKLIST_SOURCES } = await import(await producerModuleUrl("mcp-server/src/deal-checklist.ts"));
  const seam = contract.mcp_read_contracts["get-deal-room"].checklist;
  const checklist = deriveDealChecklist({ type: "renewal", critical_dates: [
    { id: "synthetic-review", kind: "attorney_review", due_on: "2026-10-20", source: "fixture:review", status: "open" },
  ] }, CHECKLIST_SOURCES.map(source => ({ id: source.section_id, body_hash: source.content_hash, status: "active" })), "2026-10-20");
  assert.equal(checklist.schema_version, seam.schema_version);
  assert.equal(checklist.template_state, "current");
  assert.deepEqual(checklist.phases.map(phase => phase.id), seam.phase_keys);
  assert.ok(checklist.phases.flatMap(phase => phase.items).every(item => seam.statuses.includes(item.status)));
  assert.equal(checklist.due_items[0].status, "due");
  const { uiBundle } = await import('../scripts/ui-bundle.mjs');
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
  const { mountDealChecklist } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
  const dom = new JSDOM('<main></main>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const host = document.querySelector('main');
  const panel = mountDealChecklist(host, {dealId:'synthetic',checklist});
  assert.ok(host.querySelector('[data-checklist-item="critical-date:synthetic-review"]'));
  panel.dispose(); dom.window.close();

});

test('S2 consumer contract binds the operation and concurrency contract to the advertised producer', async () => {
  const seam = contract.write_reconciliation;
  const bytes = await readFile(new URL(`../${seam.contract}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), seam.sha256);
  assert.equal(seam.producer.source_commit, contract.producer.source_commit);
  const schema = JSON.parse(bytes);
  assert.equal(schema.schema, 'doctorcre-app-write-reconciliation.v1');
  assert.deepEqual(Object.keys(schema.replacements), ['set-next-step', 'set-market-agent', 'set-national-account-owner']);
  for (const replacement of Object.values(schema.replacements)) assert.equal(replacement.expected, 'base_version');
  assert.match(schema.mcp_session.binding, /x-carr-csrf/);
});

test('S2 contract bytes match the exact producer revision', {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && 'Set CARR_PRODUCER_CHECKOUT to verify write reconciliation',
}, async () => {
  const local = await readFile(new URL('../contracts/app-write-reconciliation.v1.json', import.meta.url), 'utf8');
  const producer = execFileSync('git', ['-C', process.env.CARR_PRODUCER_CHECKOUT, 'show',
    `${contract.producer.source_commit}:mcp-server/contracts/app-write-reconciliation.v1.json`], { encoding: 'utf8' });
  assert.equal(local, producer);
});

// Opt-in cross-repository verification reads committed source, never a working
// tree or database. The ordinary app suite remains offline and self-contained.
test("the exact pinned producer serves property evidence alongside the existing Tour reads", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned producer",
}, async () => {
  const git = (...args) => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, ...args], { encoding: "utf8" });
  const pin = contract.producer.source_commit;
  const { createTourInternalWebHandler, isTourInternalRequest } = await committedTourWebModule(path => git("show", `${pin}:${path}`));
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const asOf = "2026-09-29T12:00:00.000Z";
  const data = { schema: "tour-property-evidence.v1", property_id: propertyId, as_of: asOf, facts: {} };
  const calls = [];
  const handler = createTourInternalWebHandler({
    readPropertyEvidenceFn: async context => { calls.push(context); return { ok: true, data }; },
    listToursFn: async () => ({ ok: true, data: { tours: [] } }),
    readTourSelectionCartFn: async () => ({ ok: true, data: { stops: [] } }),
  });
  const request = new Request(`https://app.doctorcre.com/api/tours/property-evidence/v1?property_id=${propertyId}&as_of=${encodeURIComponent(asOf)}`);
  const env = { APP_HOST: "app.doctorcre.com" };
  const actor = { id: "synthetic-partner" };
  const session = { csrfToken: "synthetic-csrf" };
  const response = await handler.fetch(request, env, {}, actor, session);
  assert.equal(response.status, 200, `property evidence must exist at ${pin}`);
  assert.equal(isTourInternalRequest(request), true);
  assert.deepEqual(await response.json(), { data, csrf_token: session.csrfToken });
  assert.deepEqual(calls[0].input, { property_id: propertyId, as_of: asOf });
  assert.deepEqual(calls[0].actor, actor);
  assert.equal((await handler.fetch(request, env, {})).status, 401);
  for (const path of ["/api/tours/library", `/api/tours/selection-cart?tour_id=${propertyId}`]) {
    assert.equal((await handler.fetch(new Request(`https://app.doctorcre.com${path}`), env, {}, actor, session)).status, 200);
  }
  git("merge-base", "--is-ancestor", "c4f1ad45273175c26c074336c0fecbf789718348", pin);
  git("merge-base", "--is-ancestor", "0cc6fe2538a81521bf8c25b0df58aa4063ed614b", pin);
});


test("the consumer contract does not advertise the removed runtime error ingress", () => {
  assert.equal(contract.runtime_errors, undefined);
  assert.equal(contract.http_surfaces.includes("/api/v1/runtime-errors"), false);
});

test('deal item contracts retain the checklist shape across the board upgrade', () => {
  for (const verb of ['get-deal-room', 'deal-room-board']) {
    const read = contract.mcp_read_contracts[verb];
    assert.equal(read.producer.source_commit, contract.producer.source_commit);
    assert.equal(read.response.item_schema_version, 'deal-items.v1');
    assert.deepEqual(read.response.item_keys, ['id', 'title', 'due_on', 'status', 'bullets', 'source_ref']);
  }
  for (const verb of ['instruct-deal-item', 'complete-deal-item']) {
    const write = contract.mcp_write_contracts[verb];
    assert.equal(write.producer.source_commit, contract.producer.source_commit);
    assert.ok(write.inputSchema.required.includes('item_id'));
    assert.ok(write.inputSchema.required.includes('idempotency_key'));
  }
});

test('the pinned producer item shapes and command schemas match the app contract', {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && 'Set CARR_PRODUCER_CHECKOUT to verify deal item contracts',
}, async () => {
  const { dealItemTools, validateDealItem, DEAL_ITEMS_SCHEMA } = await import(await producerModuleUrl('mcp-server/src/deal-items.ts'));
  const { renderDealAlert, renderDealItemDetail } = await import('../js/deal-items.js');
  const tools = dealItemTools({});
  assert.equal(DEAL_ITEMS_SCHEMA, contract.mcp_read_contracts['get-deal-room'].response.item_schema_version);
  for (const verb of ['record-deal-item', 'instruct-deal-item', 'complete-deal-item']) {
    assert.deepEqual(tools[verb].inputSchema, contract.mcp_write_contracts[verb].inputSchema);
    assert.equal(tools[verb].write, true);
  }
  const item = { id: '10000000-0000-4000-8000-000000000001', status: 'open', ...validateDealItem({
    title: 'Vendor Introductions', due_on: '2026-10-23', source_ref: 'call:synthetic',
    bullets: [{ date: '2026-10-22', kind: 'call', text: 'Two introductions requested.' }],
  }) };
  const deal = { id: 'synthetic-deal', short_name: 'Synthetic Sample Deal', items: [item] };
  assert.match(renderDealAlert(deal), /Vendor Introductions/);
  assert.match(renderDealItemDetail(item), /Two introductions requested/);
});
