import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'out/test-artifacts/dealroom-acceptance');
let outDir, server, browser, origin;
before(async () => {
  outDir = await temporaryDirectory('dealroom-acceptance-');
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  server = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  origin = server.origin;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await server.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`signed-in deal room preserves board rows and unobstructed titles at ${width}px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const seeded = await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `dealroom-${width}-${theme}`, viewer: 'joe', reset: true } });
  assert.equal(seeded.status(), 200);
  const response = await page.request.post(`${origin}/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deal-room-board', arguments: {} } } });
  const envelope = await response.json();
  const board = JSON.parse(envelope.result.content[0].text);
  assert.equal(board.schema_version, 'local-deals-board.v2');
  assert.equal(board.actor, 'joe');
  assert.equal(board.deals.length, 16);
  assert.deepEqual(board.closed_deals, []);
  assert.deepEqual(board.lost_deals, []);
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  const ids = await page.locator('.kanban-column .kanban-card').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  assert.deepEqual(ids, board.deals.map(deal => deal.id).sort());
  assert.equal(await page.locator('.kanban-column').count(), 7);
  assert.equal(await page.locator('[data-column="closed"]').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Nothing needs you/i);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, `${width}-${theme}-board.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Dell', exact: true }).click();
  const dellIds = await page.locator('.kanban-column .kanban-card').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  assert.deepEqual(dellIds, board.deals.filter(deal => deal.owner === 'dell').map(deal => deal.id).sort());
  await page.locator('.card-open').first().click();
  await page.locator('#detailUpdateForm').waitFor();
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('#dealUpdate').getAttribute('placeholder'), null);
  assert.equal(await page.locator('[aria-label="Deal phases and timeline"]').count(), 1);
  assert.equal(await page.locator('.timeline-chart').count(), 0);
  assert.equal(await page.locator('#detailOwner').inputValue(), 'dell');
  assert.equal(await page.locator('.deal-updates').count(), 0, 'the signed-in empty note feed renders no section');
  assert.equal(await page.locator('#recordPanel').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: join(evidence, `${width}-${theme}-snapshot.png`), animations: 'disabled' });
  const header = await page.locator('#recordPanel > header').evaluate(node => ({
    stackHeight: node.getBoundingClientRect().bottom - node.parentElement.getBoundingClientRect().top,
    titleFontSize: parseFloat(getComputedStyle(node.querySelector('h1')).fontSize),
    paddingTop: parseFloat(getComputedStyle(node).paddingTop),
  }));
  assert.ok(header.stackHeight < 360, 'persistent header leaves room for workspace content');
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.evaluate(async()=>{
    const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;
    state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,vendors:Array.from({length:6},(_,i)=>({party_id:`demo-vendor-${i}`,role:i<3?'lender':'landlord_rep',company:{id:`demo-company-${i}`,name:`Demo regional healthcare property and finance company ${i}`},contact:{id:`demo-contact-${i}`,name:`Demo assigned representative number ${i}`}}))},thread:Array.from({length:30},(_,i)=>({id:`demo-${i}`,kind:'note',actor:'joe',text:`Demo update ${i}. `+'Synthetic context. '.repeat(20),recorded_at:new Date(Date.UTC(2026,9,20,12,0,i)).toISOString()}))};};
  });
  await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
  await page.locator('.updates-history > summary').waitFor();
  assert.equal(await page.locator('#recordPanel .deal-vendor-company').count(),6);
  const action=await page.getByRole('button',{name:'Add update',exact:true}).boundingBox();
  const panel=await page.locator('#recordPanel').boundingBox();
  assert.ok(action.y+action.height<=panel.y+panel.height,JSON.stringify({action,panel}));
  await page.screenshot({path:join(evidence,`${width}-${theme}-six-vendors.png`),animations:'disabled'});
  await page.locator('.deal-updates').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,`${width}-${theme}-summary.png`),animations:'disabled'});
  await page.locator('.updates-history > summary').click();
  await page.evaluate(() => scrollTo(0,220));
  await page.screenshot({ path: join(evidence, `${width}-${theme}-scrolled.png`), animations: 'disabled' });
  const titleHitTest = await page.locator('#panelTitle').evaluate(title => {
    const orb = document.querySelector('#recordPanel .doc-presence').getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const hits = [...range.getClientRects()].flatMap(rect => [rect.left + 1, (rect.left + rect.right) / 2, rect.right - 1].map(x => {
      const hit = document.elementFromPoint(x, (rect.top + rect.bottom) / 2);
      return {x, visible: hit === title || title.contains(hit)};
    }));
    return {scrollTop: scrollY, orb: orb.toJSON(), text: text.toJSON(), hits,
      overlaps: orb.left < text.right && orb.right > text.left && orb.top < text.bottom && orb.bottom > text.top};
  });
  await writeFile(join(evidence, `${width}-${theme}-hit-test.json`), JSON.stringify({...titleHitTest, header}, null, 2));
  assert.ok(titleHitTest.scrollTop > 100, 'exercise the sticky header after scrolling');
  assert.equal(titleHitTest.overlaps, false, JSON.stringify(titleHitTest));
  assert.ok(titleHitTest.hits.length > 0 && titleHitTest.hits.every(hit => hit.visible), JSON.stringify(titleHitTest));
  assert.deepEqual(errors, []);
});

for (const width of [390, 1280]) test(`signed-in Add deal persists through reload, HTTP replay and a second partner at ${width}px`, async t => {
  const page = await browser.newPage({ viewport:{width,height:960}, timezoneId:'America/Chicago', reducedMotion:'reduce' });
  const partner = await browser.newPage({ viewport:{width,height:960}, timezoneId:'America/Chicago', reducedMotion:'reduce' });
  t.after(() => Promise.all([page.close(),partner.close()]));
  const errors = [];
  for (const current of [page,partner]) current.on('pageerror',error => errors.push(error.message));
  const namespace = `create-deal-${width}`;
  await page.request.post(`${origin}/api/test/seed`,{data:{namespace,viewer:'joe',reset:true}});
  const writes = [];
  page.on('request',request => {
    if (new URL(request.url()).pathname !== '/mcp' || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    if (['new-deal','set-lead','add-deal-note'].includes(body.params?.name)) writes.push(body);
  });
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.client.mode),'live');
  await page.getByRole('button',{name:'Add deal',exact:true}).click();
  await page.getByLabel('Deal name',{exact:true}).fill('Demo HTTP Partner Review');
  await page.getByLabel('Client',{exact:true}).fill('C-demo');
  await page.getByLabel('Owner',{exact:true}).selectOption('dell');
  await page.getByLabel('Type',{exact:true}).selectOption('renewal');
  await page.getByLabel('Stage',{exact:true}).selectOption('Research');
  await page.getByLabel('Notes',{exact:true}).fill('Demo HTTP initial review note');
  await page.getByRole('button',{name:'Create deal',exact:true}).click();
  const card = page.locator('.kanban-card').filter({hasText:'Demo HTTP Partner Review'});
  await card.waitFor();
  assert.equal(await card.count(),1);
  const id = await card.getAttribute('data-id');
  assert.deepEqual(writes.map(body => body.params.name),['new-deal','set-lead','add-deal-note']);
  assert.ok(writes.every(body => body.params.arguments.idempotency_key));
  const rpc = async (current,name,args={}) => {
    const response = await current.request.post(`${origin}/mcp`,{data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
    assert.equal(response.status(),200);
    const {result} = await response.json();
    assert.notEqual(result.isError,true);
    return JSON.parse(result.content[0].text);
  };
  const saved = await rpc(page,'get-deal-room',{deal:id});
  assert.equal(saved.owner,'dell');
  assert.equal(saved.thread.length,1);
  const note = saved.thread[0];
  assert.equal(note.actor,'joe');
  assert.equal(note.text,'Demo HTTP initial review note');
  assert.ok(Number.isFinite(Date.parse(note.recorded_at)));
  await page.reload();
  await card.waitFor();
  for (const body of writes) {
    const replay = await rpc(page,body.params.name,body.params.arguments);
    if (body.params.name === 'new-deal') assert.equal(replay.deal_id,id);
    else assert.equal(replay.ok,true);
  }
  const board = await rpc(page,'deal-room-board');
  assert.equal(board.deals.length,17);
  assert.equal(board.deals.filter(deal => deal.name === 'Demo HTTP Partner Review').length,1);
  assert.deepEqual((await rpc(page,'get-deal-room',{deal:id})).thread,[note]);
  await partner.request.post(`${origin}/api/test/seed`,{data:{namespace,viewer:'dell'}});
  assert.equal((await rpc(partner,'deal-room-board')).actor,'dell');
  await partner.goto(`${origin}/deals?mode=live&owner=dell&deal=${encodeURIComponent(id)}`);
  await partner.locator('#detailUpdateForm').waitFor();
  assert.equal(await partner.locator('#detailOwner').inputValue(),'dell');
  const renderedNote = partner.locator('.deal-note').filter({hasText:note.text});
  assert.equal(await renderedNote.count(),1);
  assert.equal(await renderedNote.locator('b').textContent(),'Joe');
  assert.equal(await renderedNote.locator('time').getAttribute('datetime'),note.recorded_at);
  assert.ok((await renderedNote.locator('time').textContent()).trim());
  assert.doesNotMatch(await renderedNote.locator('time').textContent(),/Date not recorded/);
  assert.deepEqual((await rpc(partner,'get-deal-room',{deal:id})).thread,[note]);
  assert.deepEqual(errors,[]);
});

for (const [code, message] of [
  ['subject_not_found', 'There’s no client named “Sample Cafe” yet. Pick an existing client, or add the client first.'],
  ['not_a_client', '“Sample Cafe” is not an existing client. Pick an existing client, or add the client first.'],
]) test(`Add deal stays editable after ${code}`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `add-deal-${code}`, viewer: 'joe', reset: true } });
  const requests = [];
  await page.route('**/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    if (params.name !== 'new-deal') return route.continue();
    requests.push(params.arguments);
    if (params.arguments.client !== 'Sample Cafe') return route.continue();
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { isError: true, content: [{
      type: 'text', text: JSON.stringify({ error: code,
        correlation_id: '00000000-0000-4000-8000-000000000001',
        hint: 'Choose an existing client.' }),
    }] } } });
  });

  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  const client = page.getByLabel('Client', { exact: true });
  await page.getByLabel('Deal name', { exact: true }).fill('Sample Cafe');
  await client.fill('Sample Cafe');
  await page.getByLabel('Owner', { exact: true }).selectOption('dell');
  await page.getByLabel('Type', { exact: true }).selectOption('other');
  await page.getByLabel('Notes', { exact: true }).fill('Discuss the first location.');
  const submit = page.getByRole('button', { name: 'Create deal', exact: true });
  await submit.click();
  const feedback = page.locator('#addDealError').filter({ hasText: /\S/ });
  await feedback.waitFor();
  assert.equal(await feedback.textContent(), message);
  assert.equal(await client.isEnabled(), true);
  assert.equal(await client.inputValue(), 'Sample Cafe');
  await client.fill('C-demo');
  await submit.click();
  const card = page.getByRole('button', { name: 'Sample Cafe', exact: true });
  await card.click();
  await page.getByText('Discuss the first location.', { exact: true }).waitFor();
  assert.equal(await page.locator('#detailOwner').inputValue(), 'dell');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key);
});

test('Add deal and Won or Lost save through the new database switch', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, timezoneId: 'America/Chicago' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-deals', viewer: 'joe', reset: true } });
  const clientId = '00000000-0000-4000-8000-000000000040';
  const deals = new Map();
  const writes = [];
  let savesOn = false;
  let clientList = 'available';
  const client = { id: `party:${clientId}`, ref: 'C-DEMO', name: 'Example Practice', kind: 'client' };
  const refusals = [
    ['Client role', { error: 'database_refused_the_statement', rule: 'deal_party_client_is_a_client' }, 'Choose an existing client.'],
    ['Market', { error: 'database_refused_the_statement', rule: 'deal_market_id_fkey' }, 'Choose an existing market.'],
    ['Renewal', { error: 'database_refused_the_statement', rule: 'deal_renewal_names_lease' }, 'Renewals need an existing lease. The Add deal form cannot link a lease yet.'],
    ['Duplicate', { error: 'deal_name_exists' }, 'A deal with this name already exists.'],
    ...['invalid_field_value', 'unknown_owner', 'version_conflict'].map(error => [error, { error }, 'Check the deal details and try again.']),
  ];
  const earlyDate = '2026-01-01';
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (key === 'deals-saves-from-engine' && savesOn) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const id = new URL(request.url).pathname.split('/')[4];
      if (request.method === 'GET') {
        if (id) return Response.json({ ...deals.get(id), deal_id: id });
        const rows = [...deals.values()];
        return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe',
          deals: rows.filter(row => !row.outcome), closed_deals: rows.filter(row => row.outcome === 'won'),
          lost_deals: rows.filter(row => row.outcome === 'lost') });
      }
      const body = await request.json();
      writes.push(body);
      if (new URL(request.url).pathname === '/api/engine/activities') {
        const deal = deals.get(body.about[0].deal_id);
        deal.thread = [{ kind: 'note', text: body.summary, created_at: body.happened_at }];
        return Response.json({ activity_id: crypto.randomUUID() }, { status: 201 });
      }
      if (!id) {
        const refusal = refusals.find(([name]) => body.name === `Example ${name}`);
        if (refusal && (refusal[0] !== 'Renewal' || body.reason === 'renewal'))
          return Response.json(refusal[1], { status: 422 });
        const dealId = crypto.randomUUID();
        deals.set(dealId, { id: dealId, name: body.name, client_name: 'Example Practice', owner: body.owner, phase: body.phase, seen: 1 });
        return Response.json({ deal_id: dealId, change_id: 1 }, { status: 201 });
      }
      if (body.phase.on === earlyDate) return Response.json({ error: 'invalid_field_value', fields: ['phase'] }, { status: 400 });
      deals.set(id, { ...deals.get(id), seen: 2, phase: body.phase.to, closed_on: body.phase.on,
        outcome: body.phase.to === 'closed' ? 'won' : 'lost', lost_reason: body.phase.reason,
        closed_value: body.fields?.closed_value?.toFixed(2) });
      return Response.json({ deal_id: id, change_id: 2 });
    } },
    CARR: { fetch: async () => new Response(null, { status: 502 }) },
  };
  await page.route('**/api/v1/business/relationships?*', route => clientList === 'unavailable'
    ? route.fulfill({ status: 503 })
    : route.fulfill({ json: { nodes: clientList === 'multiple'
      ? [client, { ...client, id: 'party:00000000-0000-4000-8000-000000000041' }] : [client] } }));
  await page.route('**/mcp', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'new-deal', 'update-deal', 'add-deal-note'].includes(body?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  await page.goto(`${origin}/deals?mode=live`);
  await page.getByText('0 open deals · 0 parked', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  await page.getByLabel('Deal name').fill('Example Stale Form');
  await page.getByLabel('Client', { exact: true }).fill('Example Practice');
  savesOn = true;
  await page.getByRole('button', { name: 'Create deal' }).click();
  await page.getByText('Reload Deals before adding a deal.', { exact: true }).waitFor();
  assert.equal(writes.length, 0);
  await page.reload();
  await page.getByText('0 open deals · 0 parked', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  await page.getByLabel('Deal name').fill('Example Unmatched Deal');
  for (const [list, name, hint] of [
    ['available', 'Example Unknown', 'Choose an existing client.'],
    ['multiple', 'Example Practice', 'More than one client has that name, so use the full client reference.'],
    ['unavailable', 'Example Practice', 'The client list is unavailable, so try again in a moment.'],
  ]) {
    clientList = list;
    await page.getByLabel('Client', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create deal' }).click();
    await page.locator('#addDealError').getByText(hint, { exact: true }).waitFor();
    assert.equal(writes.length, 0);
  }
  clientList = 'available';
  for (const [name, , hint] of refusals) {
    await page.getByLabel('Deal name').fill(`Example ${name}`);
    await page.getByLabel('Type', { exact: true }).selectOption(name === 'Renewal' ? 'renewal' : 'startup');
    await page.getByRole('button', { name: 'Create deal' }).click();
    await page.getByText(hint, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Deal name').isEnabled(), true);
  }
  writes.splice(0);

  for (const outcome of ['Won', 'Lost']) {
    const name = `Example ${outcome} Deal`;
    await page.getByLabel('Deal name').fill(name);
    await page.getByLabel('Client', { exact: true }).fill(outcome === 'Won' ? 'c-demo' : 'Example Practice');
    if (outcome === 'Won') await page.getByLabel('Notes', { exact: true }).fill('Example opening note');
    await page.getByRole('button', { name: 'Create deal' }).click();
    await page.getByRole('button', { name, exact: true }).click();
    if (outcome === 'Won') {
      await page.getByRole('tab', { name: 'Correspondence & notes' }).click();
      await page.getByRole('tabpanel', { name: 'Correspondence & notes' }).getByText('Example opening note', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Overview' }).click();
    }
    await page.locator('#detailPhase').selectOption('closed');
    assert.equal(await page.getByLabel('Paused', { exact: true }).isVisible(), false);
    await page.getByLabel(outcome, { exact: true }).check();
    if (outcome === 'Lost') {
      await page.getByRole('button', { name: 'Save outcome' }).click();
      await page.getByText('Enter the reason the deal was lost.', { exact: true }).waitFor();
      await page.getByLabel('Reason the deal was lost').fill('The client chose another site');
    } else await page.getByLabel('Won value').fill('1000');
    const date = page.getByLabel('Closed on', { exact: true });
    const today = await date.inputValue();
    assert.equal(await date.getAttribute('max'), today);
    await date.fill(earlyDate);
    await page.getByRole('button', { name: 'Save outcome' }).click();
    await page.locator('#completionErrors').getByText('Choose a closing date between the day the deal reached its current phase and today.', { exact: true }).waitFor();
    await date.fill(today);
    await page.screenshot({ path: join(evidence, `engine-${outcome.toLowerCase()}-dialog.png`) });
    await page.getByRole('button', { name: 'Save outcome' }).click();
    await page.getByText(`Deal marked ${outcome.toLowerCase()}`, { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Back to deals' }).click();
    await page.getByRole('button', { name: outcome === 'Won' ? 'Closed deals' : 'Lost deals', exact: true }).click();
    const archived = page.getByRole('button', { name, exact: true });
    await archived.waitFor();
    assert.equal(await archived.count(), 1);
    assert.equal(await page.locator('#closedCount').textContent(), outcome === 'Won' ? '1 closed deal' : '1 lost deal');
    if (outcome === 'Lost') await page.getByText('The client chose another site', { exact: true }).waitFor();
    await archived.click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    if (outcome === 'Won') await page.getByText('$1,000.00', { exact: true }).waitFor();
    else await page.locator('#workspaceFacts').getByText('Lost', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to deals' }).click();
    if (outcome === 'Won') await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  }
  assert.equal(writes.length, 7);
  assert.deepEqual(writes.filter(write => write.phase?.to && write.phase.on !== earlyDate).map(write => [write.phase.to, write.fields?.closed_value, write.phase.reason]),
    [['closed', 1000, undefined], ['dead', undefined, 'The client chose another site']]);
  assert.ok(writes.filter(write => write.name).every(write => write.client_id === clientId));
  assert.ok(writes.filter(write => write.name).every(write => write.reason === 'start_up'));
});
