import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium, waitForAsync} from './browser-harness.mjs';
import worker from "../src/worker.js";
import {openEngineClientWebsite, renderClientPortalLink} from '../js/client-portal-link.js';
const root=new URL('../',import.meta.url);
const PORTAL='https://share.doctorcre.com/demo-practice';

test('the client portal link renders only for https and escapes the address',()=>{
 assert.equal(renderClientPortalLink(null),'');
 assert.equal(renderClientPortalLink(''),'');
 assert.equal(renderClientPortalLink('javascript:alert(1)'),'');
 assert.equal(renderClientPortalLink('http://share.doctorcre.com/demo'),'');
 const html=renderClientPortalLink('https://share.doctorcre.com/a"b');
 assert.match(html,/href="https:\/\/share\.doctorcre\.com\/a&quot;b"/);
 assert.match(html,/target="_blank" rel="noopener noreferrer"/);
});

test("the deal opens a grant only at its configured share origin", async (t) => {
  const deal = "00000000-0000-4000-8000-000000000001";
  const staging = "https://share-staging.example.test";
  const production = "https://share.doctorcre.com";
  const grantPath = "/example-site/?grant=00000000-0000-4000-8000-000000000002";
  const opened = [];
  const tab = {
    opener: null,
    document: { body: { textContent: "" } },
    location: { replace: (url) => opened.push(url) },
    close: () => {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { open: () => tab },
  });
  t.after(() => Reflect.deleteProperty(globalThis, "window"));

  let grantUrl = staging + grantPath;
  const bindings = {
    CLIENT_WEBSITE_ORIGIN: staging,
    ENGINE_ROUTING: new Map([["deals-from-engine", "on"]]),
    ENGINE: {
      fetch: async () => Response.json({ url: grantUrl }, {
        headers: { "x-doctorcre-client-website-origin": production },
      }),
    },
  };
  t.mock.method(globalThis, "fetch", async (path, init) =>
    worker.fetch(new Request("https://app.example.test" + path, init), bindings),
  );

  assert.equal(await openEngineClientWebsite(deal), null);
  for (const other of [production, staging + ".invalid", "http://share-staging.example.test"]) {
    grantUrl = other + grantPath;
    assert.match((await openEngineClientWebsite(deal)) ?? "", /Could not open/);
  }
  bindings.CLIENT_WEBSITE_ORIGIN = production;
  grantUrl = production + grantPath;
  assert.equal(await openEngineClientWebsite(deal), null);
  assert.deepEqual(opened, [staging + grantPath, production + grantPath]);
});

test("the app refuses to request a grant without a configured share origin", async (t) => {
  const endpoint = "https://app.example.test/api/engine/deals/00000000-0000-4000-8000-000000000001/client-website/open";
  const forward = t.mock.fn(async () => Response.json({
    url: "https://share.doctorcre.com/example-site/?grant=00000000-0000-4000-8000-000000000002",
  }));
  for (const origin of [undefined, "", "http://share.example.test"]) {
    const response = await worker.fetch(new Request(endpoint, { method: "POST" }), {
      CLIENT_WEBSITE_ORIGIN: origin,
      ENGINE_ROUTING: new Map([["deals-from-engine", "on"]]),
      ENGINE: { fetch: forward },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "client_website_origin_unconfigured" });
  }
  assert.equal(forward.mock.callCount(), 0);
});

async function open(t,width=1280,{portal=null,closed=false}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
 Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Negotiation',workspace_kind:'team',account_client_id:null,operating_state:'active',client_portal_url:portal});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/data/board-seed.json')return route.fulfill({json:seed});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({json:{}});
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}
  catch{return route.fulfill({status:404,body:''});}
});
 if(closed) Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Closed',closed_on:'2026-10-02',outcome:'won'});
 await page.goto('http://localhost/deals'+(closed?'?deal=d14':''));
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.deals.size>0);
 return {page,errors};
}

for(const width of [390,1280]) test(`a set link shows on the deal card and opens safely at ${width}px`,async t=>{
 const {page,errors}=await open(t,width,{portal:PORTAL});
 const card=page.locator('.kanban-card[data-id="d14"]');
 const link=card.getByRole('link',{name:/Client website/});
 assert.equal(await link.getAttribute('href'),PORTAL);
 assert.equal(await link.getAttribute('target'),'_blank');
 assert.match(await link.getAttribute('rel'),/noopener/);
 await link.focus();
 assert.equal(await page.evaluate(()=>document.activeElement.className),'client-portal-link');
 assert.ok((await link.boundingBox()).height>=44,'touch target');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
 assert.equal(await page.locator('.kanban-card:not([data-id="d14"]) .client-portal-link').count(),0);
 assert.deepEqual(errors,[]);
});

test('a deal without a link shows none on its card',async t=>{
 const {page}=await open(t);
 assert.equal(await page.locator('.client-portal-link').count(),0);
});

test('a partner registers the portal from the deal panel, a taken name is refused, and the password is never shown again',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');await state.client.registerClientPortal({deal:'d20',slug:'taken',password:'other',idempotency_key:'seed-taken'});});
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
 const submit=async(slug,password)=>{
  await page.locator('#detailClientPortalForm').waitFor({state:'attached'});
  if(!await page.locator('#clientPortalSlug').isVisible())await page.locator('.client-portal-register summary').click();
  await page.locator('#clientPortalSlug').fill(slug);
  assert.equal(await page.locator('#clientPortalPassword').getAttribute('type'),'password');
  await page.locator('#clientPortalPassword').fill(password);
  await page.getByRole('button',{name:'Register website'}).click();
 };
 const card=page.locator('.kanban-card[data-id="d14"] .client-portal-link');
 await submit('taken','simple-pw');
 await page.waitForFunction(()=>document.getElementById('detailClientPortalStatus')?.textContent.includes('That website name is already taken'));
 assert.doesNotMatch(await page.locator('#detailClientPortalStatus').innerText(), /portal/i);
 assert.match(await page.locator('#receiptDock').innerText(), /Client website/);
 assert.doesNotMatch(await page.locator('#receiptDock').innerText(), /portal/i);
 assert.equal(await card.count(),0);
 await submit('demo-practice','simple-pw');
 await card.waitFor({state:'attached'});
 assert.equal(await card.getAttribute('href'),PORTAL);
 await page.locator('#recordPanel .client-portal-link').waitFor({state:'attached'});
 assert.equal(await page.locator('#detailClientPortalForm').count(),0,'a registered deal offers no second registration');
 assert.equal(await page.locator('#clientPortalPassword').count(),0);
 assert.equal(await page.locator('input').evaluateAll(inputs=>inputs.some(input=>input.value==='simple-pw')),false);
 assert.equal((await page.locator('#recordPanel').innerText()).includes('simple-pw'),false);
 assert.deepEqual(errors,[]);
});

test('a closed deal shows its portal link without board controls',async t=>{
 const {page}=await open(t,1280,{portal:PORTAL,closed:true});
 const link=page.locator('#recordPanel .client-portal-link');
 await link.waitFor({timeout:3000});
 assert.equal(await link.getAttribute('href'),PORTAL);
 assert.equal(await page.locator('#detailClientPortalForm').count(),0);
});

test('a different password refusal explains the existing website password',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.registerClientPortal=async()=>{const error=new Error('fixture refusal');error.payload={error:'portal_password_differs'};throw error;};});
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
 await page.locator('.client-portal-register summary').click();
 await page.getByLabel('Website name').fill('demo-practice');
 await page.locator('#clientPortalPassword').fill('different-password');
 await page.getByRole('button',{name:'Register website'}).click();
 await page.waitForFunction(()=>document.getElementById('detailClientPortalStatus')?.textContent.includes('That password does not match the existing website password.'),null,{timeout:1500});
});

test('an unanswered registration can be checked with its original request',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const send=state.client.registerClientPortal.bind(state.client);let first=true;state.client.registerClientPortal=async request=>{if(first){first=false;throw new Error('offline');}return send(request);};});
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
 await page.locator('.client-portal-register summary').click();
 await page.getByLabel('Website name').fill('demo-practice');
 await page.locator('#clientPortalPassword').fill('simple-pw');
 await page.getByRole('button',{name:'Register website'}).click();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Check outcome'}).click({timeout:2000});
 await page.locator('.kanban-card[data-id="d14"] .client-portal-link').waitFor({state:'attached',timeout:2000});
});

test('the command dock keeps no portal password once a registration settles',async t=>{
 const {page}=await open(t);
 const retained=()=>page.evaluate(async()=>{const {dockEntries}=await import('/js/pipeline.js');return JSON.stringify([...dockEntries().values()].map(entry=>entry.request||null)).includes('secret-pw-1');});
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');await state.client.registerClientPortal({deal:'d20',slug:'taken',password:'other',idempotency_key:'seed-taken'});});
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
 await page.locator('.client-portal-register summary').click();
 await page.getByLabel('Website name').fill('taken');
 await page.locator('#clientPortalPassword').fill('secret-pw-1');
 await page.getByRole('button',{name:'Register website'}).click();
 await page.waitForFunction(()=>/already taken/.test(document.getElementById('detailClientPortalStatus')?.textContent||''));
 assert.equal(await retained(),false,'a refused registration leaves no password in the dock');
 await page.getByLabel('Website name').fill('demo-practice');
 await page.locator('#clientPortalPassword').fill('secret-pw-1');
 await page.getByRole('button',{name:'Register website'}).click();
 await page.locator('.kanban-card[data-id="d14"] .client-portal-link').waitFor({state:'attached'});
 assert.equal(await retained(),false,'a confirmed registration leaves no password in the dock');
});

for (const width of [390, 1280]) {
 for (const portal of [PORTAL, null, 'http://share.example.com/demo']) {
  test(`the opening snapshot shows the client website state at ${width}px for ${portal ? new URL(portal).protocol : 'absent'}`, async t => {
   const {page, errors} = await open(t, width, {portal});
   await page.locator('.kanban-card[data-id="d14"] .card-open').click();
   const snapshot = page.getByRole('region', {name:'Deal snapshot', exact:true});
   await snapshot.waitFor();
   const link = snapshot.getByRole('link', {name:/Client website/});
   if (portal === PORTAL) {
    assert.equal(await link.getAttribute('href'), PORTAL);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener noreferrer/);
    assert.equal(await page.locator('#recordPanel .client-portal-link').count(), 1);
   } else {
    assert.equal(await snapshot.getByRole('link').count(), 0);
    if (portal) await snapshot.getByText('Client website link is invalid.', {exact:true}).waitFor();
    else assert.equal(await snapshot.getByText('No client website linked.', {exact:true}).count(), 0);
   }
   const setup = page.locator('#recordPanel [data-detail-read="client-portal"]');
   assert.equal(await setup.locator('#detailClientPortalForm').count(), portal ? 0 : 1);
   if (!portal) {
    await setup.getByText('Set up client website', {exact:true}).click();
    assert.equal(await setup.getByLabel('Website name', {exact:true}).count(), 1);
    assert.equal(await setup.getByRole('button', {name:'Register website', exact:true}).count(), 1);
    assert.doesNotMatch(await setup.innerText(), /portal/i);
    await mkdir('out/test-artifacts/client-website', {recursive:true});
    await setup.screenshot({path:`out/test-artifacts/client-website/setup-${width}.png`});
   }
   assert.equal(await page.locator('#recordPanel [data-detail-read="client-portal"]').count(), 1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
   assert.deepEqual(errors, []);
  });
 }
}

test('a closed deal without a website has no website placeholder or setup', async t => {
 const {page} = await open(t, 1280, {closed:true});
 const snapshot = page.getByRole('region', {name:'Deal snapshot', exact:true});
 await snapshot.waitFor();
 assert.equal(await snapshot.getByText('No client website linked.', {exact:true}).count(), 0);
 assert.equal(await page.locator('#detailClientPortalForm').count(), 0);
});
