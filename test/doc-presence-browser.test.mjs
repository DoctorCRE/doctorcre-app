import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, pausedClock, settles } from './browser-harness.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { workspace, detail, emptyQuietFollowUps } from './leads-workspace-fixture.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
const root=new URL('../',import.meta.url);
const contract=(await import("../js/routes.js")).routeContract;
async function setup(t,{width=1440,motion='no-preference',onRoute,engine=chromium}={}) {
 const browser=await engine.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion});
 // Playwright polls synchronous predicates. Import the page store once so
 // readiness checks return a boolean rather than a truthy Promise.
 await page.addInitScript(()=>window.addEventListener('DOMContentLoaded',()=>{
  import(new URL('/js/doc-context.js',location.href).href).then(({pageDocContext})=>{window.docContext=pageDocContext;});
 },{once:true}));
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 const calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['http://localhost','https://app.doctorcre.com'].includes(url.origin))return route.abort();
  if(onRoute && await onRoute(route,{url,fixture}))return;
  if(['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}});
  if(url.pathname==='/mcp'){
  const {name,arguments:args}=request.postDataJSON().params;calls.push({name,args});let value=name==='quiet-follow-ups'?emptyQuietFollowUps():{ok:true};
   const methods={'read-home-agenda':'getHomeAgenda','read-post-call-followups':'getPostCallFollowups','deal-room-board':'getBoard','get-deal-room':'getDeal','deal-room-changes':'getChanges','list-doc-conversations':'listDocConversations','read-doc-conversation':'readDocConversation','notification-feed':'notificationFeed','find':'find','find-and-catch-up':'findAndCatchUp'};
   if(name==='lead-board') value={leads:[],stages:[],as_of:new Date().toISOString()};
   else if(name==='claim-card') value={claimable:0,candidates:[],needs_contact_count:0};
   else if(methods[name]) { value=await fixture[methods[name]](name==='get-deal-room'?args.deal||args.deal_id:name==='deal-room-changes'?args.cursor:args); if(name==='get-deal-room') value={...value.deal,deal_id:value.deal.id,thread:value.thread,critical_dates:value.critical_dates.map(row=>({...row,due_on:row.date})),next_actions:value.next_actions,activities:value.activities,events:[]}; }
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(value)}]}})});
  }
  if(url.pathname.startsWith('/api/')) return route.fulfill({contentType:'application/json',body:'{}'});
  const file=contract.routes[url.pathname]||url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 const goto=async path=>{await page.goto('http://localhost'+path,{waitUntil:'domcontentloaded'});await page.locator('#appMainSlot').waitFor({state:'attached'});};
 return{page,goto,calls,errors};
}

const readContext=page=>page.evaluate(async()=> (await import('/js/doc-context.js')).pageDocContext.snapshot());
// Native close is queued separately from the key press. Wait for the product
// state as well as the dialog before inspecting the resulting projection.
async function escapeRecord(page, selector) {
 await page.evaluate(selector=>{
  window.recordCloseObserved=false;
  document.querySelector(selector).addEventListener('close',()=>queueMicrotask(()=>{window.recordCloseObserved=true;}),{once:true});
 },selector);
 await page.keyboard.press('Escape');
 await page.waitForFunction(selector=>window.recordCloseObserved&&!document.querySelector(selector).open &&
  window.docContext?.snapshot().selected===null,selector);
}
const rpc=async(route,payload)=>route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
const tourId='22222222-2222-4222-8222-222222222222';
const sampleTour={id:tourId,name:'Sample Tour',status:'draft',version:1,stops:[]};
async function producerRoute(route,{url,fixture}) {
 if(url.pathname==='/mcp'){
  const {name,arguments:args}=route.request().postDataJSON().params;
  if(name==='quiet-follow-ups'){await rpc(route,emptyQuietFollowUps());return true;}
  if(name==='lead-board'){const board=workspace();await rpc(route,{...board,...(args.lead_id?{detail:detail(board.leads.find(row=>row.id===args.lead_id))}:{})});return true;}
 }
 if(url.pathname.startsWith('/api/')){
  let data;
  if(url.pathname==='/api/tours/library')data={tours:[sampleTour]};
  if(url.pathname==='/api/tours/detail')data=sampleTour;
  if(url.pathname==='/api/v1/business/clients')data={rows:[],page:1,page_count:1};
  // The room answers after its cursor: a caught-up read returns no turns.
  if(data){await route.fulfill({json:{data,csrf_token:'synthetic'}});return true;}
 }
 return false;
}
for(const failure of [null,503,401])test(`R1/R2 Home healthy/partial/expired context survives scope correctly (${failure})`,async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/mcp' && route.request().postDataJSON().params.name==='read-home-agenda' && failure){await route.fulfill({status:failure,body:'{}'});return true;}
  return producerRoute(route,env);
 }});
 if(failure===401){
  await page.goto('http://localhost/review-workflows?mode=live');await page.waitForURL('**/public-shell/session-ended.html');
  assert.equal(await page.locator('#docPresence').count(),0);return;
 }
 await goto('/review-workflows?mode=live');await page.waitForFunction(()=>document.querySelector('#refreshHome').getAttribute('aria-busy')==='false');
 const before=await readContext(page);
 assert.equal(before.ready,failure===null,JSON.stringify(before));
 if(!failure) assert.ok(before.records.some(r=>r.kind==='deal'));
 assert.equal(before.records.some(r=>r.kind==='work'||r.kind==='incident'),false);
 await page.locator('[data-scope="mine"]').click();const after=await readContext(page);
 assert.equal(after.ready,failure===null);if(failure===401)assert.equal(after.records.length,0);
 if(!failure)assert.ok(after.records.some(r=>r.kind==='deal'));
 assert.equal(after.records.some(r=>r.kind==='work'||r.kind==='incident'),false);
});
test('versioned Leads details bind popup identity and native close clears it',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/leads?mode=live');
 await page.locator('.lead-card').first().click();
 await page.waitForFunction(()=>document.querySelector('#detailBody')?.textContent.includes('Captured correspondence'));let c=await readContext(page);
 assert.equal(c.ready,true,JSON.stringify(c));assert.deepEqual(c.selected,{kind:'lead',id:workspace().leads[0].id});assert.equal(c.active.title,'Dr. Example 1');
 await escapeRecord(page,'#leadDetail');assert.equal((await readContext(page)).selected,null);
});
test('held Leads collection recovers in the current local filter before opening a visible sidebar lead',async t=>{
 let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page,goto,errors}=await setup(t,{onRoute:async(route,env)=>{
  const params=env.url.pathname==='/mcp'?route.request().postDataJSON().params:null;
  if(params?.name==='lead-board' && params.arguments.workspace==='leads' && !params.arguments.lead_id){
   started();await held;await rpc(route,workspace());return true;
  }
  return producerRoute(route,env);
 }});
 await goto('/leads?mode=live');await entered;
 await page.locator('#appSidebarToggle').click();
 await page.locator('#leadSearch').fill('no matches');
 release();await page.locator('#leadBoard[aria-busy="false"]').waitFor();
 assert.equal(await page.locator('.lead-card').count(),0);
 const filtered=await readContext(page);
 assert.equal(filtered.ready,true,JSON.stringify(filtered));assert.deepEqual(filtered.records,[]);
 assert.equal(filtered.filters.search,'no matches');assert.ok(filtered.observedAt);
 await page.locator('#leadSearch').fill('');
 await page.locator('#leadBoard .lead-open').first().click();
 await page.waitForFunction(()=>document.querySelector('#detailBody')?.textContent.includes('Captured correspondence'));
 const opened=await readContext(page);assert.equal(opened.ready,true);assert.equal(opened.active.title,'Dr. Example 1');
 await escapeRecord(page,'#leadDetail');
 await page.locator('#leadSearch').fill('');
 const restored=await readContext(page);assert.equal(restored.ready,true);assert.ok(restored.records.length>0);
 assert.equal(restored.observedAt,filtered.observedAt);assert.deepEqual(errors,[]);
});
test('close readiness waits until queued context cleanup finishes',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/leads?mode=live');
 await page.locator('.lead-card').first().click();
 await page.evaluate(async()=>{
  const c=(await import('/js/doc-context.js')).pageDocContext,select=c.select;
  c.select=(kind,id)=>id===null?setTimeout(()=>select(kind,id),250):select(kind,id);
 });
 await escapeRecord(page,'#leadDetail');
 assert.equal((await readContext(page)).selected,null);
});
test('R6/R14 Tour background failure clears eligibility; search constrains original observation',async t=>{
 let outage=false;const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(outage && env.url.pathname==='/api/tours/detail'){await route.fulfill({status:503,json:{}});return true;}return producerRoute(route,env);
 }});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 assert.equal((await readContext(page)).ready,true);outage=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#detail-message').textContent.includes('unavailable'));
 assert.equal((await readContext(page)).ready,false);
 await escapeRecord(page,'#tour-dialog');await page.locator('#tour-filter').fill('no match');
 const c=await readContext(page);assert.equal(c.records.length,0);assert.equal(c.filters.query,'no match');assert.equal(c.ready,true);
});
for(const path of ['/api/tours/library','/api/tours/detail'])test(`R6 Tour authorization loss from ${path} clears global context`,async t=>{
 let denied=false;const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(denied && env.url.pathname===path){await route.fulfill({status:401,json:{}});return true;}return producerRoute(route,env);
 }});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#tour-library-state').textContent.includes('Sign in'));
 const c=await readContext(page);assert.equal(c.ready,false);assert.equal(c.records.length,0);
});
for(const dataset of ['clients','vendors'])test(`R12/R13/R18 ${dataset} facts and unsorted activity use the real directory seam`,async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname.startsWith('/api/v1/business/')){await route.fulfill({json:directoryFixture(url.href)});return true;}
  if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='find-and-catch-up'){
   await rpc(route,{state:'completed',match:{kind:dataset==='clients'?'client':'vendor',target:dataset==='clients'?'C-DEMO-1':'V-DEMO-1'},catch_up:{timeline:[{summary:'Older review',occurred_at:'2026-10-01T10:00:00Z'},{summary:'Newer review',occurred_at:'2026-10-01T11:00:00Z'}]}});return true;
  }return false;
 }});await goto('/'+dataset+'?all=true&mode=live');await page.locator('.record-row').first().click();await page.waitForFunction(()=>document.querySelector('#recordActivity')?.textContent.includes('Newer review'));
 const c=await readContext(page);assert.equal(c.ready,true);assert.equal(c.active.fields.find(f=>f.label==='Owner').value,'Joe');assert.equal(c.active.fields.find(f=>f.label==='Status').value,dataset==='clients'?'Active deal':'Warm');assert.equal(c.active.activity[0]?.text,'Newer review');
});
test('R11/R18 Search results support positive context through live MCP',async t=>{
 const {page}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname!=='/mcp'||route.request().postDataJSON().params.name!=='find')return false;
  await rpc(route,{schema_version:'search.v1',parties:[{id:'sample-practice',kind:'company',name:'Sample Practice',city:null,lead_id:null,roles:['client'],deals:[]}],deals:[]});
  return true;
 }});
 await page.goto('https://app.doctorcre.com/search',{waitUntil:'domcontentloaded'});
 await page.locator('#searchQuery').fill('Sample');await page.locator('#searchForm').dispatchEvent('submit');
 await page.waitForFunction(()=>{const c=window.docContext?.snapshot();return c?.ready&&c.records.some(r=>r.kind==='party'&&r.id==='sample-practice');});
});

for(const failure of ['timeout','malformed'])test(`R6 Tour background ${failure} invalidates eligible context`,async t=>{
 let outage=false,release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(outage&&env.url.pathname==='/api/tours/detail'){
   if(failure==='timeout'){started();await held;await route.fulfill({json:{data:sampleTour,csrf_token:'synthetic'}});}else await route.fulfill({json:{data:{id:tourId},csrf_token:'synthetic'}});return true;
  }return producerRoute(route,env);
 }});if(failure==='timeout')await page.clock.install();await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 outage=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));if(failure==='timeout'){await entered;await page.clock.fastForward(11000);}await page.waitForFunction(()=>document.querySelector('#detail-message').textContent.includes('unavailable'));
 assert.equal((await readContext(page)).ready,false);
});
test('R14 Tour no-match projection changes scope and preserves the library observation',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/tours');await page.locator('.tour-button').first().waitFor();const before=await readContext(page);
 await page.locator('#tour-filter').fill('no match');await page.waitForFunction(()=>document.querySelectorAll('.tour-button').length===0);
 const after=await readContext(page);assert.equal(after.records.length,0);assert.equal(after.filters.query,'no match');assert.ok(after.epoch>before.epoch);assert.equal(after.observedAt,before.observedAt);assert.equal(after.ready,true);
});
test('R11/R12 valid empty directory activity remains an authorized empty read',async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname.startsWith('/api/v1/business/')){await route.fulfill({json:directoryFixture(url.href)});return true;}
  if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='find-and-catch-up'){await rpc(route,{state:'completed',match:{kind:'client',target:'C-DEMO-1'},catch_up:{timeline:[]}});return true;}return false;
 }});await goto('/clients?all=true&mode=live');await page.locator('.record-row').first().click();await page.waitForFunction(()=>document.querySelector('#recordActivity')?.textContent.includes('No recent activity'));
 const c=await readContext(page);assert.equal(c.ready,true);assert.deepEqual(c.active.activity,[]);
});

test('R14 Tour closed detail cannot survive a no-match library filter',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 await escapeRecord(page,'#tour-dialog');await page.locator('#tour-filter').fill('no match');assert.equal((await readContext(page)).records.length,0);
});

test('R13/R18 incomplete conversation reports unknown recent activity in the retained context',async t=>{
 const id='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
 const {page,goto}=await setup(t,{onRoute:async(route,{url,fixture})=>{
  if(url.pathname!=='/mcp'||route.request().postDataJSON().params.name!=='read-doc-conversation')return false;
  await rpc(route,{...await fixture.readDocConversation({conversation_id:id}),latest_sequence:6,more:true,
   turns:[{sequence:1,body:'Earlier sample turn',at:'2026-10-01T10:00:00Z'},
    {sequence:2,body:'Later sample turn on first page',at:'2026-10-01T11:00:00Z'}]});return true;
 }});
 await goto('/doc-chats?mode=live&id='+id);
 await page.waitForFunction(()=> {const c=window.docContext?.snapshot();return c?.ready&&c.active?.activityComplete===false;});
 const answer=await page.evaluate(async id=>{
  const c=(await import('/js/doc-context.js')).pageDocContext;
  return (await import('/js/doc-context-model.js')).docAnswer(c.snapshot(),{kind:'conversation',recordId:id,question:'Recent activity'});
 },id);
 assert.equal(answer.state,'unknown');assert.equal(answer.value,null);
 assert.deepEqual((await readContext(page)).recentActivity,[]);
});
test('R18 closed Deal detail cannot survive an empty board projection',async t=>{
 let empty=false;
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(empty && url.pathname==='/mcp' && route.request().postDataJSON().params.name==='deal-room-board'){await rpc(route,{deals:[],actor:'joe',workspace_kind:'team'});return true;}return false;
 }});await page.clock.install();await goto('/deals?mode=live&deal=d14');
 await page.waitForFunction(()=>window.docContext?.snapshot().active?.id==='d14');
 await page.locator('#panelClose').click();
 await page.waitForFunction(()=>window.docContext?.snapshot().selected===null);
 empty=true;await page.clock.fastForward(61_000);
 await page.waitForFunction(()=>document.querySelectorAll('.kanban-card').length===0);
 const c=await readContext(page);assert.equal(c.ready,true);assert.deepEqual(c.records,[]);
});
test('R18 a held Search response cannot publish under a later query scope',async t=>{
 let release;const held=new Promise(r=>release=r);t.after(()=>release());
 const {page}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname==='/js/search-page.js'){
   // Let the old read answer after cancellation so this exercises the epoch
   // guard. The normal client aborts it before Doc can receive its response.
   await route.fulfill({contentType:'text/javascript',body:`
    import { createLiveClient } from './live-client.js';
    import { mountSearch } from './search.js';
    const client=createLiveClient(),find=client.find.bind(client);
    client.find=args=>find(args);
    mountSearch({client});
   `});return true;
  }
  if(url.pathname!=='/mcp'||route.request().postDataJSON().params.name!=='find')return false;
  await held;await rpc(route,{parties:[{ref:'C-SAMPLE',kind:'client',name:'Old query sample',merged:false}],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Sample'});return true;
 }});
 await page.goto('https://app.doctorcre.com/search');
 await page.evaluate(async()=>{
  const c=(await import('/js/doc-context.js')).pageDocContext,finish=c.finish;
  c.finish=(ticket,...args)=>{const result=finish(ticket,...args);if(ticket?.method==='find')window.finishedFind=result;return result;};
 });
 const requested=page.waitForRequest(request=>request.url().endsWith('/mcp')&&request.postDataJSON()?.params?.name==='find');
 await page.locator('#searchQuery').fill('Old query');await page.locator('#searchForm').dispatchEvent('submit');await requested;
 await page.locator('#searchQuery').fill('');await page.locator('#searchForm').dispatchEvent('submit');
 release();await page.waitForFunction(()=>window.finishedFind!==undefined);
 assert.equal(await page.evaluate(()=>window.finishedFind),false);
 const c=await readContext(page);assert.equal(c.filters.query,'');assert.deepEqual(c.records,[]);assert.equal(c.ready,false);
});


// The dock can resend a retained suggestion request long after its card was
// clicked. Both its retry and its reconcile must honour the switch.
for(const trigger of ['resume','identity-failure']) test(`F9 Leads ${trigger} clears Doc while identity is delayed and only fresh workspace restores it`,async t=>{
 let hold=false,release;const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const {page,goto,errors}=await setup(t,{onRoute:async(route,env)=>{
  if(hold && env.url.pathname==='/auth/session'){await held;if(trigger==='identity-failure'){await route.fulfill({status:503,body:''});return true;}}
  return producerRoute(route,env);
 }});
 await goto('/leads?mode=live');await page.locator('.lead-card').first().click();
 await page.waitForFunction(()=>window.docContext?.snapshot().active);
 hold=true;
 const suspended=await page.evaluate(trigger=>{
  if(trigger==='resume')window.dispatchEvent(new Event('online'));else document.getElementById('refreshBoard').click();
  return {context:window.docContext.snapshot(),cards:document.querySelectorAll('.lead-card').length,detail:document.getElementById('leadDetail').open};
 },trigger);
 if(trigger==='resume'){assert.equal(suspended.cards,0);assert.equal(suspended.detail,false);}
 assert.equal(suspended.context.ready,false);assert.deepEqual(suspended.context.records,[]);
 release();
 if(trigger==='identity-failure'){await page.waitForFunction(()=>document.querySelectorAll('.lead-card').length===0);assert.deepEqual((await readContext(page)).records,[]);hold=false;await page.locator('#refreshBoard').click();}
 await page.waitForFunction(()=>window.docContext?.snapshot().ready);
 assert.ok((await readContext(page)).records.length>0);assert.deepEqual(errors,[]);
});

test('F9 ordinary Leads refresh restores the open detail context after revalidation',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/leads?mode=live');
 await page.locator('.lead-card').first().click();await page.waitForFunction(()=>window.docContext?.snapshot().active);
 await page.locator('#refreshBoard').evaluate(node=>node.click());
 await page.waitForFunction(()=>document.getElementById('leadBoard').getAttribute('aria-busy')==='false');
 const c=await readContext(page);assert.equal(c.ready,true);assert.equal(c.active?.title,'Dr. Example 1');
 assert.deepEqual(c.selected,{kind:'lead',id:workspace().leads[0].id});
});
