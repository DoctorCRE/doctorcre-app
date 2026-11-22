import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import { chromium } from './browser-harness.mjs';
const root=new URL('../',import.meta.url);
async function open(t) {
 const outDir=await temporaryDirectory('session-lifecycle-');
 t.after(()=>rm(outDir,{recursive:true,force:true}));
 await buildArtifact({root:root.pathname,outDir,commit:'1'.repeat(40)});
 const server = await (await createQaServer({buildRoot:join(outDir,'site')})).start();t.after(()=>server.close());
 const origin=server.origin;
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage(),context=page.context(),errors=[];
 let actor='joe',denied=false,writes=0;
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/{api/system-work/session,auth/session}',route=>route.fulfill({status:actor?200:401,json:actor?{actor:{slug:actor},csrf_token:`synthetic-${actor}`}:{}}));
 await context.route('**/auth/signout',route=>{actor=null;return route.fulfill({status:302,headers:{location:'/'}});});
 await context.route('**/auth/session',route=>route.fulfill({status:actor?200:401,json:actor?{actor:{slug:actor},csrf_token:`synthetic-${actor}`}:{}}));
 await context.route('**/mcp',async route=>{
   // Like the old system, refuse a POST whose CSRF token is not the cookie session's.
   if(route.request().headers()['x-carr-csrf']!==`synthetic-${actor}`)return route.fulfill({status:403,json:{error:'forbidden'}});
   const {name,arguments:args}=route.request().postDataJSON().params;
   if(name==='list-doc-conversations' && denied)return route.fulfill({status:403,json:{error:'forbidden'}});
   if(name==='rename-doc-conversation')writes++;
   let payload={};
   if(name==='list-doc-conversations')payload=await fixture.listDocConversations({...args,limit:2});
   if(name==='list-feature-switches')payload={switches:[]};
   return route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
 });
 await page.request.post(`${origin}/api/test/seed`,{data:{namespace:'session-test',reset:true}});
 const visit=async p=>{await p.goto(`${origin}/doc-chats?mode=live`);await p.waitForFunction(()=>document.body.textContent.includes('Demo — Crestview'));};
 await visit(page);
 return {page,context,origin,visit,errors,get writes(){return writes;},get actor(){return actor;},switchActor(){actor='dell';},deny(){denied=true;}};
}
async function seedPrivate(page) {
 await page.evaluate(async()=>{
   localStorage.setItem('doctorcre.saved-views.v1:joe',JSON.stringify([{name:'Joe private query',query:'Joe private intention'}]));
   sessionStorage.setItem('doctorcre-tour-pending-v1','Joe private editor');
   const {offlineTourSession}=await import('/js/offline-tour-session.js');
   offlineTourSession(window).save({scope:'Joe-scope',userRef:'joe',tourId:'Joe-tour'});
   const {createDayStore}=await import('/tours/day-store.js');
   window.previousStore=createDayStore(indexedDB);
   await window.previousStore.putTour('Joe-scope',{id:'Joe-tour',name:'Joe private tour'});
   await window.previousStore.put({scope:'Joe-scope',id:'note-A',tour_id:'Joe-tour',audio:new Blob(['private audio'])});
   await (await caches.open('old-private-cache')).put('/auth/session',new Response('Joe private session'));
 });
}
async function assertPurged(page) {
 const state=await page.evaluate(async()=>{
   const {offlineTourSession}=await import('/js/offline-tour-session.js');
   const records=await new Promise((resolve,reject)=>{
     const req=indexedDB.open('doctorcre-tour-day-drafts-v1',1);req.onerror=reject;
     req.onsuccess=()=>{const db=req.result,tx=db.transaction(['notes','tours'],'readonly'),values=[];for(const name of ['notes','tours']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>values.push(...r.result);}tx.oncomplete=()=>{db.close();resolve(values);};};
   });
   return {text:document.body.textContent,saved:localStorage.getItem('doctorcre.saved-views.v1:joe'),pending:sessionStorage.getItem('doctorcre-tour-pending-v1'),binding:offlineTourSession(window).read('Joe-tour'),caches:await caches.keys(),records};
 });
 assert.doesNotMatch(state.text,/Joe private|Demo — Crestview/);
 assert.equal(state.saved,null);assert.equal(state.pending,null);assert.equal(state.binding,null);assert.deepEqual(state.caches,[]);assert.deepEqual(state.records,[]);
}
test('S1 browser: sign-out clears both tabs, saved queries, offline itinerary/audio and old CacheStorage',async t=>{
 const app=await open(t);await seedPrivate(app.page);
 const other=await app.context.newPage();await app.visit(other);await seedPrivate(other);
 await app.page.locator('#selfAvatar').click();await app.page.getByText('Sign out',{exact:true}).click();
 await Promise.all([app.page.waitForURL('**/public-shell/session-ended.html'),other.waitForURL('**/public-shell/session-ended.html')]);
 await assertPurged(app.page);await assertPurged(other);
 await app.context.setOffline(true);
 const restored=await other.evaluate(async()=>{const {offlineTourSession}=await import('/js/offline-tour-session.js');return offlineTourSession(window).read('Joe-tour');});
 assert.equal(restored,null);assert.deepEqual(app.errors,[]);
});
test('S1 browser: account switch with an old editor prevents its write and clears every previous-session copy',async t=>{
 const app=await open(t);await seedPrivate(app.page);
 app.switchActor();
 await app.page.evaluate(()=>{void import('/js/private-session.js').then(({sessionFetch})=>sessionFetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({params:{name:'rename-doc-conversation',arguments:{title:'Joe private edit'}}})}));});
 await app.page.waitForURL('**/public-shell/session-ended.html');
 assert.equal(app.writes,0);await assertPurged(app.page);assert.deepEqual(app.errors,[]);
});
test('S1 browser: denied later Doc Chat page clears the whole view and private browser stores',async t=>{
 const app=await open(t);await seedPrivate(app.page);app.deny();
 await app.page.locator('#showMoreConversations').click();
 await app.page.waitForURL('**/public-shell/session-ended.html');
 await assertPurged(app.page);assert.deepEqual(app.errors,[]);
});
test('S1 browser: Back reloads private pages once and checks the current session', async t => {
 const app = await open(t);
 for (const path of ['/', '/deals', '/leads', '/leases', '/doc-chats', '/doc-chats/work', '/control-room', '/updates']) {
  await app.page.goto(`${app.origin}${path}?mode=live`);
  await app.page.waitForFunction(() => document.querySelector('#selfAvatar')?.textContent === 'J');
  const url = app.page.url();
  const navigations = [];
  const track = request => { if (request.isNavigationRequest()) navigations.push(request.url()); };
  app.page.on('request', track);
  const loaded = app.page.waitForEvent('load', { timeout: 5_000 });
  await app.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await loaded;
  await app.page.waitForFunction(() => document.querySelector('#selfAvatar')?.textContent === 'J');
  app.page.off('request', track);
  assert.deepEqual(navigations, [url], path);
 }
 await app.visit(app.page);
 await seedPrivate(app.page);
 app.switchActor();
 await app.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
 await app.page.waitForURL('**/public-shell/session-ended.html');
 await assertPurged(app.page);
 assert.deepEqual(app.errors, []);
});

test('S1 browser: revocation clears a private tab title before asynchronous storage cleanup', async t => {
 const app=await open(t);
 const title=await app.page.evaluate(async()=>{
  const {privateSession}=await import('/js/private-session.js');
  document.title='Joe private conversation title';
  privateSession().revoke();
  return document.title;
 });
 assert.equal(title,'Session ended');
 await app.page.waitForURL('**/public-shell/session-ended.html');
 await assertPurged(app.page);assert.deepEqual(app.errors,[]);
});

test('S1/S2 browser: the shared Room writer succeeds in-session and retires an old-session retry', async t => {
 const app = await open(t), payloads = [];
 await app.context.route('**/api/room/turn', route => {
   if(route.request().headers()['x-carr-csrf']!==`synthetic-${app.actor}`)return route.fulfill({status:403,json:{error:'forbidden'}});
   payloads.push(route.request().postDataJSON());
   return route.fulfill({json:{ok:true,seq:payloads.length}});
 });
 const receipt = await app.page.evaluate(async () => {
   const {createRoomTurnClient} = await import('/js/room-turn-client.js');
   window.roomWriter = createRoomTurnClient({session:async () => 'synthetic-joe'});
   return window.roomWriter.send('composer',{body:'Synthetic same-session turn'});
 });
 assert.equal(receipt.ok,true);
 assert.match(payloads[0].idempotency_key,/^[0-9a-f-]{36}$/i);
 app.switchActor();
 await app.page.evaluate(() => { void window.roomWriter.send('composer',{body:'Synthetic old-session intent'}).catch(() => {}); });
 await app.page.waitForURL('**/public-shell/session-ended.html');
 assert.equal(payloads.length,1,'the retired editor cannot dispatch under the switched cookie');
 assert.deepEqual(app.errors,[]);
});
