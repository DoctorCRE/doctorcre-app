import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import { componentDocument, chromium, waitForAsync } from './browser-harness.mjs';
import {dealHref} from '../js/home-dashboard-model.js';
const root=new URL('../',import.meta.url);
const longDealName='Example active deal with a longer heading and the full additional name';
// A touch tablet: the iPad Mini portrait profile.
const ipad={viewport:{width:768,height:1024},deviceScaleFactor:2,isMobile:true,hasTouch:true};
async function open(t,{width=1440,height=960,touch,device,link=false,longName=false,reducedMotion='no-preference',fixtureDelayMs=0,noteOrder=false}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({...(device?ipad:{viewport:{width,height},...(touch === undefined ? {} : {hasTouch:touch,isMobile:touch})}),reducedMotion});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-04T17:00:00Z')});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(['/api/system-work/session','/auth/session'].includes(url.pathname))return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-only'})});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
  if(url.pathname==='/data/board-seed.json' && fixtureDelayMs)await new Promise(resolve=>setTimeout(resolve,fixtureDelayMs));
  if(url.pathname==='/data/board-seed.json' && longName) {
   const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
   seed.deals.find(deal=>deal.id==='d14').name=longDealName;
   return route.fulfill({json:seed});
  }
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try {return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/deals');
 await waitForAsync(page, async()=> (await import('/js/pipeline.js')).state.deals.size>0);
 await page.evaluate(async noteOrder=>{
  const {state}=await import('/js/pipeline.js');const get=state.client.getDeal;
  window.timelineProbe={reads:0,fail:false,changed:false};
  state.client.getDeal=async (...args)=>{
   window.timelineProbe.reads++;if(window.timelineProbe.fail)throw new Error('Synthetic unavailable');
   const detail=await get(...args);if(args[0]!=='d14')return detail;
   if(noteOrder) return {...detail,activities:[],thread:[
    {id:'undated',kind:'note',actor:'joe',text:'Synthetic undated update'},
    {id:'earlier',kind:'note',actor:'dell',at:'2026-10-01T12:00:00.000001Z',text:'Synthetic earlier update'},
    {id:'latest',kind:'note',actor:'joe',at:'2026-10-01T07:00:00.000002-05:00',text:'Synthetic latest update. Landlord accepted the revised terms.'},
   ]};
   return {...detail,deal:{...detail.deal,phase:'Legal',phase_started_on:{research:'2026-09-20',legal:'2026-10-03'}},lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3'},
    history:[{id:'p1',field:'phase',new_value:'research',recorded_at:'2026-09-20T12:00:00Z'},{id:'p2',field:'phase',new_value:'legal',recorded_at:'2026-10-03T12:00:00Z'}],
    critical_dates:[...detail.critical_dates.filter(d=>d.kind),{id:'loi',kind:'loi_expiry',due_on:window.timelineProbe.changed?'2026-10-09':'2026-10-05',source:'Demo contract',note:'Demo LOI clause 2'}],
    activities:[{id:'mail',kind:'email',summary:window.timelineProbe.changed?'Demo updated allowance received':'Demo revised allowance received',detail:'Original synthetic email. '+ 'Clause text. '.repeat(30),occurred_at:'2026-10-02T12:00:00Z'},
     {id:'call',kind:'call',summary:'Demo lease terms discussed',detail:'Original synthetic call entry',occurred_at:'2026-10-01T12:00:00Z'},
     {id:'calendar',kind:'meeting',summary:'Demo premises appointment',detail:'Original synthetic calendar entry',source:'Demo calendar',occurred_at:'2026-10-03T12:00:00Z'},
     {id:'old',kind:'note',summary:'Demo historic entry',detail:'Original old entry',occurred_at:'2020-01-01T12:00:00Z'}],
    documents:[{id:'doc',prepared_at:'2026-10-03T12:00:00Z',note:'Demo revised lease entry. '+ 'Original document entry. '.repeat(20)}]};
  };
 },noteOrder);
 if(link) {
  // Follow the same exact href the Home flags and shared sidebar use.
  await page.evaluate(href=>{const a=document.createElement('a');a.href=href;a.id='homeDealFlag';a.textContent='Demo deal';document.body.append(a);},dealHref('d14'));
  // Navigation is checked in a second page below; keep this instrumented client.
  assert.equal(await page.locator('#homeDealFlag').getAttribute('href'),'/deals?deal=d14');
 }
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();await page.locator('#detailUpdateForm').waitFor();
 return {page,errors};
}

for(const width of [320,390,1280]) for(const theme of ['light','dark']) test(`unified phase timeline and full-width updates at ${width} ${theme}`,async t=>{
 const {page,errors}=await open(t,{width,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 assert.equal(await page.locator('.phase-rail').count(),1);
 assert.equal(await page.locator('.timeline-chart').count(),0);
 assert.equal(await page.locator('.phase-rail [aria-current] time').textContent(),'Oct 3, 2026');
 assert.equal(await page.locator('.deal-note[data-id="mail"]').count(),1);
 await page.locator('.updates-history > summary').click();
 await page.locator('.deal-note[data-id="mail"] summary').click();
 assert.match(await page.locator('.deal-note[data-id="mail"] .note-original').textContent(),/Original synthetic email/);
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
 assert.deepEqual(errors,[]);
});
test('refresh preserves expanded updates, focus, dates and draft through an outage',async t=>{
 const {page,errors}=await open(t);
 await page.locator('.updates-history > summary').click();
 const summary=page.locator('.deal-note[data-id="mail"] summary');await summary.click();await summary.focus();
 await page.evaluate(()=>window.timelineProbe.changed=true);await page.clock.fastForward(61_000);
 await page.waitForFunction(()=>document.querySelector('.deal-updates').textContent.includes('Demo updated allowance received'));
 assert.equal(await page.locator('.deal-note[data-id="mail"] details').evaluate(e=>e.open),true);
 assert.equal(await summary.evaluate(e=>document.activeElement===e),true);
 await page.locator('#dealUpdate').fill('Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=true);await page.clock.fastForward(61_000);
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();
 assert.equal(await page.locator('#dealUpdate').inputValue(),'Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=false);await page.clock.fastForward(61_000);
 await page.waitForFunction(()=>!document.querySelector('#detailReadStatus').textContent);
 assert.deepEqual(errors,[]);
});

test('W9 board/list use the same addressable popup and Home href opens it directly',async t=>{
 const {page,errors}=await open(t,{link:true});
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
 assert.equal(new URL(page.url()).searchParams.has('deal'),false);
 await page.locator('#listView').click();await page.locator('.deal-row[data-id="d14"] .card-open').click();
 assert.equal(await page.locator('#recordPanel').evaluate(e => !e.hidden),true);
 await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
 await page.locator('#homeDealFlag').click();
 await page.locator('#recordPanel:not([hidden]) #detailUpdateForm').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 assert.equal(await page.locator('#recordPanel:not([hidden])').count(),1);
 assert.deepEqual(errors,[]);
});




for (const theme of ['light','dark']) test(`phone phase labels are legible along a dated rail in ${theme}`,async t=>{
 const {page,errors}=await open(t,{width:390,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.getByRole('tab',{name:'Activity',exact:true}).click();
 const labels=await page.locator('.phase-rail li').evaluateAll(items=>items.map(item=>{
  const labels=[...item.querySelectorAll('span,abbr')].filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return s.display!=='none' && s.clipPath==='none' && r.width>=16 && r.height>=12 && parseFloat(s.fontSize)>=12;});
  return {top:item.getBoundingClientRect().top,labels:labels.map(n=>n.textContent)};
 }));
 assert.equal(labels.length,8);
 assert.ok(labels.every(p=>p.labels.length>0),JSON.stringify(labels));
 assert.equal(new Set(labels.map(p=>p.top)).size,2,'dates stay visible in two rows');
 assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.deepEqual(errors,[]);
});

for(const width of [1440,390]) for(const theme of ['light','dark']) test(`newest update preview and recorded history at ${width} ${theme}`, async t=>{
 const {page,errors}=await open(t,{width,noteOrder:true,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 assert.match(await page.locator('.updates-history > summary').textContent(), /3 updates.*Oct 1, 2026.*Synthetic latest update/);
 assert.equal(await page.locator('.updates-overview').count(), 0);
 assert.equal(await page.locator('.updates-history').evaluate(e=>e.open), false);
 await mkdir('out/test-artifacts/newest-updates',{recursive:true});
 await page.locator('.deal-updates').scrollIntoViewIfNeeded();
 await page.screenshot({path:`out/test-artifacts/newest-updates/preview-${width}-${theme}.png`});
 await page.locator('.updates-history > summary').click();
 assert.deepEqual(await page.locator('.deal-note').evaluateAll(rows=>rows.map(row=>row.dataset.id)),['latest','earlier','undated']);
 assert.equal(await page.locator('.deal-note').last().locator('time').textContent(),'Date not recorded');
 assert.equal(await page.locator('#recordPanel').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('.deal-updates').screenshot({path:`out/test-artifacts/newest-updates/history-${width}-${theme}.png`});
 assert.deepEqual(errors,[]);
});

test('update form offers the current next action and date at phone width', async t => {
 const {page}=await open(t,{width:390});
 const deal=await page.evaluate(async()=> (await (await import('/js/pipeline.js')).state.client.getDeal('d14')).deal);
 const form=page.locator('#detailUpdateForm');
 const editor=form.getByText('Change next step',{exact:true});
 assert.equal(await form.getByLabel('Next step').isVisible(),false);
 await form.getByLabel('Update').focus();
 await page.keyboard.press('Tab');
 assert.equal(await editor.evaluate(e=>e===document.activeElement),true);
 await page.keyboard.press('Enter');
 assert.equal(await form.getByLabel('Next step').inputValue(), typeof deal.next_step === 'object' ? deal.next_step?.text || '' : deal.next_step || '');
 assert.equal(await form.getByLabel('Next date').inputValue(),deal.next_date || '');
 for (const field of [form.getByLabel('Update'),editor,form.getByLabel('Next step'),form.getByLabel('Next date'),form.getByRole('button',{name:'Add update'})]) {
  assert.ok((await field.boundingBox()).height >= 44);
 }
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
 for (const label of ['Next step','Next date']) {
  await page.keyboard.press('Tab');
  assert.equal(await form.getByLabel(label).evaluate(e=>e===document.activeElement),true);
 }
 for (let i=0; i<4 && !await form.getByRole('button',{name:'Add update'}).evaluate(e=>e===document.activeElement); i++) await page.keyboard.press('Tab');
 assert.equal(await form.getByRole('button',{name:'Add update'}).evaluate(e=>e===document.activeElement),true);
});

for (const timezoneId of ['UTC','America/Chicago','America/Los_Angeles','Asia/Tokyo']) test(`Central deadline browser boundaries in ${timezoneId}`, async t => {
 const { ownedFixtureServer: fixtureServer } = await import("./fixture-probe.ts");
 const {exercise}=await import('../scripts/prove-deal-deadline-central-day.mjs');
 const fixture=await fixtureServer();t.after(()=>fixture.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({timezoneId});
 await page.clock.setFixedTime(new Date('2026-11-06T02:00:00Z'));
 await componentDocument(page, fixture.origin, {owner:'deadline date boundaries'});
 const assertions=await exercise(page,`${fixture.origin}/js/deal-timeline.js`);
 assert.equal(assertions.length,83);
 assert.ok(assertions.every(result=>result.passed));
});

const planPhase={phase:'legal',from_on:'2026-10-03',to_on:null,expected_from_on:null,expected_to_on:'2026-11-05'};
const planRows=[
 {id:'review',kind:'todo',phase:'legal',label:'Review the lease',state:'current',day:2,typical_days:7,from_on:'2026-10-03',expected_to_on:'2026-10-10'},
 {id:'sign',kind:'todo',phase:'legal',label:'Sign the lease',state:'expected',typical_days:7,expected_from_on:'2026-10-10',expected_to_on:'2026-10-17'},
 {id:'step:sample',kind:'step',phase:'legal',owner:'dell',state:'open',from_on:'2026-10-04',to_on:'2026-10-07',done_on:null,label:'Call about the lease',change_id:12},
];
const plan={phases:[planPhase],rows:planRows,arrows:[{from:'review',to:'sign',at_risk:false}],expected_signing_on:'2026-10-17',stale:null,own_dates:{},base_version:0};
async function providePlan(page, plan, {canSave=false}={}) {
 await page.evaluate(async ({plan,canSave})=>{
  const {state}=await import('/js/pipeline.js');
  const get=state.client.getDeal.bind(state.client);
  state.nextDealSaves=canSave;
  state.client.getDeal=async (...args)=>{
   const step=window.timelineProbe.step;
   const todoEnd=window.timelineProbe.todoEnd;
   const rows=plan.rows.map(row=>row.id==='step:sample' && step?{...row,to_on:step.due_on,change_id:step.change_id}:row.id==='sign' && todoEnd?{...row,expected_to_on:todoEnd}:row);
   const arrows=plan.arrows.map(arrow=>arrow.to==='deadline' && todoEnd?{...arrow,at_risk:false}:arrow);
   const updated=todoEnd?rows.map(row=>row.id==='deadline'?{...row,at_risk:false}:row):rows;
   return {...await get(...args),plan:{...plan,rows:updated,arrows},next_actions:[{id:'sample',description:'Call about the lease',change_id:step?.change_id??12}]};
  };
 },{plan,canSave});
 await page.getByRole('button',{name:'Back to deals',exact:true}).click();
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
}
async function showPlan(page, options={}) {
 await providePlan(page,plan,options);
 await page.getByRole('button',{name:'Lease signing expected Oct 17'}).click({timeout:3000});
 return page.getByRole('tabpanel',{name:'Plan'});
}

for(const [width,height] of [[1280,640],[1440,900]]) {
 test(`Plan keeps the chart on screen at ${width} × ${height}`,async t=>{
  const {page,errors}=await open(t,{width,height});
  const tab=await showPlan(page);
  await tab.getByRole('button',{name:'Sign the lease',exact:true}).first().waitFor();
  await tab.getByRole('button',{name:'Recorded only'}).click();
  assert.equal(await tab.getByRole('button',{name:/Sign the lease/}).count(),0);
  assert.equal(await tab.getByRole('button',{name:/Review the lease/}).count()>0,true);
  await tab.getByRole('button',{name:'Recorded only'}).click();
  await mkdir(new URL('out/test-artifacts/',root),{recursive:true});
  await page.screenshot({path:new URL(`out/test-artifacts/deal-plan-${width}.png`,root).pathname});
  assert.equal(await tab.evaluate(node=>{
    const outer=node.closest('#appMainSlot');
    return outer.scrollHeight<=outer.clientHeight && document.documentElement.scrollHeight<=innerHeight;
  }),true,'Plan fits without an outer scroll region');
  const box=await tab.locator('.timeline').boundingBox();
  assert.ok(box.y+box.height <= height);
  assert.deepEqual(errors,[]);
 });
}

test('moving another partner’s step from Plan uses its change version and can be undone',async t=>{
 const {page}=await open(t,{width:1280,height:640});
 const saves=[];
 let crossed=false;
 await page.route('**/api/engine/next-steps/sample/changes',async route=>{
  saves.push(route.request().postDataJSON());
  if(crossed) return route.fulfill({status:409,json:{error:'version_conflict'}});
  await route.fulfill({json:{change_id:12+saves.length}});
 });
 const tab=await showPlan(page,{canSave:true});
 const grip=tab.getByRole('button',{name:'Change date for Call about the lease'});
 await grip.focus(); await grip.press('ArrowRight');
 await tab.getByText('Thu, Oct 8',{exact:true}).waitFor();
 await grip.press('Enter');
 await tab.getByText('Call about the lease moved to Oct 8.').waitFor();
 await tab.getByRole('button',{name:'Undo',exact:true}).click();
 await tab.getByText('Call about the lease date restored.').waitFor();
 assert.deepEqual(saves.map(({due_on,seen_change_id,strict_version})=>[due_on,seen_change_id,strict_version]),[['2026-10-08',12,undefined],['2026-10-07',13,true]]);
 crossed=true;
 await grip.focus(); await grip.press('ArrowRight'); await grip.press('Enter');
 await tab.getByText('This step changed. Review the latest version.').waitFor();
 assert.equal(await tab.getByRole('button',{name:'Undo',exact:true}).count(),0);
});

test('a keyboard edit to the exact start day retains focus and saves',async t=>{
 const {page}=await open(t,{width:1440,height:900});
 const saves=[];
 await page.route('**/api/engine/deals/d14/plan-dates',async route=>{
  saves.push(route.request().postDataJSON());
  await route.fulfill({json:{base_version:1,previous_on:null}});
 });
 const tab=await showPlan(page,{canSave:true});
 const grip=tab.getByRole('button',{name:'Change date for Sign the lease'});
 await grip.focus();
 await grip.press('Shift+ArrowLeft');
 await tab.getByText('Sat, Oct 10',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Change date for Sign the lease');
 await page.keyboard.press('Enter');
 await tab.getByText('Sign the lease expected by Oct 10. What follows moved with it.').waitFor();
 assert.deepEqual(saves.map(({target_on})=>target_on),['2026-10-10']);
});

test('live reflow includes filtered-out successors and moves the signing date and phase spans',async t=>{
 const {page}=await open(t,{width:1440,height:900});
 await providePlan(page,{
  ...plan,
  phases:[
   {...planPhase,expected_to_on:'2026-10-24'},
   {phase:'due_diligence',from_on:null,to_on:null,expected_from_on:'2026-10-24',expected_to_on:'2026-10-24'},
   {phase:'closing',from_on:null,to_on:null,expected_from_on:'2026-10-24',expected_to_on:'2026-10-31'},
  ],
  rows:[
   planRows[0],
   {...planRows[1],id:'business_terms',label:'Lease terms'},
   {...planRows[1],id:'attorney_comments',label:'Attorney comments',expected_from_on:'2026-10-17',expected_to_on:'2026-10-24'},
   {...planRows[1],id:'executed_lease',label:'Lease signing',phase:'closing',expected_from_on:'2026-10-24',expected_to_on:'2026-10-31'},
  ],
  arrows:[{from:'review',to:'business_terms',at_risk:false},{from:'business_terms',to:'attorney_comments',at_risk:false},{from:'attorney_comments',to:'executed_lease',at_risk:false}],
  expected_signing_on:'2026-10-31',
 },{canSave:true});
 await page.getByRole('tab',{name:'Plan',exact:true}).click();
 const tab=page.getByRole('tabpanel',{name:'Plan'});
 await tab.getByRole('textbox',{name:'Filter steps'}).fill('Lease');
 assert.equal(await tab.getByRole('button',{name:'Attorney comments',exact:true}).count(),0);
 const signing=tab.locator('[data-row="executed_lease"] .timeline-when');
 const milestone=tab.locator('.deal-plan-list').getByRole('button',{name:/Lease signing/});
 const span=phase=>tab.locator('[data-group="'+phase+'"] .timeline-phase-bar');
 const width=phase=>span(phase).evaluate(node=>parseFloat(node.style.width));
 const left=phase=>span(phase).evaluate(node=>parseFloat(node.style.left));
 const legal=await width('legal');
 const closing=await left('closing');
 const dayWidth=Number(await tab.locator('.timeline').getAttribute('data-day-width'));
 await tab.getByRole('button',{name:'Change date for Lease terms'}).press('ArrowLeft');
 assert.deepEqual(
  [await signing.innerText(),(await milestone.innerText()).replace(/\s+/g,' '),await width('legal'),await left('closing')],
  ['exp. Oct 30','Lease signing exp. Oct 30',legal-dayWidth,closing-dayWidth],
 );
});

for (const view of ['Next two weeks','At risk']) test('a filtered date edit keeps its grip and then focuses the next row: '+view,async t=>{
 const {page}=await open(t,{width:1440,height:900});
 const atRisk=view==='At risk';
 const deadlines=atRisk?[
  {id:'deadline',kind:'critical_date',phase:'legal',label:'Letter expires',at_risk:true,on:'2026-10-16',status:'open'},
  {id:'other-deadline',kind:'critical_date',phase:'legal',label:'Other deadline',at_risk:true,on:'2026-10-14',status:'open'},
 ]:[];
 const saves=[];
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const day=atRisk?'2026-10-16':'2026-10-24';
 await page.route('**/api/engine/deals/d14/plan-dates',async route=>{
  saves.push(route.request().postDataJSON());
  await gate;
  await page.evaluate(day=>{window.timelineProbe.todoEnd=day;},day);
  await route.fulfill({json:{base_version:1,previous_on:null}});
 });
 await providePlan(page,{...plan,rows:[...planRows,...deadlines],arrows:atRisk?[...plan.arrows,{from:'sign',to:'deadline',at_risk:true}]:plan.arrows},{canSave:true});
 await page.getByRole('tab',{name:'Plan',exact:true}).click();
 const tab=page.getByRole('tabpanel',{name:'Plan'});
 const filter=tab.getByRole('button',{name:new RegExp(view)});
 await filter.click();
 const grip=tab.getByRole('button',{name:'Change date for Sign the lease'});
 const focused=()=>grip.evaluate(node=>node===document.activeElement);
 await grip.focus();
 await grip.press(atRisk?'ArrowLeft':'Shift+ArrowRight');
 assert.equal(await grip.count(),1,'the filtered row stays mounted during preview');
 assert.equal(await focused(),true);
 await page.keyboard.press('Enter');
 await tab.getByText('Saving…',{exact:true}).waitFor();
 assert.equal(await focused(),true,'the grip stays focused while the save is pending');
 release();
 await tab.getByText(/Sign the lease expected by/).waitFor();
 await grip.waitFor({state:'detached'});
 const expectedFocus=atRisk?'Other deadline':'Change date for Call about the lease';
 assert.equal(await tab.getByRole('button',{name:expectedFocus,exact:true}).evaluate(node=>node===document.activeElement),true);
 assert.equal(await filter.getAttribute('aria-pressed'),'true','the selected filter stays on');
 assert.deepEqual(saves.map(({target_on})=>target_on),[day]);
});

for (const width of [390,1440]) test(`consecutive dates from a single open step panel use the last saved version at ${width}`,async t=>{
 const {page}=await open(t,{width,height:900,touch:width===390});
 const saves=[];
 await page.route('**/api/engine/next-steps/sample/changes',async route=>{
  const body=route.request().postDataJSON();
  saves.push(body);
  if(body.seen_change_id!==11+saves.length) return route.fulfill({status:409,json:{error:'version_conflict'}});
  await route.fulfill({json:{change_id:12+saves.length}});
 });
 const tab=await showPlan(page,{canSave:true});
 const items=width===390?tab.getByRole('list',{name:'Plan items'}):tab.locator('[data-row="step:sample"] .timeline-label');
 await items.getByRole('button',{name:'Call about the lease',exact:true}).click();
 const detail=tab.getByRole('region',{name:'Call about the lease'});
 for (const day of ['08','09']) {
  await detail.getByRole('button',{name:'Change date',exact:true}).click();
  await detail.getByLabel('New date').fill('2026-10-'+day);
  await detail.getByRole('button',{name:'Save date',exact:true}).click();
  await detail.getByText('Oct '+Number(day),{exact:true}).waitFor({timeout:2500});
 }
 assert.deepEqual(saves.map(({seen_change_id})=>seen_change_id),[12,13]);
});

for (const receipt of ['written','crossed-again','old-engine']) test('a rebased step save guards Undo with the saved write version: '+receipt,async t=>{
 const {page}=await open(t,{width:1440,height:900});
 const saves=[];
 await page.route('**/api/engine/next-steps/sample/changes',async route=>{
  saves.push(route.request().postDataJSON());
  if (saves.length===1) return route.fulfill({json:{
   rebased:true,intervening_change_ids:[13],...(receipt==='old-engine'?{}:{write_change_id:14}),
  }});
  const {seen_change_id,strict_version}=saves[1];
  if (receipt==='crossed-again' && strict_version && seen_change_id===14)
   return route.fulfill({status:409,json:{error:'version_conflict',current_version:16}});
  await route.fulfill({json:{change_id:17}});
 });
 const tab=await showPlan(page,{canSave:true});
 const grip=tab.getByRole('button',{name:'Change date for Call about the lease'});
 await grip.focus();
 await grip.press('ArrowRight');
 await page.evaluate(receipt=>{window.timelineProbe.step={change_id:receipt==='crossed-again'?16:14,due_on:'2026-10-08'};},receipt);
 await grip.press('Enter');
 const undo=tab.getByRole('button',{name:'Undo',exact:true});
 if (receipt==='old-engine') {
  await tab.getByText(/Undo is unavailable/).waitFor({timeout:3000});
  assert.equal(await undo.count(),0);
 } else {
  await undo.click({timeout:3000});
  const message=receipt==='crossed-again'?'This step changed. Review the latest version.':'Call about the lease date restored.';
  await tab.getByText(message,{exact:true}).waitFor({timeout:3000});
  assert.equal(await undo.count(),0);
  assert.deepEqual(saves.map(({due_on,seen_change_id,strict_version})=>[due_on,seen_change_id,strict_version]),[
   ['2026-10-08',12,undefined],['2026-10-07',14,true],
  ]);
 }
});

test('Phone Plan lists items in date order and opens them inline',async t=>{
 const {page,errors}=await open(t,{width:390,height:844,touch:true});
 const tab=await showPlan(page);
 const list=tab.getByRole('list',{name:'Plan items'});
 await list.getByRole('button',{name:'Sign the lease',exact:true}).waitFor();
 assert.deepEqual(await list.getByRole('button').allTextContents(),['Call about the lease','Review the lease','Sign the lease']);
 const step=list.getByRole('listitem').first();
 assert.match(await step.innerText(),/Legal · Dell/);
 assert.match(await step.innerText(),/From Oct 4 · Oct 7/);
 await list.getByRole('button',{name:'Sign the lease',exact:true}).tap();
 const detail=list.getByRole('region',{name:'Sign the lease'});
 await detail.waitFor();
 assert.match(await detail.innerText(),/exp\. Oct 17/);
 assert.equal(await tab.locator('.timeline').count(),0);
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:600,height:844});
 await tab.getByRole('group',{name:'Zoom'}).waitFor();
 assert.equal(await tab.getByRole('list',{name:'Plan items'}).count(),0);

});

test('Overview names the signing date as recorded after the signing to-do is finished', async t=>{
 const {page}=await open(t,{width:1440,height:900});
 const signed={id:'executed_lease',kind:'todo',phase:'legal',label:'Sign the lease',state:'finished',from_on:'2026-10-17',to_on:'2026-10-17'};
 await providePlan(page,{...plan,rows:[planRows[0],signed,planRows[2]]});
 const signing=page.locator('.deal-plan-signing-link');
 await signing.waitFor();
 assert.equal(await signing.innerText(),'Lease signed Oct 17');
 await signing.click();
 await page.getByRole('tabpanel',{name:'Plan'}).getByRole('button',{name:'Sign the lease',exact:true}).first().waitFor();
});

for(const [width,height,touch] of [[1280,640,false],[1440,900,false],[390,844,true]]) test(`Deals Timeline expands one row per open deal at ${width} × ${height}`,async t=>{
 const {page}=await open(t,{width,height,touch,longName:touch});
 await page.evaluate(async ({planPhase,planRows,longDealName})=>{
  const {state}=await import('/js/pipeline.js');
  const get=state.client.getBoard.bind(state.client);
  const timeline={phase_spans:[planPhase],rows:planRows,arrows:[],dates:[],at_risk_count:0,expected_signing_on:'2026-10-17',stale:null};
  state.client.getBoard=async (...args)=>{
    const board=await get(...args);
    const rows=board.deals.filter(row=>row.id==='d14').map(row=>({...row,name:longDealName,short_name:null,owner:'dell',timeline}));
    const more=Array.from({length:23},(_,index)=>({...rows[0],id:`sample-${index}`,name:`Example deal ${index+1}`,short_name:null,owner:index%2?'joe':'dell'}));
    return {...board,board_from_engine:true,deals:[...rows,...more]};
  };
 },{planPhase,planRows,longDealName});
 await page.getByRole('button',{name:'Back to deals',exact:true}).click();
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByRole('button',{name:'Timeline',exact:true}).click();
 const picker=page.getByRole('combobox',{name:'Deal view'});
 for(const name of ['Closed deals','Lost deals']) {
  if(width===1280) assert.equal(await picker.getByRole('option',{name,exact:true}).count(),1);
  else assert.ok(await page.getByRole('button',{name,exact:true}).isVisible());
 }
 const chart=page.locator('#boardTimeline');
 assert.equal(await chart.getByRole('link',{name:longDealName,exact:true}).count(),1);
 const groups=chart.locator('[data-group]');
 assert.equal(await groups.count(),24);
 if(touch) {
  const primary=chart.getByRole('link',{name:longDealName,exact:true});
  assert.equal(await primary.evaluate(node=>getComputedStyle(node).webkitLineClamp),'2');
  assert.ok(await primary.evaluate(node=>node.clientHeight>parseFloat(getComputedStyle(node).lineHeight)));
  for(const name of ['Example deal 1','Example deal 10']) {
   const link=chart.getByRole('link',{name,exact:true});
    const layout=await link.evaluate(node=>{
    const row=node.closest('.timeline-group');
    const label=node.getBoundingClientRect();
    const phase=row.querySelector('.timeline-when').getBoundingClientRect();
    const bounds=row.getBoundingClientRect();
    return {clipped:node.scrollWidth>node.clientWidth,labelTop:label.top,labelBottom:label.bottom,phaseTop:phase.top,phaseBottom:phase.bottom,top:bounds.top,bottom:bounds.bottom};
   });
   assert.ok(!layout.clipped && layout.top<=layout.labelTop && layout.labelBottom<=layout.phaseTop && layout.phaseBottom<=layout.bottom,JSON.stringify(layout));
  }
 } else {
  await page.locator('#boardTimelineTools').getByRole('button',{name:'Today',exact:true}).waitFor();
  // Reserve the space that a non-overlay scrollbar uses inside the chart box.
  await page.addStyleTag({content:"#boardTimeline .timeline-scroll { border-block-end: 12px solid transparent; }"});
  const bounds=await groups.evaluateAll(async rows=>{
   await document.fonts.ready;
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const scroller=rows[0].closest('.timeline-scroll');
   const scroll=scroller.getBoundingClientRect();
   const visibleTop=scroller.querySelector('.timeline-head').getBoundingClientRect().bottom;
   const visibleBottom=scroll.top+scroller.clientTop+scroller.clientHeight;
   const boxes=rows.map(row=>row.getBoundingClientRect());
   return {
    first:Math.round(boxes[0].top),
    fullyVisible:boxes.filter(row=>row.top>=visibleTop-0.5 && row.bottom<=visibleBottom+0.5).length,
    borderBottom:scroll.bottom, visibleTop, visibleBottom, scrollTop:scroller.scrollTop,
    lastExpectedBottom:boxes[innerWidth===1280?13:21].bottom,
   };
  });
  assert.ok(bounds.borderBottom-bounds.visibleBottom>=12,JSON.stringify(bounds));
  assert.equal(bounds.first,100,JSON.stringify(bounds));
  assert.equal(bounds.fullyVisible,width===1280?14:22,JSON.stringify(bounds));
  assert.ok(bounds.borderBottom<=height,JSON.stringify(bounds));
 }
 assert.equal(await chart.locator('.timeline-scroll').evaluate(node=>node.scrollWidth>node.clientWidth),true);
 assert.equal(await chart.getByRole('button',{name:'Sign the lease',exact:true}).count(),0);
 await chart.getByRole('button',{name:/Show rows for Example active deal/}).click();
 await chart.getByRole('button',{name:'Sign the lease',exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Month',exact:true}).click();
 assert.equal(await chart.locator('.timeline').getAttribute('data-day-width'),'4');
 await mkdir(new URL('out/test-artifacts/',root),{recursive:true});
 await page.screenshot({path:new URL(`out/test-artifacts/deals-timeline-${width}.png`,root).pathname});
 if(touch) {
  await chart.getByRole('link',{name:/Example active deal with a longer heading/}).click();
  const title=page.getByRole('heading',{name:longDealName});
  await title.waitFor();
  const bounds=await title.evaluate(node=>({height:node.clientHeight,contentHeight:node.scrollHeight,width:node.clientWidth,contentWidth:node.scrollWidth,lineHeight:getComputedStyle(node).lineHeight}));
  assert.ok(bounds.height===bounds.contentHeight && bounds.width===bounds.contentWidth,JSON.stringify(bounds));

 }
 if(width===1280) {
  await picker.selectOption('closed');
  assert.equal(await page.getByRole('button',{name:'Closed deals',exact:true}).getAttribute('aria-pressed'),'true');
 }
});

test('a pointer drag previews and saves an expected to-do date, and Typical lengths uses the measured days',async t=>{
 const {page}=await open(t,{width:1440,height:900});
 const own=[];
 const lengths=[];
 await page.route('**/api/engine/deals/d14/plan-dates',async route=>{
  own.push(route.request().postDataJSON());
  await route.fulfill({json:{base_version:1,previous_on:null}});
 });
 await page.route('**/api/engine/typical-lengths*',async route=>{
  if(route.request().method()==='GET') return route.fulfill({json:{items:[
   {phase:'legal',todo:'review',label:'Review the lease',days:7,base_version:5,measured_days:9,measured_count:5},
  ]}});
  lengths.push(route.request().postDataJSON());
  await route.fulfill({json:{days:9,base_version:6}});
 });
 const tab=await showPlan(page,{canSave:true});
 const grip=tab.getByRole('button',{name:'Change date for Sign the lease'});
 const {x,y,width,height}=await grip.boundingBox();
 await page.mouse.move(x+width/2,y+height/2); await page.mouse.down();
 await page.mouse.move(x+width/2+24,y+height/2);
 await tab.getByText('Mon, Oct 19',{exact:true}).waitFor();
 assert.equal(await tab.locator('.timeline-drag-original').count(),1);
 assert.equal(own.length,0);
 await page.mouse.up();
 await tab.getByText('Sign the lease expected by Oct 19. What follows moved with it.').waitFor();
 assert.deepEqual(own.map(({todo,target_on,base_version})=>[todo,target_on,base_version]),[['sign','2026-10-19',0]]);
 await tab.getByRole('button',{name:'Typical lengths',exact:true}).click();
 await tab.getByRole('button',{name:'Use measured',exact:true}).click();
 await tab.getByText('Review the lease saved.').waitFor();
 assert.deepEqual(lengths.map(({days,base_version})=>[days,base_version]),[[9,5]]);
});
