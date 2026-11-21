import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, TAB_REQUEST_LIMIT } from '../js/request-budget.mjs';
import { createSessionBoundary } from '../js/private-session.js';

test('a burst shares the 600-request limit, including session checks', async t => {
 t.mock.timers.enable({ apis: ['Date'] });
 let requests = 0;
 const budget = createRequestBudget({ fetchImpl: async path => {
  requests++;
  return Response.json(path === '/auth/session' ? { actor: { slug: 'joe' }, csrf_token: 'synthetic' } : { ok: true });
 } });
 const boundary = createSessionBoundary({ fetchImpl: budget.fetch, invalidate: () => assert.fail('budget exhaustion is not sign-out') });
 for (let i = 1; i < TAB_REQUEST_LIMIT; i++) await boundary.fetch('/mcp');
 await assert.rejects(boundary.fetch('/mcp'), { code: 'request_budget_exhausted' });
 await assert.rejects(boundary.verify({ fresh: true }), { code: 'request_budget_exhausted' });
 assert.equal(requests, 600);
 t.mock.timers.tick(1_000);
 await boundary.verify({ fresh: true });
 assert.equal(requests, 601);
});

test('rapid visibility changes and trusted input grant only the elapsed refill', async t => {
 t.mock.timers.enable({ apis: ['Date'] });
 const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
 const budget = createRequestBudget({ document, fetchImpl: async () => new Response() });
 for (let i = 0; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');

 const input = new Event('pointerdown');
 Object.defineProperty(input, 'isTrusted', { value: true });
 for (let i = 1; i <= 20; i++) {
  t.mock.timers.tick(500);
  for (const state of ['hidden', 'visible']) {
   document.visibilityState = state;
   document.dispatchEvent(new Event('visibilitychange'));
  }
  document.dispatchEvent(input);
  if (i % 2 === 0) await budget.fetch('/fixture');
  await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
 }
});

test('sustained demand after exhaustion averages at most 60 requests per minute', async t => {
 t.mock.timers.enable({ apis: ['Date'] });
 let requests = 0;
 const budget = createRequestBudget({ fetchImpl: async () => { requests++; return new Response(); } });
 for (let i = 0; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');
 for (let minute = 0; minute < 2; minute++) {
  const before = requests;
  for (let i = 0; i < 600; i++) {
   t.mock.timers.tick(100);
   await budget.fetch('/fixture').catch(error => assert.equal(error.code, 'request_budget_exhausted'));
  }
  assert.equal(requests - before, 60);
 }
 t.mock.timers.tick(60 * 60_000);
 for (let i = 0; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');
 await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
});

test('a send can wait for one token and the pause clears on a successful read', async t => {
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
 const notices = [];
 const sent = [];
 const budget = createRequestBudget({
  onPauseChange: message => notices.push(message),
  fetchImpl: async (path, init) => {
   if (init.method === 'POST') sent.push(path);
   return new Response(null, { status: path === '/failed' ? 503 : 200 });
  },
 });
 for (let i = 0; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');

 const signal = new AbortController().signal;
 const sending = budget.fetch('/send', { method: 'POST', signal }, { waitForBudget: true }).catch(error => error);
 t.mock.timers.tick(999);
 assert.deepEqual(sent, []);
 assert.equal(notices.length, 1);
 assert.match(notices[0], /paused/i);
 t.mock.timers.tick(1);
 assert.equal((await sending).ok, true);
 assert.deepEqual(sent, ['/send']);

 t.mock.timers.tick(1_000);
 await budget.fetch('/failed');
 assert.equal(notices.length, 1);
 t.mock.timers.tick(1_000);
 await budget.fetch('/fixture');
 assert.deepEqual(notices, [notices[0], null]);
});

test('the deployed static payload retains platform headroom independently of per-page requests', async t => {
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {buildArtifact}=await import('../scripts/artifact.mjs');
 const {fileURLToPath}=await import('node:url');
 const built=await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:temporaryDirectory('quiet-tab-assets-',t),commit:'1'.repeat(40)});
 const {assetBudget}=await import('../scripts/asset-budget.ts');
 const capacity=assetBudget(built.manifest.files.length);
 t.diagnostic(JSON.stringify(capacity));
 assert.ok(capacity.headroom>=capacity.minimumHeadroom);
});
