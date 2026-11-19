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
  assert.equal((await card.textContent()).includes(account.account_client_ref),false);
  assert.deepEqual(writes[1].args, {name:account.account_name,owner:'joe',force_new:true,idempotency_key:writes[1].args.idempotency_key});
  assert.notEqual(writes[0].args.idempotency_key,writes[1].args.idempotency_key);
  await card.click();
  await page.locator('#ownerButton').click();
  await page.getByLabel('Account owner',{exact:true}).selectOption('dell');
  await page.getByRole('button',{name:'Save owner',exact:true}).click();
  await page.locator('#accountContextOwner').getByText('Owned by Dell').waitFor();
  assert.equal(writes[2].path,`/api/engine/national-accounts/${accountId}/owner`);
  assert.deepEqual(writes[2].args, {owner:'dell',base_version:0,idempotency_key:writes[2].args.idempotency_key});
  await page.locator('#accountBack').click();
  await card.getByText('Dell',{exact:true}).waitFor();
});
