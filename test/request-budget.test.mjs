import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, TAB_REQUEST_LIMIT, INITIAL_ASSET_REQUEST_LIMIT, QUIET_TAB_REQUEST_LIMIT } from '../js/request-budget.mjs';
import { createSessionBoundary } from '../js/private-session.js';

test('the document caps HTTP attempts until trusted input',async t=>{
 t.mock.timers.enable({ apis: ['Date'] });
 const document=Object.assign(new EventTarget(),{visibilityState:'visible'});let app=0,api=0;
 const budget=createRequestBudget({document,fetchImpl:async path=>{
  if(String(path).includes('api.doctorcre'))api++;else app++;
  return Response.json(path==='/auth/session'?{actor:{slug:'joe'},csrf_token:'synthetic'}:{ok:true});
 }});
 const boundary=createSessionBoundary({fetchImpl:budget.fetch,invalidate:()=>assert.fail('budget exhaustion is not sign-out')});
 for(let i=0;i<1000;i++)await boundary.fetch('/mcp').catch(error=>assert.equal(error.code,'request_budget_exhausted'));
 assert.equal(app,600);assert.equal(api,0);assert.equal(budget.used,TAB_REQUEST_LIMIT);
 const scroll=new Event('scroll');Object.defineProperty(scroll,'isTrusted',{value:true});document.dispatchEvent(scroll);
 await assert.rejects(boundary.verify({fresh:true}),{code:'request_budget_exhausted'});assert.equal(app,600);
 document.dispatchEvent(new Event('pointerdown'));assert.equal(budget.used,600,'synthetic input cannot reset the counter');
 t.mock.timers.tick(119_999);
 const human=new Event('wheel');Object.defineProperty(human,'isTrusted',{value:true});document.dispatchEvent(human);
 await boundary.fetch('/mcp');assert.equal(app,601);assert.equal(budget.used,1);
 for (let i = 1; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');
 t.mock.timers.tick(1);
 returnToView(document);
 await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
 budget.dispose();
});

function returnToView(document) {
 for (const state of ['hidden', 'visible']) {
  document.visibilityState = state;
  document.dispatchEvent(new Event('visibilitychange'));
 }
}

test('returning to a tab with requests left preserves the remaining allowance', async t => {
 t.mock.timers.enable({ apis: ['Date'] });
 const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
 const budget = createRequestBudget({ document, fetchImpl: async () => new Response() });
 t.after(() => budget.dispose());

 await budget.fetch('/fixture');
 t.mock.timers.tick(120_000);
 returnToView(document);
 for (let i = 1; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');
 await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
});

test('rapid returns cannot restore an exhausted tab again within two minutes', async t => {
 t.mock.timers.enable({ apis: ['Date'] });
 const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
 let requests = 0;
 const budget = createRequestBudget({ document, fetchImpl: async () => { requests++; } });
 t.after(() => budget.dispose());
 const exhaust = async () => {
  for (let i = 0; i < TAB_REQUEST_LIMIT; i++) await budget.fetch('/fixture');
 };

 await exhaust();
 t.mock.timers.tick(120_000);
 returnToView(document);
 assert.equal(requests, TAB_REQUEST_LIMIT, 'returning to view does not itself send a request');
 await exhaust();
 for (let i = 0; i < 20; i++) {
  t.mock.timers.tick(500);
  returnToView(document);
  await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
 }
 assert.equal(requests, 2 * TAB_REQUEST_LIMIT);

 t.mock.timers.tick(120_000 - 10_000 - 1);
 returnToView(document);
 await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
 t.mock.timers.tick(1);
 returnToView(document);
 await exhaust();
 assert.equal(requests, 3 * TAB_REQUEST_LIMIT);

 budget.dispose();
 t.mock.timers.tick(120_000);
 returnToView(document);
 await assert.rejects(budget.fetch('/fixture'), { code: 'request_budget_exhausted' });
});

test('the deployed static payload retains platform headroom independently of per-page requests', async t => {
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {buildArtifact}=await import('../scripts/artifact.mjs');
 const {fileURLToPath}=await import('node:url');
 const built=await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:temporaryDirectory('quiet-tab-assets-',t),commit:'1'.repeat(40)});
 assert.equal(INITIAL_ASSET_REQUEST_LIMIT,400);assert.equal(QUIET_TAB_REQUEST_LIMIT,1000);
 const {assetBudget}=await import('../scripts/asset-budget.ts');
 const capacity=assetBudget(built.manifest.files.length);
 t.diagnostic(JSON.stringify(capacity));
 assert.ok(capacity.headroom>=capacity.minimumHeadroom);
});
