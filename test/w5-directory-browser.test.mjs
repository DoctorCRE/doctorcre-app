import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, settles, waitForAsync } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
let server, origin;
before(async()=>{
  server=await fixtureServer();origin=server.origin;
  await mkdir(new URL('../out/test-artifacts/w5',import.meta.url),{recursive:true});
});
after(()=>server?.close());
async function open(t,width=1440){
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000}}), errors=[], overrides=new Map(), calls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-01T18:00:00Z')});await page.route('https://**',r=>r.abort());
  let fail=false;const writes=[];
  await page.route('**/api/v1/business/**',r=>{calls.push(r.request().url());return fail?r.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}):r.fulfill({json:directoryFixture(r.request().url(),{overrides})});});
  await page.route('**/{api/system-work/session,auth/session}',r=>r.fulfill({json:{csrf_token:'synthetic-session',actor:{slug:'joe'}}}));
  await page.route('**/mcp',r=>{
    const {name}=r.request().postDataJSON().params;
    if(name==='update-vendor')writes.push(name);
    const payload=name==='find-and-catch-up'?{state:'not_found',candidates:[]}:{ok:true};
    return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
  });
  return {page,errors,calls,overrides,writes,setFail:value=>{fail=value;}};
}
test('V01 shared directory has neutral loading identity before its module starts', async t => {
  const { page } = await open(t);
  await page.route('**/js/workspace-business.js', route => route.abort());
  await page.goto(`${origin}/vendors`);
  assert.equal(await page.title(), 'Records · DoctorCRE');
  assert.equal(await page.locator('#resultsTitle').textContent(), 'Records');
  assert.equal(await page.locator('.footer').innerText(), 'DoctorCRE · Records');
});
for (const width of [1440, 390]) test(`V01 vendor search destination keeps Vendors identity at ${width}px`, async t => {
  const { page, errors } = await open(t, width);
  await page.goto(`${origin}/search?q=Demo&mode=fixture`);
  await page.getByRole('link', { name: 'Demo Pensacola Buildout Contractors', exact: true }).click();
  await page.waitForURL(/\/vendors\?/);
  await page.waitForFunction(() => document.querySelector('#resultsTitle').textContent === 'Vendors');
  assert.equal(await page.title(), 'Vendors · DoctorCRE');
  assert.equal(await page.locator('#resultsTitle').innerText(), 'Vendors');
  assert.equal(await page.locator('.footer').innerText(), 'DoctorCRE · Vendors');
  const context = await page.evaluate(async () => (await import('/js/doc-context.js')).pageDocContext.snapshot());
  assert.equal(context.page, 'vendors');
  assert.equal(context.label, 'Vendors');
  await page.screenshot({ animations: 'disabled', path: `out/test-artifacts/w5/vendor-search-identity-${width}.png` });

  await page.goto(`${origin}/clients`);
  await page.waitForFunction(() => document.querySelector('#resultsTitle').textContent === 'Clients');
  assert.equal(await page.title(), 'Clients · DoctorCRE');
  assert.equal(await page.locator('#resultsTitle').innerText(), 'Clients');
  assert.equal(await page.locator('.footer').innerText(), 'DoctorCRE · Clients');
  const clientContext = await page.evaluate(async () => (await import('/js/doc-context.js')).pageDocContext.snapshot());
  assert.equal(clientContext.page, 'clients');
  assert.equal(clientContext.label, 'Clients');
  assert.deepEqual(errors, []);
});
for(const width of [1440,390])test(`W5 rendered directories and wide dialog at ${width}px`,async t=>{
  const h=await open(t,width),{page}=h;await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row').catch(async e=>{assert.fail(JSON.stringify({errors:h.errors,body:await page.locator('main').innerText()}));});
  assert.doesNotMatch(await page.locator('.record-row').first().innerText(), /Yours|Proven|Not recorded/);
  assert.equal(await page.locator('#pager').count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Checked a while ago|About this list|source|No filters|read again/i);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({animations:'disabled',path:`out/test-artifacts/w5/vendors-${width}.png`});
  await page.locator('.record-row').first().click();await page.waitForSelector('.relationship-section');
  assert.equal(await page.locator('#recordPanel').getAttribute('role'),'dialog');assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),true);
  const box=await page.locator('#recordPanel').boundingBox();assert.ok(box.width>width*.7);await page.screenshot({animations:'disabled',path:`out/test-artifacts/w5/vendor-overview-${width}.png`});
  const head=await page.locator('#recordTitle').boundingBox();assert.ok(head.y>=box.y && head.y+head.height<box.y+box.height);
  assert.match(await page.locator('#recordBody').innerText(),/Loan programs|Introductions made|Suggested introductions/);
  assert.equal(await page.locator('[data-details-key="intro-demo-intro"] .entry-detail').isVisible(),false);
  await page.locator('[data-details-key="intro-demo-intro"] summary').click();assert.match(await page.locator('[data-details-key="intro-demo-intro"]').innerText(),/Original synthetic introduction entry/);
  await page.locator('[data-details-key="entry-demo-entry"] summary').click();assert.match(await page.locator('[data-details-key="entry-demo-entry"]').innerText(),/Original synthetic email/);
  await page.screenshot({animations:'disabled',path:`out/test-artifacts/w5/vendor-detail-${width}.png`});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#recordPanel').isVisible(),false);assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),false);
  await page.goto(origin+'/clients', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');await page.screenshot({animations:'disabled',path:`out/test-artifacts/w5/clients-${width}.png`});assert.deepEqual(h.errors,[]);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`vendor drawer shows deal-history metrics with no rating at ${width}px in ${theme}`, async t => {
  const h = await open(t, width), { page } = h;
  await page.addInitScript(theme => localStorage.setItem('dealroom-theme', theme), theme);
  h.overrides.set('00000000-0000-4000-8000-000000000001', { tier: 'Trial', reason: 'Synthetic hand-set reason', recorded_by: 'joe', recorded_at: '2026-09-01T12:00:00Z' });
  await page.goto(origin + '/vendors?mode=live', { waitUntil: 'domcontentloaded' });
  await page.locator('.record-row').first().click();
  const record = page.locator('.relationship-section');
  await record.waitFor();
  assert.doesNotMatch(await page.locator('#recordBody').innerText(), /track record|working relationship|Trial|Proven|Established|Unrated|Synthetic hand-set reason|Trust rating|Save rating/);
  assert.equal(await page.locator('#recordBody form, #recordBody select, #recordBody input').count(), 0);
  assert.equal(await record.locator('.relationship-metric').count(), 4);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ animations: 'disabled', path: `out/test-artifacts/w5/vendor-track-record-${width}-${theme}.png` });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.errors, []);
});
test('an old market bookmark opens the vendor list and its drawer', async t => {
  const { page } = await open(t);
  await page.goto(`${origin}/vendors?vendorView=market&vendorMarket=example`);
  await page.waitForFunction(() => document.querySelector('#resultsTitle').textContent === 'Vendors');
  assert.equal(new URL(page.url()).search, '');
  await page.locator('.record-row').first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
});

test('W5 filters, traversal and autonomous refresh recover without losing search',async t=>{
  const h=await open(t),{page}=h;await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');
  await page.locator('[data-owner="dell"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));assert.match(h.calls.at(-1),/owner=dell/);
  await page.locator('#territoryInput').fill('Demo North');await page.locator('#territoryInput').dispatchEvent('change');await page.waitForFunction(()=>location.search.includes('territory=Demo'));
  await page.locator('#sortSelect').selectOption('territory');await page.waitForFunction(()=>location.search.includes('sort=territory'));
  const resetRead=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/business/vendors' && (url.searchParams.get('owner')||'all')==='all' && !url.searchParams.get('territory') && (url.searchParams.get('sort')||'name')==='name' && (url.searchParams.get('page')||'1')==='1';});
  await page.locator('#chipBar [data-chip="all"]').click();await resetRead;
  await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>=25 && document.querySelector('#resultSummary').textContent.startsWith('62 '));
  assert.equal(await page.locator('#territoryInput').inputValue(),'');assert.equal(await page.locator('#sortSelect').inputValue(),'name');
  await page.evaluate(()=>{document.getElementById('appMainSlot').scrollTo(0,1e6);scrollTo(0,1e6);});await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>25);const search=await page.locator('.search-dock').boundingBox(),mainTop=await page.locator('#appMainSlot').evaluate(n=>n.getBoundingClientRect().top);assert.ok(search.y>=mainTop&&search.y<mainTop+16);assert.ok(search.height<60);assert.doesNotMatch(page.url(),/page=/);
  // Scrolling loads the next page only once the search's first page is the list on screen.
  const searchRead=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/business/vendors' && url.searchParams.get('q')==='Demo' && (url.searchParams.get('page')||'1')==='1';});
  await page.locator('#searchInput').fill('Demo');await page.clock.fastForward(400);await searchRead;
  await page.waitForFunction(()=>location.search.includes('q=Demo') && document.querySelectorAll('.record-row').length===25 && document.querySelector('#listRegion').getAttribute('aria-busy')==='false');
  await page.evaluate(()=>{document.getElementById('appMainSlot').scrollTo(0,1e6);scrollTo(0,1e6);});await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>25);
  const count=await page.locator('.record-row').count(), held=[], lastPage=String(Math.ceil(count/25));
  // Keep the final page pending so retained rows cannot masquerade as a settled poll.
  await page.route('**/api/v1/business/vendors?**',r=>{
    const url=new URL(r.request().url());
    return url.searchParams.get('q')==='Demo'&&url.searchParams.get('page')===lastPage?held.push(r):r.fallback();
  });
  await page.clock.fastForward(31000);await settles(()=>assert.equal(held.length,1));
  assert.equal(await page.evaluate(async()=> (await import('/js/doc-context.js')).pageDocContext.snapshot().state),'updating');
  assert.ok(await page.locator('.record-row').count()>=count);assert.equal(await page.locator('#searchInput').inputValue(),'Demo');
  await page.unroute('**/api/v1/business/vendors?**');await held[0].fulfill({json:directoryFixture(held[0].request().url())});
  // Online coalesces with an in-flight poll; start the failure only after that read settles.
  await waitForAsync(page,async()=> (await import('/js/doc-context.js')).pageDocContext.snapshot().state==='ready');
  assert.ok(await page.locator('.record-row').count()>=count);assert.equal(await page.locator('#searchInput').inputValue(),'Demo');
  h.setFail(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.record-empty');h.setFail(false);await page.clock.fastForward(31000);await page.waitForSelector('.record-row');assert.deepEqual(h.errors,[]);
});
test('a new search puts the reader at its first result at once',async t=>{
  const {page}=await open(t);await page.goto(origin+'/vendors?mode=live',{waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');
  const scrollY=await page.evaluate(()=>{
    const main=document.getElementById('appMainSlot');main.scrollTo({top:1500,behavior:'instant'});
    document.querySelector('#searchInput').value='Demo';document.querySelector('#searchInput').form.requestSubmit();
    return scrollY+main.scrollTop;
  });
  assert.equal(scrollY,0);
});
test('W5 reduced motion stops hover travel and pulse while keeping content visible',async t=>{
  const {page}=await open(t);await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/vendors', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');await page.locator('.record-row').first().hover();
  const style=await page.locator('.record-row').first().evaluate(el=>({animation:getComputedStyle(el).animationName,transform:getComputedStyle(el).transform,opacity:getComputedStyle(el).opacity}));assert.deepEqual(style,{animation:'none',transform:'none',opacity:'1'});
  await page.screenshot({animations:'disabled',path:'out/test-artifacts/w5/reduced-motion.png'});
});

test('W5 Clients exposes every requested sort and owner without territory controls',async t=>{
 const {page,calls}=await open(t);await page.goto(origin+'/clients');await page.waitForSelector('.record-row');assert.equal(await page.locator('#territoryField').isVisible(),false);
 for(const sort of ['vertical','name','deal_type','last_deal_desc','last_deal_asc']){await page.locator('#sortSelect').selectOption(sort);await page.waitForFunction(s=>document.querySelector('#sortSelect').value===s,sort);await settles(()=>assert.ok(calls.some(url=>new URL(url).searchParams.get('sort')===sort)||sort==='name'));}
 await page.locator('[data-owner="joe"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));
});

test('W5 keyboard reaches disclosures and keeps focus across a refresh',async t=>{
 const {page}=await open(t);await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.locator('.record-row').first().click();await page.waitForSelector('.relationship-section');
 await page.locator('[data-details-key="intro-demo-intro"] summary').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SUMMARY');
 await page.locator('[data-details-key="entry-demo-entry"] summary').focus();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>document.activeElement.closest('details')?.dataset.detailsKey),'entry-demo-entry');
});
test('W5 Back restores cached query rows while its read is pending',async t=>{
 const {page}=await open(t);await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');await page.locator('[data-owner="joe"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));
 await page.locator('[data-owner="dell"]').click();await page.waitForFunction(()=>document.querySelector('.row-owner')?.textContent.includes('Dell'));
 const held=[];await page.route('**/api/v1/business/vendors?**',r=>new URL(r.request().url()).searchParams.get('owner')==='joe'?held.push(r):r.fallback());
 await page.goBack();await settles(async()=>{assert.equal(await page.locator('[data-owner="joe"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.row-owner').evaluateAll(rows=>rows.every(row=>row.textContent.includes('Joe'))),true);});
 for(const r of held)await r.fulfill({json:directoryFixture(r.request().url())});
});
test('W5 failed continuous page is visible and polling retries without scroll',async t=>{
 const {page}=await open(t);let fail=true;
 await page.route('**/api/v1/business/vendors?**',r=>new URL(r.request().url()).searchParams.get('page')==='2'&&fail?r.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}):r.fallback());
 await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.waitForSelector('.record-row');await page.evaluate(()=>{document.getElementById('appMainSlot').scrollTo(0,1e6);scrollTo(0,1e6);});await page.waitForTimeout(150);
 assert.match(await page.locator('#noticeRegion').innerText(),/Could not load more/);assert.equal(await page.locator('.record-row').count(),25);
 fail=false;await page.clock.fastForward(31000);await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>=50);
});
test('W5 missing original details never displays summary as original',async t=>{
 const {page}=await open(t);await page.route('**/api/v1/business/vendors/*',r=>{const p=directoryFixture(r.request().url());p.record.relationship.recent_entries[0].detail=null;return r.fulfill({json:p});});
 await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.locator('.record-row').first().click();await page.waitForSelector('.relationship-section');assert.equal(await page.locator('[data-details-key="entry-demo-entry"]').count(),0);
});
test('W5 vendor business facts remain visible in the modal',async t=>{
 const {page}=await open(t);await page.route('**/api/v1/business/vendors/*',r=>{const p=directoryFixture(r.request().url());p.record.verticals=['Synthetic specialist vertical'];return r.fulfill({json:p});});
 await page.goto(origin+'/vendors?mode=live', {waitUntil:'domcontentloaded'});await page.locator('.record-row').first().click();await page.waitForSelector('.relationship-section');const body=await page.locator('#recordBody').innerText();for(const value of ['Synthetic specialist vertical','Banking','Warm','Active'])assert.ok(body.includes(value),value);
});
for(const width of [1440,390]) test(`vendor Conversations show newest notes first at ${width}px`,async t=>{
 const h=await open(t,width),{page}=h;
 await page.route('**/api/v1/business/vendors/*',r=>{
  const payload=directoryFixture(r.request().url());
  payload.record.relationship.recent_entries=[
   {id:'undated',kind:'note',when:null,summary:'Synthetic undated conversation',detail:'Synthetic undated original'},
   {id:'earlier',kind:'note',when:'2026-10-01T12:00:00.000001Z',summary:'Synthetic earlier conversation',detail:'Synthetic earlier original'},
   {id:'latest',kind:'note',when:'2026-10-01T07:00:00.000002-05:00',summary:'Synthetic latest conversation',detail:'Synthetic latest original'},
  ];
  return r.fulfill({json:payload});
 });
 await page.goto(origin+'/vendors?mode=live');
 await page.locator('.record-row').first().click();
 const conversations=page.locator('.record-section').filter({has:page.getByRole('heading',{name:'Conversations',exact:true})});
 await conversations.waitFor();
 assert.deepEqual(await conversations.locator('.note-summary').allTextContents(),['Synthetic latest conversation','Synthetic earlier conversation','Synthetic undated conversation']);
 await conversations.locator('[data-details-key="entry-latest"] summary').click();
 assert.equal(await conversations.locator('.entry-detail').first().textContent(),'Synthetic latest original');
 assert.equal(await conversations.locator('li').last().locator('time').count(),0);
 assert.equal(await conversations.locator('time').count(),2);
 assert.deepEqual(h.writes,[]);
 assert.deepEqual(h.errors,[]);
});

for(const kind of ['introduced','can_introduce']) test(`vendor ${kind} notes show dated introductions newest first`,async t=>{
 const h=await open(t),{page}=h;
 await page.route('**/api/v1/business/vendors/*',r=>{
  const payload=directoryFixture(r.request().url());
  payload.record.relationship.introductions=[
   {id:'undated',occurred_at:null,note:'Synthetic undated introduction'},
   {id:'earlier',occurred_at:'2026-09-20',note:'Synthetic earlier introduction'},
   {id:'latest',occurred_at:'2026-09-29',note:'Synthetic latest introduction'},
  ].map(item=>({...item,kind,from_name:'Demo Partner',to_name:'Demo Practice',via_party:null}));
  return r.fulfill({json:payload});
 });
 await page.goto(origin+'/vendors?mode=live');
 await page.locator('.record-row').first().click();
 const network=page.locator('.network-grid');
 await network.waitFor();
 assert.deepEqual(await network.locator('.note-summary').allTextContents(),['Synthetic latest introduction','Synthetic earlier introduction','Synthetic undated introduction']);
 assert.equal(await network.locator('[data-details-key="intro-latest"] .entry-detail').textContent(),'Synthetic latest introduction');
 assert.deepEqual(h.writes,[]);
 assert.deepEqual(h.errors,[]);
});
for(const dataset of ['clients','vendors']) test(`${dataset} record panel shows no deal evidence block`,async t=>{
 const {page,errors}=await open(t);await page.goto(`${origin}/${dataset}`);await page.locator('.record-row').first().click();
 await page.waitForFunction(()=>{const text=document.querySelector('#recordBody')?.textContent.trim();return text&&!/loading/i.test(text);});
 assert.equal(await page.locator('#recordBody .correspondence-evidence').count(),0);
 assert.doesNotMatch(await page.locator('#recordBody').innerText(),/Email threads|Meetings unavailable|Refresh deal|Retry evidence/);
 assert.deepEqual(errors,[]);
});

for(const dataset of ['clients','vendors']) test(`${dataset} record panel labels the owner`,async t=>{
 const {page,errors}=await open(t);await page.goto(`${origin}/${dataset}`);await page.locator('.record-row').first().click();
 const tone=page.locator('#recordPanel .record-tone').filter({hasText:'Owner'});await tone.waitFor();
 assert.match(await tone.innerText(),/Owner\s+Joe/);
 const [owner,fact]=await page.evaluate(()=>['#recordPanel .record-tone .fact-label','#recordBody .record-field dt'].map(selector=>getComputedStyle(document.querySelector(selector)).color));
 assert.equal(owner,fact,'the label reads like the other facts');
 assert.deepEqual(errors,[]);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Clients show recorded facts and open activity at ${width}px in ${theme}`, async t => {
    const { page, errors } = await open(t, width);
    await page.addInitScript(theme => localStorage.setItem("dealroom-theme", theme), theme);
    const id = '00000000-0000-4000-8000-000000000001';
    const deal = { id: '00000000-0000-4000-8000-000000000071', name: 'Demo expansion' };
    const url = '/deals?deal=' + deal.id;
    const note = 'The practice is reviewing three possible spaces. '.repeat(12) + 'The last sentence stays whole. (Notes/Demo.md)';
    const contracts = [];
    await page.route('**/api/v1/business/clients**', async route => {
      contracts.push(new URL(route.request().url()).searchParams.get("contract"));
      const json = directoryFixture(route.request().url());
      if (json.record?.id === id) Object.assign(json.record, {
        active_deals: [deal], acquisition_source: 'cold_outreach', phone: '+12025550101 x45',
        cell: '+442079460123', notes: note,
      });
      if (json.record?.name === 'Demo Practice 02') Object.assign(json.record, {
        name: '1234', vertical: '12345; Demo City', city: 'FL', notes: '202-555-0100',
        acquisition_source: 'not_recorded',
        acquisition_detail: 'Existing active Salesforce opportunity imported; original acquisition source unavailable.',
      });
      if (json.rows) {
        Object.assign(json.rows[0], { active_deals: [deal] });
        Object.assign(json.rows[1], { name: '1234', recorded_status_active_pipeline: false,
          vertical: '12345; Demo City', city: 'FL', state: null, deal_type: null });
      }
      await route.fulfill({ json });
    });
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      if (name !== 'find-and-catch-up') return route.fallback();
      const entries = [
        { verb: 'email', email_subject: 'Lease update', summary: 'Email to demo@example.test: Lease update', deal_id: deal.id, detail: 'The updated lease is ready.' },
        { verb: 'email', summary: 'Email from demo@example.test: (no subject)', detail: 'The saved email body.' },
        { verb: 'call', summary: 'Called about timing', actor: 'agent' },
        { verb: 'note', summary: 'Earlier note' },
      ];
      await route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({
        state: 'completed', match: { target: args.ref },
        catch_up: { timeline: entries.reverse().map((entry, index) => ({
          entry_kind: 'activity', occurred_at: `2026-09-2${index}T15:00:00Z`, actor: 'old_system', ...entry,
        })) },
      }) }] } } });
    });
    await page.goto(origin + '/clients?mode=live');
    await page.waitForSelector('.record-row');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.getByRole('link', { name: deal.name, exact: true }).getAttribute('href'), url);
    assert.match(await page.locator('.record-row').first().innerText(), /Territory/);
    assert.doesNotMatch(await page.locator('#listRegion').innerText(), /Not in the active pipeline|Not recorded:/);
    await page.screenshot({ animations: 'disabled', path: `out/test-artifacts/w5/clients-list-${width}-${theme}.png` });
    await page.locator('.record-row').first().click();
    const panel = page.getByRole('dialog', { name: /Demo Practice 01/ });
    assert.equal(await panel.getByRole('link', { name: deal.name, exact: true }).getAttribute('href'), url);
    assert.match(await panel.innerText(), /How found\s+Cold outreach/);
    assert.match(await panel.innerText(), /\(202\) 555-0101 x45/);
    assert.match(await panel.innerText(), /\+442079460123/);
    assert.equal(await panel.getByText('Details', { exact: true }).count(), 1);
    assert.doesNotMatch(await panel.innerText(), /Notes\/Demo\.md/);
    await page.screenshot({ animations: 'disabled', path: `out/test-artifacts/w5/clients-drawer-${width}-${theme}.png` });
    await panel.getByText('More', { exact: true }).click();
    assert.match(await panel.innerText(), /The last sentence stays whole\./);
    const activity = panel.getByRole('region', { name: 'Recent activity' });
    const linkedEmail = activity.getByRole('listitem').filter({ hasText: 'Email · Lease update' });
    assert.equal(await linkedEmail.getByRole('link', { name: 'Email · Lease update' }).getAttribute('href'), url);
    assert.equal(await linkedEmail.getByText('The updated lease is ready.').isVisible(), false);
    const readEmail = linkedEmail.getByText('Read email', { exact: true });
    assert.equal(await readEmail.isVisible(), true);
    await readEmail.click();
    assert.equal(await linkedEmail.getByText('The updated lease is ready.').isVisible(), true);
    const recent = await activity.innerText();
    assert.doesNotMatch(recent, /demo@example\.test|old_system|· agent|\(no subject\)/);
    assert.match(recent, /Copied from the old system/);
    assert.match(recent, /Written by the assistant/);
    assert.equal(await activity.getByText('Earlier note').isVisible(), false);
    assert.equal(await activity.getByText('The saved email body.').isVisible(), false);
    await activity.getByText('Email without a subject', { exact: true }).click();
    assert.equal(await activity.getByText('The saved email body.').isVisible(), true);
    await activity.getByText('Show all', { exact: true }).click();
    assert.equal(await activity.getByText('Earlier note').isVisible(), true);
    await page.screenshot({ animations: 'disabled', path: `out/test-artifacts/w5/clients-activity-${width}-${theme}.png` });
    await panel.getByRole('button', { name: 'Close record', exact: true }).click();
    await page.getByRole('link', { name: /^1234/ }).click();
    const unchanged = page.getByRole('dialog', { name: '1234', exact: true });
    await unchanged.getByText('Imported from Salesforce. Original source not recorded.').waitFor();
    assert.match(await unchanged.innerText(), /How found\s+Not recorded/);
    assert.match(await unchanged.innerText(), /12345; Demo City/);
    assert.match(await unchanged.innerText(), /202-555-0100/);
    assert.equal(await unchanged.getByRole('link', { name: deal.name, exact: true }).count(), 0);
    assert.ok(contracts.length >= 3 && contracts.every(value => value === 'vendor-directory.v2'));
    await unchanged.getByRole('button', { name: 'Close record', exact: true }).click();
    await Promise.all([page.waitForURL('**' + url), page.getByRole('link', { name: deal.name, exact: true }).click()]);
    assert.deepEqual(errors, []);
  });
}

for (const width of [390, 1440]) test(`vendor conversation provenance is hidden at ${width}px`, async t => {
 const {page, errors} = await open(t, width);
 await page.route('**/api/v1/business/vendors/*', r => {
  const payload = directoryFixture(r.request().url());
  payload.record.relationship.recent_entries = [{id:'plain', kind:'note', when:'2026-03-02T12:00:00Z', summary:"Met Alex — recovered from Alex's CARR calendar history", detail:"Met Alex — recovered from Alex's CARR calendar history\n\nMarch 2, 2026 from the historical CARR calendar read"}];
  return r.fulfill({json:payload});
 });
 await page.goto(origin+'/vendors?mode=live');
 await page.locator('.record-row').first().click();
 const conversation = page.locator('[data-details-key="entry-plain"]');
 await conversation.locator('summary').click();
 assert.equal(await conversation.locator('.entry-detail').innerText(), 'Met Alex');
 assert.equal(await conversation.locator('..').locator('.note-summary').innerText(), 'Met Alex');
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 await page.screenshot({animations:'disabled', path:`out/test-artifacts/w5/vendor-plain-conversation-${width}.png`});
 assert.deepEqual(errors, []);
});

for (const width of [390, 1440]) for (const tall of [false, true]) test(`vendor keyboard traversal stays visible at ${width}px, tall dock ${tall}`, async t => {
  const { page } = await open(t, width);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const recording = JSON.parse(await readFile(new URL('./fixtures/vendor-meetings/recordings.json', import.meta.url), 'utf8'));
  await page.route('**/mcp', r => r.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(recording.research) }] } } }));
  await page.goto(origin + '/vendors?mode=live');
  await page.locator('.record-row').first().waitFor();
  await page.evaluate(() => { document.getElementById('appMainSlot').scrollTo(0, 1e6); scrollTo(0, 1e6); });
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length >= 50);
  await page.evaluate(() => { document.getElementById('appMainSlot').scrollTo(0, 1e6); scrollTo(0, 1e6); });
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 62);
  if (tall) await page.locator('.search-dock').evaluate(el => { el.style.paddingBottom = '160px'; });
  await page.clock.fastForward(50);
  await page.waitForFunction(() => {
    const dock = document.querySelector('.search-dock');
    return parseFloat(document.documentElement.style.getPropertyValue('--search-dock-height')) === dock.getBoundingClientRect().height;
  });
  await page.locator('#searchInput').focus();
  const seen = new Set();
  for (let i = 0; i < 180; i++) {
    await page.keyboard.press(i < 90 ? 'Tab' : 'Shift+Tab');
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el.matches('.record-row')) return null;
      const rect = el.getBoundingClientRect(), dock = document.querySelector('.search-dock').getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { id: el.id || el.outerHTML, top: rect.top, bottom: rect.bottom, dockBottom: dock.bottom, height: innerHeight, hit: el === hit || el.contains(hit) };
    });
    if (!state) continue;
    seen.add(state.id);
    assert.ok(state.top >= state.dockBottom && state.bottom <= state.height && state.hit, JSON.stringify(state));
  }
  const expected = await page.locator('.record-row').evaluateAll(els => els.map(el => el.id || el.outerHTML));
  assert.equal(expected.length, 62);
  for (const id of expected) assert.ok(seen.has(id), `keyboard did not reach ${id}`);
  await page.locator('#searchInput').fill('Demo Partner 02');
  await page.clock.fastForward(400);
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 1);
  await page.locator('.record-row').click();
  await page.getByRole('dialog', { name: 'Demo Partner 02' }).waitFor();
});

test('session invalidation disconnects the search dock observer', async t => {
  const { page } = await open(t);
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      observe(target, options) {
        if (target.matches('.search-dock')) window.searchDockObserver = this;
        return super.observe(target, options);
      }
      disconnect() {
        if (this === window.searchDockObserver) window.searchDockDisconnected = true;
        return super.disconnect();
      }
    };
  });
  await page.goto(origin + '/vendors?mode=live');
  await page.waitForFunction(() => window.searchDockObserver);
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.evaluate(() => window.searchDockDisconnected), true);
});

test('Clients can retry unavailable activity and retain keyboard focus', async t => {
  const { page } = await open(t, 390);
  const requests = [], release = Promise.withResolvers(), started = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (name !== 'find-and-catch-up') return route.fallback();
    requests.push(args.ref);
    if (requests.length === 2) { started.resolve(); await release.promise; }
    if (requests.length <= 2) return route.fulfill({ status: 503, body: 'Unavailable' });
    return route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({
      state: 'completed', match: { target: args.ref }, catch_up: { timeline: [{ entry_kind: 'activity', verb: 'note', summary: 'Recovered history', occurred_at: '2026-09-20T15:00:00Z' }] },
    }) }] } } });
  });
  await page.goto(origin + '/clients?mode=live');
  await page.locator('.record-row').first().click();
  const panel = page.getByRole('dialog', { name: /Demo Practice 01/ });
  const activity = panel.getByRole('region', { name: 'Recent activity' });
  await activity.locator('[data-state="unavailable"]').waitFor();
  assert.equal(await activity.locator('[data-state="unavailable"]').isVisible(), true, 'Activity is unavailable');
  const retry = activity.getByRole('button', { name: 'Retry' });
  assert.equal(await retry.isVisible(), true, 'Unavailable activity offers a visible Retry button');
  await retry.focus();
  await page.keyboard.press('Enter');
  await started.promise;
  assert.equal(await activity.evaluate(el => el.contains(document.activeElement)), true);
  release.resolve();
  await retry.waitFor();
  assert.equal(await retry.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await activity.getByText('Recovered history').waitFor();
  assert.equal(await panel.isVisible(), true);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
});

test('A late activity retry cannot paint another client', async t => {
  const { page } = await open(t);
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  t.after(() => pending.resolve());
  await page.route(/workspace-business\.js/, async route => {
    const response = await route.fetch();
    const original = await readFile(new URL('../js/workspace-business.js', import.meta.url), 'utf8');
    const source = original.replace('const settle = (result) => {', 'const settle = (result) => { window.activitySettles = (window.activitySettles || 0) + 1;');
    await route.fulfill({ response, body: source });
  });
  let reads = 0;
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (name !== 'find-and-catch-up') return route.fallback();
    const read = ++reads;
    if (read === 1) return route.fulfill({ status: 503, body: 'Unavailable' });
    if (read === 2) { started.resolve(); await pending.promise; }
    return route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({
      state: 'completed', match: { target: args.ref }, catch_up: { timeline: [{ entry_kind: 'activity', verb: 'note', summary: read === 2 ? 'Earlier client history' : 'Current client history', occurred_at: '2026-09-20T15:00:00Z' }] },
    }) }] } } });
  });
  await page.goto(origin + '/clients?mode=live');
  await page.locator('.record-row').first().click();
  const activity = page.getByRole('dialog', { name: /Demo Practice 01/ }).getByRole('region', { name: 'Recent activity' });
  await activity.locator('[data-state="unavailable"]').waitFor();
  assert.equal(await activity.locator('[data-state="unavailable"]').isVisible(), true, 'Activity is unavailable');
  const retry = activity.getByRole('button', { name: 'Retry' });
  assert.equal(await retry.isVisible(), true, 'Unavailable activity offers a visible Retry button');
  await retry.click();
  await started.promise;
  await page.keyboard.press('Escape');
  await page.locator('.record-row').nth(1).click();
  const second = page.getByRole('dialog', { name: /Demo Practice 02/ });
  await second.getByText('Current client history').waitFor();
  pending.resolve();
  await page.waitForFunction(() => window.activitySettles >= 3);
  assert.equal(await second.isVisible(), true);
  assert.equal(await second.getByText('Earlier client history').count(), 0);
  assert.equal(await second.getByText('Current client history').count(), 1);
});
