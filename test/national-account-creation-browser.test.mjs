import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { handleDoctorcreRequest } from "../src/worker.js";

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`national creation reviews duplicate candidates and existing sub-clients at ${width}px in ${theme}`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:900},colorScheme:theme});
  // Keep board reads synthetic; exercise the real live writer at the form seam.
  const source = await readFile(new URL('../js/client.js',import.meta.url),'utf8');
  await page.route('**/js/client.js', route => route.fulfill({contentType:'text/javascript',body:`${source}
    const fixtureCreateClient = createClient;
    createClient = async (...args) => {
      const client = await fixtureCreateClient(...args);
      const {createLiveClient} = await import('./live-client.js');
      const live = createLiveClient({docContext:false});
      client.createNationalAccount = live.createNationalAccount;
      client.createNationalMarketDeal = live.createNationalMarketDeal;
      return client;
    };`}));
  const sent = [], errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
  await page.route('**/api/**',route => route.fulfill({json:{}}));
  await page.route('**/mcp',async route => {
    const {name,arguments:args} = route.request().postDataJSON().params;
    sent.push({name,args});
    const payload = name === 'create-national-account'
      ? args.force_new ? {ok:true,account_client_id:'demo-created-account'}
        : {needs_confirm:true,candidates:[{id:'demo-existing-org',name:'Demo Existing Brand'}]}
      : args.client_name === 'Demo Existing' ? {ok:true,deal_id:'demo-created-deal',account_client_id:args.account_client_id}
        : {ok:false,error:'research_evidence_required'};
    await route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
  });
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().waitFor();
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  if (!await page.locator('#stickyAddButton').isVisible()) await page.getByRole('button',{name:'Workspace sidebar',exact:true}).click();
  await page.locator('#stickyAddButton').click();
  await page.locator('#accountName').fill('Demo Separate Brand');
  await page.locator('#dialogSubmit').click();
  assert.equal(sent.length,0,'native validation blocks absent research');
  for (const field of ['name','company','phone','specialty','market']) await page.locator(`[name="research_${field}"]`).fill(`https://example.com/demo/${field}`);
  await page.locator('[name="research_observed_at"]').fill('2026-10-22T10:00');
  await page.locator('#dialogSubmit').click();
  await page.getByText('Demo Existing Brand (demo-existing-org)').waitFor();
  assert.equal(await page.locator('#dialogSubmit').textContent(),'Create separate brand');
  assert.equal(await page.locator('#formDialog').isVisible(),true);
  await page.locator('#dialogSubmit').click(); assert.equal(sent.length,1);
  await page.locator('[name="confirm_separate"]').check();
  await page.locator('#dialogSubmit').click();
  await page.locator('#formDialog').waitFor({state:'hidden'});
  assert.equal(sent[1].args.force_new,true);
  assert.notEqual(sent[1].args.idempotency_key,sent[0].args.idempotency_key);
  assert.deepEqual(sent[1].args.research_evidence,sent[0].args.research_evidence);

  await page.keyboard.press('Escape');
  await page.locator('.account-card').first().click();
  if (!await page.locator('#stickyAddButton').isVisible()) await page.getByRole('button',{name:'Workspace sidebar',exact:true}).click();
  await page.locator('#stickyAddButton').click();
  await page.locator('#marketClientMode').selectOption('existing');
  assert.equal(await page.locator('#marketResearch').isVisible(),false);
  await page.locator('#marketClient').fill('Demo Unmatched');
  await page.locator('#marketDealName').fill('Demo Market Transaction');
  await page.locator('#marketCity').fill('Demo City');
  await page.locator('#dialogSubmit').click();
  await page.locator('#formError').waitFor();
  assert.match(await page.locator('#formError').textContent(),/Research evidence is required/);
  assert.equal(await page.locator('#formDialog').isVisible(),true);
  await page.locator('#marketClient').fill('Demo Existing');
  await page.locator('#dialogSubmit').click();
  await page.locator('#formDialog').waitFor({state:'hidden'});
  assert.equal(Object.hasOwn(sent.at(-1).args,'research_evidence'),false);
  assert.equal(Object.hasOwn(sent.at(-1).args,'client_mode'),false);
  assert.deepEqual(errors,[]);
});

test('engine-backed national accounts confirm separate companies and save owner changes', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const accountId = '00000000-0000-4000-8000-000000000021';
  const account = {account_client_id:accountId, account_name:'Demo Separate Company',
    account_client_ref:'C-999999', account_owner:'joe', base_version:0, open_deals:0, overdue_deals:0, parked_deals:0};
  const accounts = [], writes = [];
  let ownerAttempts = 0;
  const env = {ENGINE_ROUTING:{get:async () => 'on'}, ENGINE:{fetch:async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/engine/deals')
      return Response.json({schema_version:'local-deals-board.v2',actor:'joe',deals:[],accounts});
    const args = await request.json();
    writes.push({path,args});
    if (path === '/api/engine/national-accounts') {
      if (!args.force_new) return Response.json({error:'account_name_exists',candidates:[{id:'demo-company',name:account.account_name}]}, {status:409});
      accounts.push(account);
    } else {
      if (++ownerAttempts === 1)
        return Response.json({error:'invalid_field_value',fields:['owner']}, {status:422});
      account.account_owner = args.owner;
      account.base_version++;
    }
    return Response.json({account_client_id:accountId,owner:account.account_owner});
  }}};
  await page.route('**/auth/session', route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
  await page.route('**/api/**', route => route.fulfill({json:{}}));
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board','create-national-account','set-national-account-owner'].includes(request.postDataJSON().params.name))
      return route.fulfill({json:{result:{content:[{type:'text',text:'{}'}]}}});
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method:'POST', headers:await request.allHeaders(), body:request.postData(),
    }), env);
    return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
  });

  await page.goto(`${server.origin}/deals?view=national&mode=live`);
  await page.getByText(/No national accounts yet/).waitFor();
  await page.getByRole('button',{name:'Add national account',exact:true}).click();
  await page.getByLabel('Company name',{exact:true}).fill(account.account_name);
  await page.getByLabel('Account owner',{exact:true}).selectOption('joe');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByText('A company with this name already exists.',{exact:false}).waitFor();
  assert.equal(await page.getByText('demo-company',{exact:false}).count(),0);
  assert.equal(writes.length,1);
  await page.getByRole('checkbox',{name:/separate company/}).check();
  await page.getByRole('button',{name:'Create separate company',exact:true}).click();

  const card = page.getByRole('button',{name:/Demo Separate Company.*Open account/});
  await card.waitFor();
  assert.equal(await card.count(),1);
  await card.getByText('Deals late',{exact:true}).waitFor();
  assert.equal((await card.textContent()).includes(account.account_client_ref),false);
  assert.deepEqual(writes[1].args, {name:account.account_name,owner:'joe',force_new:true,idempotency_key:writes[1].args.idempotency_key});
  assert.notEqual(writes[0].args.idempotency_key,writes[1].args.idempotency_key);
  await card.click();
  await page.locator('#ownerButton').click();
  await page.getByLabel('Account owner',{exact:true}).selectOption('dell');
  const saveOwner = page.getByRole('button',{name:'Save owner',exact:true});
  await saveOwner.click();
  const refusal = page.locator('#formError');
  await refusal.waitFor();
  assert.equal(await refusal.textContent(),'Choose Joe or Dell as the owner.');
  await saveOwner.click();
  await page.locator('#accountContextOwner').getByText('Owned by Dell').waitFor();
  const savedOwner = writes.at(-1);
  assert.equal(savedOwner.path,`/api/engine/national-accounts/${accountId}/owner`);
  assert.deepEqual(savedOwner.args, {owner:'dell',base_version:0,idempotency_key:savedOwner.args.idempotency_key});
  await page.locator('#accountBack').click();
  await card.getByText('Dell',{exact:true}).waitFor();
});

test('engine-backed market deals use account locations and an optional existing agent', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const [account, market, location, agent] = [1, 2, 3, 4].map(id);
  const deals = [], writes = [];
  let marketReadFailed = false;
  const env = {ENGINE_ROUTING:{get:async () => 'on'}, ENGINE:{fetch:async request => {
    const {pathname,search} = new URL(request.url);
    if (pathname === '/api/engine/deals' && request.method === 'GET')
      return Response.json({schema_version:'local-deals-board.v2',actor:'joe',deals,
        accounts:[{account_client_id:account,account_name:'Demo National Company',account_owner:'joe',open_deals:deals.length}]});
    if (pathname === '/api/engine/markets') {
      if (!marketReadFailed) {
        marketReadFailed = true;
        return new Response(null, {status:503});
      }
      return Response.json([{market_id:market,name:'Demo Metro'}]);
    }
    if (pathname === `/api/engine/national-accounts/${account}/locations`)
      return Response.json([{party_id:location,name:'Demo Existing Location',kind:'person'}]);
    if (pathname === '/api/engine/parties/search') {
      assert.equal(search,'?kind=person&query=Demo+Agent');
      return Response.json({ok:true,schema_version:'party-search.v1',parties:[{id:agent,display_name:'Demo Agent',kind:'person'}]});
    }
    if (pathname.startsWith('/api/engine/deals/')) {
      const row = deals.find(deal => pathname.endsWith(deal.id));
      return Response.json({...row,deal_id:row.id,actor:'joe'});
    }
    assert.equal(pathname,'/api/engine/deals');
    const args = await request.json();
    const prior = writes.find(write => write.idempotency_key === args.idempotency_key);
    writes.push(args);
    if (prior) return Response.json({deal_id:deals[0].id,change_id:24,replayed:true});
    if (!args.client_id && args.new_location.name === 'Demo Existing Location')
      return Response.json({error:'location_name_exists'}, {status:409});
    const dealId = id(10 + writes.length);
    deals.push({id:dealId,name:args.name,phase:'pending',owner:'joe',account_client_id:account,
      market:'Demo Metro',market_agent:args.market_agent_id ? 'Demo Agent' : null});
    if (writes.length === 1) return new Response(null,{status:503});
    return Response.json({deal_id:dealId,change_id:24}, {status:201});
  }}};
  const marketReads = /\/api\/engine\/(markets|national-accounts\/[^/]+\/locations)$/;
  await page.route('**/auth/session', route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
  await page.route('**/api/**', route => route.fulfill({json:{}}));
  const answerThroughWorker = async route => {
    const request = route.request();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postData(),
    }), env);
    return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
  };
  await page.route('**/deals?deal=*', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('mode')) return route.continue();
    url.searchParams.set('mode','live');
    return route.fulfill({status:302,headers:{location:url.href}});
  });
  await page.route(marketReads, answerThroughWorker);
  await page.route('**/mcp', async route => {
    if (['deal-room-board','get-deal-room','create-national-market-deal','search-parties-v1'].includes(route.request().postDataJSON().params.name))
      return answerThroughWorker(route);
    return route.fulfill({json:{result:{content:[{type:'text',text:'{}'}]}}});
  });

  await page.goto(`${server.origin}/deals?view=national&mode=live`);
  await page.getByRole('button',{name:/Demo National Company.*Open account/}).click();
  const open = page.getByRole('button',{name:'Add market deal',exact:true});
  const submit = page.getByRole('button',{name:'Create market deal',exact:true});
  const chooseMarket = page.getByLabel('Market',{exact:true});
  await open.click();
  await page.getByLabel('Deal name',{exact:true}).fill('Demo First Market Deal');
  await page.getByRole('button',{name:'Reload choices',exact:true}).click();
  await chooseMarket.selectOption({label:'Demo Metro'});
  await page.getByLabel('Existing location',{exact:true}).selectOption({label:'Demo Existing Location'});
  await page.getByLabel('Search people',{exact:true}).fill('Demo Agent');
  await page.getByRole('button',{name:'Find people',exact:true}).click();
  await page.getByLabel('Market agent (optional)',{exact:true}).selectOption({label:'Demo Agent'});
  await submit.click();
  await page.getByRole('button',{name:'Check creation outcome',exact:true}).click();
  const first = page.locator('#rows').getByRole('button',{name:'Demo First Market Deal',exact:true});
  await first.waitFor();
  assert.equal(await first.count(),1);
  assert.deepEqual(writes[1],writes[0]);
  assert.match(await page.locator('#rows').textContent(),/Demo Metro.*Demo Agent/s);
  assert.deepEqual(writes[0], {idempotency_key:writes[0].idempotency_key,name:'Demo First Market Deal',
    national_account_id:account,market_id:market,client_id:location,market_agent_id:agent,
    owner:'joe',phase:'pending',reason:'start_up'});
  await first.click();
  await page.getByRole('heading',{name:'Demo First Market Deal',exact:true}).waitFor();
  await page.goto(`${server.origin}/deals?view=national&mode=live`);
  await page.getByRole('button',{name:/Demo National Company.*Open account/}).click();

  await open.click();
  await chooseMarket.selectOption({label:'Demo Metro'});
  await page.getByLabel('Deal name',{exact:true}).fill('Demo Second Market Deal');
  await page.getByLabel('Location',{exact:true}).selectOption({label:'New location'});
  await page.getByLabel('Location type',{exact:true}).selectOption({label:'Company'});
  await page.getByLabel('Name',{exact:true}).fill('Demo Existing Location');
  await submit.click();
  await page.getByText('Choose the existing location with that name.',{exact:true}).waitFor();
  await page.getByLabel('Name',{exact:true}).fill('Demo New Location');
  await submit.click();
  await page.locator('#rows').getByRole('button',{name:'Demo Second Market Deal',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1), {idempotency_key:writes.at(-1).idempotency_key,name:'Demo Second Market Deal',
    national_account_id:account,market_id:market,new_location:{name:'Demo New Location',kind:'company'},
    owner:'joe',phase:'pending',reason:'start_up'});

  await open.click();
  await chooseMarket.selectOption({label:'Demo Metro'});
  await page.getByLabel('Deal name',{exact:true}).fill('Demo Third Market Deal');
  await page.getByLabel('Location',{exact:true}).selectOption({label:'New location'});
  await page.getByLabel('Location type',{exact:true}).selectOption({label:'Person'});
  await page.getByLabel('Name',{exact:true}).fill('Demo New Person');
  await submit.click();
  await page.locator('#rows').getByRole('button',{name:'Demo Third Market Deal',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1).new_location, {name:'Demo New Person',kind:'person'});
  assert.notEqual(writes.at(-2).idempotency_key,writes.at(-1).idempotency_key);
  await page.locator('#accountBack').click();
  await page.getByRole('button',{name:/Demo National Company.*3 Open deals/}).waitFor();
});
