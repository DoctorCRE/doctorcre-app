import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
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

for (const [actor, readsOn, savesOn] of [['joe', false, false], ['joe', true, true], ['dell', true, true], ['dell', true, false]]) {
  test(`deal files and email follow-ups for ${actor} with Deals reads ${readsOn ? 'on' : 'off'} and saves ${savesOn ? 'on' : 'off'}`, async t => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date('2026-11-18T15:00:00Z'));
    const [deal, plan, earlierPlan, letter, first, second] = Array.from({ length: 6 }, () => crypto.randomUUID());
    const row = { id: deal, deal_id: deal, name: 'Example File Deal', phase: 'research', seen: 1, owner: 'joe' };
    const documents = [
      { id: plan, name: 'Example Plan.pdf', version: 2, prepared_at: '2026-11-03T14:00:00+00:00' },
      { id: letter, name: 'Example Letter.pdf', version: 1, prepared_at: '2026-11-02T14:00:00+00:00' },
      { id: earlierPlan, name: 'Example Plan.pdf', version: 1, prepared_at: '2026-11-01T14:00:00+00:00' },
    ];
    const refusals = actor === 'joe' && savesOn ? [
      ['next_step', 409, 'open_step_exists', 'You already have an open step on this deal. Finish or change it first, or dismiss this suggestion.'],
      ['file_to_deal', 400, 'database_refused_the_statement', 'This email can’t be filed on this deal. Dismiss this suggestion.'],
      ['next_step', 422, 'invalid_field_value', 'Check the suggestion and any changes you made, or dismiss it.'],
      ['phase_move', 409, 'version_conflict', 'This deal has moved since the suggestion. Dismiss it.'],
      ['phase_move', 409, 'already_decided', 'This suggestion is already gone. Reload the deal to see what remains.'],
    ].map(([kind, status, error, hint], index) => ({
      kind, status, error, hint, id: crypto.randomUUID(), subject: `Example follow-up ${index + 1}`,
    })) : [];
    let email_follow_ups = [
      { proposal_id: first, kind: 'next_step', what: 'Send the plan', owner: 'dell', due_on: '2026-11-02',
        email: { subject: 'Plan ready', sender_name: 'Example Sender', happened_at: '2026-11-01T14:00:00+00:00' } },
      { proposal_id: second, kind: 'file_to_deal', evidence: 'The letter is attached.',
        email: { subject: 'Letter attached', sender: 'sender@example.test' } },
      ...refusals.map(({ kind, id, subject }) => ({
        proposal_id: id, kind, what: 'Review the example', to_phase: 'legal', email: { subject, sender: 'sender@example.test' },
      })),
    ];
    const completed = { id: 'executed_lease', label: 'Executed lease', status: 'complete', due_on: null,
      evidence_ref: 'Example Plan.pdf', source: { document: 'lease-guide' } };
    const overdue = { id: `critical-date:${first}`, label: 'lease end', status: 'overdue', due_on: '2026-11-14',
      evidence_ref: 'Example option notice', source: { record_verb: 'add-critical-date' } };
    const checklist = { schema_version: 'deal-checklist.v1', template_state: 'current',
      phases: [{ label: 'Legal / lease', items: [completed, overdue] }], due_items: [overdue] };
    const carr = [], opened = [], decisions = [];
    const env = {
      ENGINE_ROUTING: { get: async key => ({ 'deals-from-engine': readsOn, 'deals-saves-from-engine': savesOn })[key] ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/api/engine/deals') return Response.json({ schema_version: 'local-deals-board.v2', actor, deals: [row] });
        if (path === `/api/engine/deals/${deal}`) return Response.json({ ...row, checklist, documents, email_follow_ups });
        if (request.method === 'POST') {
          const id = path.split('/').at(-2);
          assert.equal(path, `/api/engine/proposals/${id}/decision`);
          assert.ok(request.headers.get('x-carr-csrf'));
          const { idempotency_key, decision, edits } = await request.json();
          assert.match(idempotency_key, /^[\da-f-]{36}$/);
          decisions.push([id, decision, edits]);
          const refusal = refusals.find(row => row.id === id && decision === 'accept');
          if (refusal && refusal.error !== 'already_decided') return Response.json({ error: refusal.error }, { status: refusal.status });
          email_follow_ups = email_follow_ups.filter(row => row.proposal_id !== id);
          if (refusal) return Response.json({ error: refusal.error }, { status: refusal.status });
          return Response.json({ proposal_id: id, status: decision === 'accept' ? 'accepted' : 'dismissed' });
        }
        const id = path.split('/').at(-1);
        const file = documents.find(file => file.id === id);
        assert.ok(file, path);
        opened.push(id);
        return new Response(`bytes of ${file.name} v${file.version}`, {
          headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${file.name}"` },
        });
      } },
      CARR: { fetch: async request => {
        const { id, params: { name, arguments: args } } = await request.json();
        if (name !== 'list-deal-documents' || args.limit === 50) carr.push(name);
        const data = {
          'deal-room-board': { schema_version: 'local-deals-board.v2', actor, deals: [row] },
          'get-deal-room': row,
          'list-email-proposals': { schema_version: 'email-proposals.v1', send: false, proposals: [], more: false, next_cursor: null },
          'list-deal-documents': { ok: true, schema_version: 'deal-documents.v1', documents: [], has_more: false, next_cursor: null },
        }[name];
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
      } },
    };
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `deal-file-read-${actor}-${readsOn}-${savesOn}`, viewer: actor, reset: true } });
    const routeThroughWorker = async route => {
      const request = route.request();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    };
    await page.route('**/api/engine/documents/*', routeThroughWorker);
    await page.route('**/mcp', route => [
      'deal-room-board', 'get-deal-room', 'list-deal-documents', 'list-email-proposals', 'decide-engine-deal-email',
    ].includes(route.request().postDataJSON()?.params?.name) ? routeThroughWorker(route) : route.continue());

    await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
    const followups = page.getByRole('region', { name: 'Email follow-ups' });
    await followups.getByText(readsOn ? 'Plan ready' : 'No email follow-ups.', { exact: true }).waitFor();
    if (readsOn) {
      for (const subject of ['Plan ready', 'Letter attached']) assert.equal(await followups.getByText(subject, { exact: true }).count(), 1);
      assert.match(await followups.innerText(), /Example Sender.*Nov 1/);
      assert.match(await followups.innerText(), /Send the plan.*Dell.*16 days late/);
      assert.doesNotMatch(await followups.innerText(), /2026-11-01T|file_to_deal/);
      const progress = page.locator('.deal-checklist');
      await progress.locator(':scope > summary').getByText('lease end', { exact: true }).waitFor();
      await progress.locator(':scope > summary').click();
      await progress.getByText('1 of 2 complete.', { exact: true }).waitFor();
      await progress.getByText('Complete', { exact: true }).waitFor();
      const deadline = progress.locator('[data-checklist-item]').filter({ hasText: 'lease end' });
      await deadline.getByText('Nov 14, 2026', { exact: true }).waitFor();
      await deadline.getByText('Overdue', { exact: true }).waitFor();
      await progress.locator(':scope > summary').getByText('lease end', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(await progress.getByText('lease end', { exact: true }).count(), 1);
      const filter = progress.getByRole('combobox', { name: 'Show', exact: true });
      await filter.selectOption({ label: 'To do' });
      assert.equal(await progress.getByText('Executed lease', { exact: true }).count(), 0);
      await filter.selectOption({ label: 'All' });
      await deadline.getByText('Details', { exact: true }).click();
      await deadline.getByText('Example option notice').waitFor();
      assert.doesNotMatch(await progress.innerText(), /2026-11-14|add-critical-date|\brecorded\b/i);
      await progress.evaluate(element => element.scrollIntoView({ block: 'end' }));
      await progress.screenshot({ path: join(evidence, `engine-checklist-${actor}.png`) });
      if (savesOn) {
        await followups.evaluate(element => element.scrollIntoView({ block: 'end' }));
        await followups.screenshot({ path: join(evidence, `engine-followups-${actor}.png`) });
        const planCard = followups.getByRole('article').filter({ hasText: 'Plan ready' });
        const letterCard = followups.getByRole('article').filter({ hasText: 'Letter attached' });
        await planCard.getByLabel('Next step', { exact: true }).fill('Send the revised plan');
        const dueDate = planCard.getByLabel('Due date', { exact: true });
        await dueDate.fill(actor === 'joe' ? '2026-11-21' : '');
        await planCard.getByRole('button', { name: 'Accept', exact: true }).click();
        await planCard.waitFor({ state: 'detached' });
        await letterCard.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await letterCard.waitFor({ state: 'detached' });
        assert.deepEqual(decisions.slice(0, 2), [
          [first, 'accept', { what: 'Send the revised plan', due_on: actor === 'joe' ? '2026-11-21' : null }],
          [second, 'dismiss', undefined],
        ]);
        for (const refusal of refusals) {
          const card = followups.getByRole('article').filter({ hasText: refusal.subject });
          await card.getByRole('button', { name: 'Accept', exact: true }).click();
          const receipt = page.locator('#receiptDock .receipt').filter({ hasText: refusal.hint });
          await receipt.waitFor();
          assert.equal(await receipt.getByRole('button', { name: 'Try again' }).count(), 0);
          const reload = receipt.getByRole('button', { name: 'Reload deal' });
          if (refusal.error === 'already_decided') await reload.click();
          else {
            assert.equal(await reload.count(), 0);
            if (refusal.kind === 'next_step') await card.getByLabel('Next step', { exact: true }).fill('');
            await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
          }
          await card.waitFor({ state: 'detached' });
          if (refusal.error !== 'already_decided') assert.deepEqual(decisions.at(-1), [refusal.id, 'dismiss', undefined]);
        }
        await followups.getByText('No email follow-ups.', { exact: true }).waitFor();
      } else assert.equal(await followups.getByRole('button').count(), 0);
    }
    await page.getByRole('tab', { name: 'Documents', exact: true }).click();
    const tab = page.getByRole('tabpanel', { name: 'Documents', exact: true });
    if (readsOn) {
      await tab.getByRole('link').first().waitFor();
      assert.equal(await tab.getByRole('link').count(), documents.length);
      for (const [index, file] of documents.entries()) {
        const item = tab.getByRole('listitem').nth(index);
        const link = item.getByRole('link', { name: `${file.name}, Version ${file.version}`, exact: true });
        assert.match(await item.innerText(), new RegExp(`Version ${file.version} · Nov [1-3]`));
        const downloading = page.waitForEvent('download');
        await link.click();
        const download = await downloading;
        assert.equal(download.suggestedFilename(), file.name);
        assert.equal(await text(await download.createReadStream()), `bytes of ${file.name} v${file.version}`);
      }
      assert.deepEqual(opened, [plan, letter, earlierPlan]);
      assert.doesNotMatch(await tab.innerText(), /2026-11-01T/);
      assert.deepEqual(carr, []);
      await tab.screenshot({ path: join(evidence, `engine-documents-${actor}.png`) });
    } else {
      await tab.getByText('No documents filed for this deal.').waitFor();
      assert.ok(carr.includes('list-deal-documents'));
      assert.ok(carr.includes('list-email-proposals'));
      assert.deepEqual(opened, []);
    }
  });
}
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

for (const { code, hint, message } of [
  {
    code: 'subject_not_found',
    hint: 'No record matched the supplied reference or name. Check it and try again.',
    message: 'There’s no client named “Sample Cafe”. Check the spelling or pick an existing client.',
  },
  {
    code: 'not_a_client',
    hint: 'Choose an existing client by reference or exact name.',
    message: '“Sample Cafe” is not an existing client. Check the spelling or pick an existing client.',
  },
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
      type: 'text', text: JSON.stringify({ error: code, correlation_id: '00000000-0000-4000-8000-000000000001', hint }),
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
  const card = page.locator('[data-column="pending"]').getByRole('button', { name: 'Sample Cafe', exact: true });
  await card.click();
  const updates = page.getByRole('region', { name: 'Deal updates', exact: true });
  await updates.locator('.updates-history > summary').click();
  await updates.getByText('Discuss the first location.', { exact: true }).waitFor();
  assert.equal(await page.locator('#detailOwner').inputValue(), 'dell');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key);
});

test('Deals shows late steps and can undo a close reported by the engine', async t => {
  const page = await browser.newPage({ timezoneId: 'America/Chicago' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-invoice-undo', viewer: 'joe', reset: true } });
  await page.clock.setFixedTime(new Date('2026-11-18T18:00:00Z'));
  const id = '00000000-0000-4000-8000-000000000061';
  const invoiceId = '00000000-0000-4000-8000-000000000062';
  const name = 'Example Invoice Deal';
  let switchesOn = false;
  let seen = 23;
  let undone = false;
  const undoRequests = [];
  const oldReads = [];
  const deal = () => ({ id, deal_id: id, name, owner: 'joe', phase: undone ? 'legal' : 'closed',
    ...(switchesOn && { seen, phase_change: undone ? null : { automatic: true, event_id: invoiceId,
      prior_phase: 'legal', phase: 'closed', evidence_date: '2026-11-17', reason: 'Example nightly close' } }),
    ...(undone ? {} : { outcome: 'won', closed_on: '2026-11-17' }),
    next_actions: [
      { id: 'first', description: 'Check floor plan', due_on: '2026-11-15', status: 'open', owner: 'joe' },
      { id: 'second', description: seen === 23 ? 'Call the architect' : 'Call the architect again', due_on: '2026-11-16', status: 'open', owner: 'dell' },
    ] });
  const board = () => ({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: undone ? [deal()] : [],
    closed_deals: undone ? [] : [deal()], lost_deals: [] });
  const env = {
    ENGINE_ROUTING: { get: async () => switchesOn ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === `/api/engine/deals/${id}`) return Response.json(deal());
      if (path === '/api/engine/deals') return Response.json(board());
      assert.equal(path, `/api/engine/invoice-emails/${invoiceId}/undo`);
      const body = await request.json();
      undoRequests.push(body);
      if (undoRequests.length === 1) {
        seen++;
        return Response.json({ error: 'version_conflict' }, { status: 409 });
      }
      undone = true;
      return Response.json({ invoice_id: invoiceId, status: 'undone' });
    } },
    CARR: { fetch: async request => {
      const { id: requestId, params } = await request.json();
      if (switchesOn) oldReads.push(params.name);
      return Response.json({ jsonrpc: '2.0', id: requestId, result: { content: [
        { type: 'text', text: JSON.stringify(params.name === 'deal-room-board' ? board() : deal()) },
      ] } });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'undo-invoice-close'].includes(body?.params?.name)) return route.continue();
    if (body.params.name === 'undo-invoice-close') assert.equal(body.params.arguments.seen_change_id, seen);
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  const otherSteps = page.getByRole('list', { name: 'Other open steps' });
  const undo = page.getByRole('button', { name: 'Undo invoice close' });
  const openClosedDeal = async () => {
    await page.goto(`${origin}/deals?mode=live`);
    if (switchesOn) await page.locator('#appTodayMoves').getByText('Open a deal to see its recent changes.', { exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Closed deals', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await otherSteps.getByText(/Call the architect.*2 days late/).waitFor({ timeout: 5000 });
    assert.match(await page.locator('.deal-current-action').textContent(), /^Overdue action: Check floor plan · Due .+2026$/);
  };
  await openClosedDeal();
  assert.equal(await undo.count(), 0);
  await page.goto('about:blank');
  switchesOn = true;
  await openClosedDeal();
  await page.getByRole('region', { name: 'Deal snapshot' }).getByText('Closed automatically: Invoice received', { exact: true }).waitFor();
  await undo.click();
  await page.getByText('This deal changed. Reload the deal before saving.', { exact: true }).waitFor();
  assert.equal(undoRequests.length, 1);
  await page.getByRole('button', { name: 'Reload deal', exact: true }).click();
  await otherSteps.getByText(/Call the architect again/).waitFor();
  await undo.click();
  await page.locator('#detailPhase').waitFor();
  assert.equal(await page.locator('#detailPhase').inputValue(), 'legal');
  assert.equal(await undo.count(), 0);
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).waitFor();
  assert.notEqual(undoRequests[0].idempotency_key, undoRequests[1].idempotency_key);
  assert.deepEqual(oldReads, []);
});

test('keyboard Undo returns an automatically moved card to the previous phase', async t => {
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'automatic-phase-undo', viewer: 'joe', reset: true } });
  const row = (name, prior_phase = 'research', automatic = true) => ({
    id: crypto.randomUUID(), name, owner: 'joe', phase: 'legal', seen: 23,
    phase_change: { source: 'copied', automatic, event_id: crypto.randomUUID(), phase: 'legal', prior_phase,
      evidence_date: '2026-10-19', recorded_at: '2026-10-20T00:00:00Z' },
  });
  const success = row('Example Restored Deal');
  const closed = row('Example Formerly Closed Deal', 'closed');
  const lost = row('Example Formerly Lost Deal', 'dead');
  const invoiced = row('Example Formerly Invoiced Deal', 'invoiced');
  const refused = row('Example Refused Undo Deal');
  const stale = row('Example Changed Deal');
  const manual = row('Example Manual Deal', 'research', false);
  const parked = { ...row('Example Parked Deal'), operating_state: 'parked', parking_reason: 'client_paused' };
  const deals = [success, closed, lost, invoiced, refused, stale, manual, parked];
  const board = () => ({ schema_version: 'local-deals-board.v2', actor: 'joe', deals });
  const writes = [], oldReads = [];
  let switches = new Set();
  const env = {
    ENGINE_ROUTING: { get: async key => switches.has(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') {
        if (path === '/api/engine/deals') return Response.json(board());
        const deal = deals.find(item => path === `/api/engine/deals/${item.id}`);
        assert.ok(deal);
        return Response.json({ ...deal, deal_id: deal.id });
      }
      const deal = deals.find(item => path === `/api/engine/deals/${item.id}/phase/undo`);
      assert.ok(deal);
      const body = await request.json();
      writes.push(body.idempotency_key);
      assert.match(body.idempotency_key, /^[a-f\d-]{36}$/i);
      assert.deepEqual(body, { idempotency_key: body.idempotency_key, event_id: deal.phase_change.event_id, base_version: deal.seen });
      if (deal === refused) return Response.json({
        error: 'version_conflict', current_version: deal.seen,
        hint: 'Undo would return this deal to Closed deals or Lost deals.',
      }, { status: 409 });
      deal.seen++;
      deal.phase = deal === stale ? 'negotiation' : 'research';
      deal.phase_change = null;
      return deal === stale
        ? Response.json({ error: 'version_conflict', current_version: deal.seen }, { status: 409 })
        : Response.json({ deal_id: deal.id, phase: deal.phase, phase_changed_at: '2026-11-18T18:00:00Z' });
    } },
    CARR: { fetch: async request => {
      const { id, params } = await request.json();
      oldReads.push(params.name);
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(board()) }] } });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'undo-automatic-phase-move'].includes(body?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  const card = deal => page.locator('.kanban-card').filter({ has: page.getByRole('button', { name: deal.name, exact: true }) });
  const undo = deal => card(deal).getByRole('button', { name: 'Undo', exact: true });
  for (const keys of [[], ['deals-from-engine'], ['deals-from-engine', 'deals-saves-from-engine']]) {
    switches = new Set(keys);
    await page.goto(`${origin}/deals?mode=live`);
    await card(success).waitFor();
    if (keys.length < 2) assert.equal(await undo(success).count(), 0);
  }
  assert.ok(oldReads.length);
  oldReads.length = 0;
  assert.equal(await card(manual).getByText('Moved automatically', { exact: true }).count(), 0);
  assert.equal(await undo(manual).count(), 0);
  await card(success).getByText('Moved automatically', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await card(success).locator('time[datetime="2026-10-19"]').textContent(), 'Mon, Oct 19, 2026');
  await undo(success).press('Enter');
  const restored = page.locator('[data-column="research"]').getByRole('button', { name: success.name, exact: true });
  await restored.waitFor();
  assert.equal(await card(success).count(), 1);
  assert.equal(await card(success).evaluate(node => node === document.activeElement), true);
  assert.equal(await undo(success).count(), 0);

  const refusal = deal => card(deal).getByText('Undo would return this deal to Closed deals or Lost deals.', { exact: true });
  for (const deal of [closed, lost, invoiced]) {
    assert.equal(await refusal(deal).isVisible(), true, deal.name);
    assert.equal(await undo(deal).count(), 0, deal.name);
    assert.equal(await card(deal).locator('xpath=ancestor::*[@data-column]').getAttribute('data-column'), 'legal');
  }
  await undo(refused).click();
  await refusal(refused).waitFor();
  assert.equal(await undo(refused).count(), 0);
  assert.equal(await card(refused).locator('xpath=ancestor::*[@data-column]').getAttribute('data-column'), 'legal');
  await undo(stale).press('Space');
  const reloaded = page.locator('[data-column="negotiation"]').getByRole('button', { name: stale.name, exact: true });
  await reloaded.waitFor();
  await card(stale).getByText('This deal changed. The card was refreshed.', { exact: true }).waitFor();
  assert.equal(await undo(stale).count(), 0);
  await page.screenshot({ path: join(evidence, 'automatic-phase-undo.png') });
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  const parkedCard = page.locator('.parked-card').filter({ hasText: parked.name });
  await parkedCard.getByRole('button', { name: 'Undo', exact: true }).click();
  await parkedCard.getByText('Moved automatically', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await parkedCard.count(), 1);
  assert.equal(writes.length, 4);
  assert.equal(new Set(writes).size, 4);
  await restored.click();
  await page.getByRole('heading', { name: success.name, exact: true }).waitFor();
  assert.deepEqual(oldReads, []);
});

test('National Accounts saves inline changes using the version on the deal board', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-national-fields', viewer: 'joe', reset: true } });
  const id = '00000000-0000-4000-8000-000000000071';
  const account = '00000000-0000-4000-8000-000000000072';
  const name = 'Example Market Deal';
  const row = { id, name, phase: 'research', seen: 23, owner: 'joe', account_client_id: account, workspace_kind: 'national_account' };
  const writes = [];
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      if (new URL(request.url).pathname === `/api/engine/deals/${id}`) return Response.json({ ...row, deal_id: id });
      if (request.method === 'GET') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row],
        accounts: [{ account_client_id: account, account_name: 'Example National Account', account_owner: 'joe' }] });
      assert.equal(new URL(request.url).pathname, `/api/engine/deals/${id}/changes`);
      const body = await request.json();
      writes.push(body);
      if (writes.length === 1) {
        row.seen++;
        row.phase = 'negotiation';
        return Response.json({ error: 'version_conflict' }, { status: 409 });
      }
      row.phase = body.phase.to;
      return Response.json({ deal_id: id, change_id: ++row.seen });
    } },
    CARR: { fetch: async () => new Response(null, { status: 502 }) },
  };
  await page.route('**/mcp', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'patch-deal-field'].includes(body?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await page.goto(`${origin}/deals?view=national&mode=live`);
  await page.getByRole('button', { name: /Example National Account/ }).click();
  const phase = page.getByLabel(`Phase for ${name}`);
  await phase.focus();
  await phase.selectOption('Legal');
  await page.getByText('This deal changed. Reload the deal before saving.', { exact: true }).waitFor({ timeout: 5000 });
  await phase.locator('option:checked').filter({ hasText: 'Negotiating' }).waitFor({ state: 'attached', timeout: 5000 });
  await phase.selectOption('Legal');
  await page.getByText(`${name} updated`, { exact: true }).waitFor();
  assert.deepEqual(writes.map(({ seen_change_id, phase }) => [seen_change_id, phase]), [
    [23, { from: 'research', to: 'legal' }], [24, { from: 'negotiation', to: 'legal' }],
  ]);
  assert.equal(await phase.inputValue(), 'Legal');
  await phase.selectOption('Closed');
  await page.getByRole('dialog', { name: `Close ${name}` }).getByRole('button', { name: 'Save outcome' }).waitFor({ timeout: 5000 });
  assert.equal(writes.length, 2);
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
    ['available', 'Example Unknown', 'There’s no client named “Example Unknown”. Check the spelling or pick an existing client.'],
    ['multiple', 'Example Practice', 'More than one client has that name, so use the full client reference.'],
    ['unavailable', 'Example Practice', 'The client list is unavailable, so try again in a moment.'],
  ]) {
    clientList = list;
    await page.getByLabel('Client', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create deal' }).click();
    const feedback = page.locator('#addDealError').filter({ hasText: /\S/ });
    await feedback.waitFor();
    assert.equal(await feedback.textContent(), hint);
    assert.equal(await page.getByLabel('Client', { exact: true }).isEnabled(), true);
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

test('switched-on Deals selects an existing market agent and decides critical dates', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  t.after(() => page.close());
  const [deal, account, person, date, prior, older] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const row = { id: deal, name: 'Example Market Deal', phase: 'research', seen: 1, owner: 'joe', account_client_id: account, market_agent: 'Previous Agent' };
  const critical = { id: date, kind: 'lease_end', due_on: '2027-01-02', status: 'proposed' };
  const dates = [critical, {
    id: crypto.randomUUID(), kind: 'phase_effective_date', due_on: '2027-01-01', status: 'open',
  }];
  let participants = [
    { party_id: prior, role: 'market_agent' },
    { party_id: older, role: 'market_agent' },
    { party_id: older, role: 'market_agent' },
    { party_id: account, role: 'listing_side' },
  ];
  const writes = [];
  const partyKeys = [];
  let droppedRemovalReceipt = false;
  let savesOn = false;
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (savesOn && key === 'deals-saves-from-engine') ? 'on' : null },
    ENGINE: { fetch: async request => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/engine/parties/search') {
        assert.deepEqual(Object.fromEntries(url.searchParams), { kind: 'person', query: 'Example' });
        return Response.json({ ok: true, schema_version: 'party-search.v1', parties: [
          { id: person, display_name: 'Example Market Agent', kind: 'person' },
        ] });
      }
      if (request.method === 'GET') return Response.json(path.endsWith(deal)
        ? { ...row, deal_id: deal, critical_dates: dates, participants, email_follow_ups: [] }
        : { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row],
          accounts: [{ account_client_id: account, account_name: 'Example National Account', account_owner: 'joe' }] });
      const { idempotency_key, ...body } = await request.json();
      assert.match(idempotency_key, /^[\da-f-]{36}$/i);
      writes.push([path, body]);
      if (path.includes('/parties')) partyKeys.push(idempotency_key);
      if (path.endsWith('/parties/remove')) {
        participants = participants.filter(p => p.party_id !== body.party_id || p.role !== body.role);
        if (body.party_id === older && !droppedRemovalReceipt) {
          droppedRemovalReceipt = true;
          return new Response(null, { status: 503 });
        }
        return Response.json({ deal_id: deal, ...body });
      }
      if (path.endsWith('/parties')) {
        if (participants.some(p => p.party_id === body.party_id && p.role === body.role))
          return Response.json({ error: 'database_refused_the_statement' }, { status: 422 });
        participants.push(body);
        row.market_agent = 'Example Market Agent';
        return Response.json({ deal_id: deal, ...body }, { status: 201 });
      }
      if (path.endsWith('/changes')) {
        row.phase = body.phase.to;
        return Response.json({ deal_id: deal, change_id: ++row.seen });
      }
      if (path.endsWith('/critical-dates')) {
        const id = crypto.randomUUID();
        dates.push({ ...body, id, status: 'open' });
        return Response.json({ critical_date_id: id, status: 'open' }, { status: 201 });
      }
      critical.status = body.resolution || 'open';
      return Response.json({ critical_date_id: date, status: critical.status });
    } },
    CARR: { fetch: async () => new Response(null, { status: 502 }) },
  };
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-people-dates', viewer: 'joe', reset: true } });
  await page.route('**/mcp', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    const verb = body?.params?.name;
    if (!['deal-room-board', 'get-deal-room', 'search-parties-v1', 'set-market-agent', 'confirm-critical-date',
      'resolve-critical-date', 'patch-deal-field', 'add-critical-date', 'remove-deal-participant'].includes(verb)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
  await page.getByRole('heading', { name: 'Critical dates', exact: true }).waitFor();
  assert.equal(await page.getByText('Add critical date', { exact: true }).count(), 0);
  assert.equal(await page.locator('.critical-date').filter({ hasText: 'Jan 1, 2027' }).locator(':scope > span').textContent(), 'Phase effective date');
  await page.goto(`${origin}/deals?view=national&mode=live`);
  await page.getByRole('button', { name: /Example National Account/ }).click();
  await page.getByRole('button', { name: 'Previous Agent' }).click();
  await page.getByLabel('Assigned local agent').waitFor();
  savesOn = true;
  await page.reload();
  await page.getByRole('button', { name: /Example National Account/ }).click();
  await page.getByRole('button', { name: 'Previous Agent' }).click();
  assert.equal(await page.locator('#dialogTitle').textContent(), 'Market agent — Example Market Deal');
  assert.equal(await page.getByText('Current agent: Previous Agent', { exact: true }).isVisible(), true);
  const chooseAgent = async () => {
    await page.getByLabel('Search people').fill('Example');
    await page.getByRole('button', { name: 'Find people' }).click();
    const agents = page.getByLabel('Market agent', { exact: true });
    await agents.locator('option').filter({ hasText: 'Example Market Agent' }).waitFor({ state: 'attached' });
    assert.equal(await agents.locator('option').count(), 2);
    await agents.selectOption({ label: 'Example Market Agent' });
  };
  const saveAgent = page.getByRole('button', { name: 'Save market agent' });
  await saveAgent.click();
  assert.equal(writes.length, 0);
  await chooseAgent();
  await page.screenshot({ path: join(evidence, 'engine-market-agent.png') });
  await saveAgent.click();
  const checkOutcome = page.getByRole('button', { name: 'Check outcome', exact: true });
  await checkOutcome.waitFor({ timeout: 5000 });
  await checkOutcome.click();
  await page.getByRole('button', { name: 'Example Market Agent', exact: true }).waitFor();
  assert.equal(new Set(partyKeys).size, 3);
  assert.equal(partyKeys[2], partyKeys[3]);
  assert.deepEqual(participants, [
    { party_id: account, role: 'listing_side' }, { party_id: person, role: 'market_agent' },
  ]);

  await page.getByRole('button', { name: 'Example Market Agent', exact: true }).click();
  await chooseAgent();
  await saveAgent.click();
  await saveAgent.waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(partyKeys.length, 4);

  await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
  const card = page.locator('.critical-date').filter({ hasText: 'Lease expiration' });
  await card.getByText('Jan 2, 2027', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  await card.getByText('Confirmed', { exact: true }).waitFor();
  await card.screenshot({ path: join(evidence, 'engine-critical-date.png') });
  await card.getByLabel('Reason').fill('The review is complete');
  await card.getByRole('button', { name: 'Mark done' }).click();
  await card.getByText('Done', { exact: true }).waitFor();

  const add = page.getByText('Add critical date', { exact: true });
  assert.equal(await add.count(), 1);
  await add.click();
  const kind = page.getByLabel('Kind', { exact: true });
  await kind.selectOption({ label: 'Phase effective date' });
  await page.getByLabel('Date', { exact: true }).fill('2027-01-04');
  const dateSource = page.getByRole('textbox', { name: 'Where did this date come from?' });
  const saveDate = page.getByRole('button', { name: 'Save critical date', exact: true });
  await dateSource.fill('   ');
  await saveDate.click();
  await page.getByText('Enter where the date came from.', { exact: true }).waitFor();
  assert.equal(writes.filter(([path]) => path.endsWith('/critical-dates')).length, 0);
  await dateSource.fill('Example letter');
  await page.getByLabel('Note (optional)', { exact: true }).fill('Signed by both sides');
  await saveDate.click();
  await page.getByText('Critical date added', { exact: true }).waitFor();
  const added = page.locator('.critical-date').filter({ hasText: 'Jan 4, 2027' });
  await added.getByText('Phase effective date', { exact: true }).waitFor();
  await added.getByText('Details', { exact: true }).click();
  await added.getByText('Signed by both sides', { exact: false }).waitFor();
  await added.screenshot({ path: join(evidence, 'engine-added-phase-date.png') });

  for (const [value, label, day, caption] of [
    ['option_notice', 'Option notice', '2027-01-05', 'Jan 5, 2027'],
    ['other', 'Other', '2027-01-06', 'Jan 6, 2027'],
  ]) {
    if (!await kind.isVisible()) await add.click();
    await kind.selectOption(value);
    assert.equal(await kind.locator('option:checked').textContent(), label);
    await page.getByLabel('Date', { exact: true }).fill(day);
    await dateSource.fill('Example contract');
    await page.getByLabel('Note (optional)', { exact: true }).fill('Example clause');
    await saveDate.click();
    const card = page.locator('.critical-date').filter({ hasText: caption });
    assert.equal(await card.locator(':scope > span').textContent(), label);
    await card.getByText('Details', { exact: true }).click();
    await card.getByText('Example clause', { exact: false }).waitFor();
  }

  await page.locator('#detailPhase').selectOption('site_selection');
  await page.getByLabel('Record this as a critical date').check();
  await page.getByLabel('Phase effective date', { exact: true }).fill('2027-01-03');
  await dateSource.fill('Example agreement');
  await page.getByRole('button', { name: 'Move to Site selection' }).click();
  const effectiveDate = page.locator('.critical-date').filter({ hasText: 'Jan 3, 2027' });
  await effectiveDate.getByText('Confirmed', { exact: true }).waitFor();
  assert.equal(await effectiveDate.getByText('Phase effective date', { exact: true }).count(), 1);
  assert.equal(await effectiveDate.getByText('Jan 3, 2027', { exact: true }).count(), 1);
  await effectiveDate.screenshot({ path: join(evidence, 'engine-phase-effective-date.png') });
  assert.deepEqual(writes, [
    [`/api/engine/deals/${deal}/parties`, { party_id: person, role: 'market_agent' }],
    [`/api/engine/deals/${deal}/parties/remove`, { party_id: prior, role: 'market_agent' }],
    [`/api/engine/deals/${deal}/parties/remove`, { party_id: older, role: 'market_agent' }],
    [`/api/engine/deals/${deal}/parties/remove`, { party_id: older, role: 'market_agent' }],
    [`/api/engine/critical-dates/${date}/confirm`, {}],
    [`/api/engine/critical-dates/${date}/resolve`, { resolution: 'done', reason: 'The review is complete' }],
    [`/api/engine/deals/${deal}/critical-dates`, { kind: 'phase_effective_date', due_on: '2027-01-04', source: 'Example letter', note: 'Signed by both sides' }],
    [`/api/engine/deals/${deal}/critical-dates`, { kind: 'option_notice', due_on: '2027-01-05', source: 'Example contract', note: 'Example clause' }],
    [`/api/engine/deals/${deal}/critical-dates`, { kind: 'other', due_on: '2027-01-06', source: 'Example contract', note: 'Example clause' }],
    [`/api/engine/deals/${deal}/changes`, { seen_change_id: 1, phase: { from: 'research', to: 'site_selection' } }],
    [`/api/engine/deals/${deal}/critical-dates`, { kind: 'phase_effective_date', due_on: '2027-01-03', source: 'Example agreement' }],
  ]);
});

async function routeClientWebsiteWorker(page, env) {
  const throughWorker = async route => {
    const request = route.request();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  };
  await page.route('**/api/engine/deals/**/client-website**', throughWorker);
  await page.route('**/mcp', route => ['deal-room-board', 'get-deal-room', 'register-client-portal'].includes(route.request().postDataJSON()?.params?.name)
    ? throughWorker(route) : route.continue());
}

test('switched-on Deals sets up a client website and opens it unlocked in a new tab', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  t.after(() => page.close());
  const deal = crypto.randomUUID();
  const grant = crypto.randomUUID();
  const website = 'https://share.doctorcre.com/example-website';
  const password = 'synthetic-website-password';
  const path = `/api/engine/deals/${deal}/client-website`;
  const row = { id: deal, deal_id: deal, name: 'Example Website Deal', phase: 'research', seen: 1, owner: 'joe' };
  const writes = [];
  const passwordRequests = [];
  page.on('request', request => {
    if (request.postData()?.includes(password)) passwordRequests.push(new URL(request.url()).pathname);
  });
  let registered = false;
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/engine/deals') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] });
      if (pathname === `/api/engine/deals/${deal}`) {
        return Response.json({ ...row, email_follow_ups: [], client_portal_url: registered ? website : null });
      }
      assert.ok(request.headers.get('x-carr-csrf'));
      const args = await request.json();
      writes.push([pathname, args]);
      if (pathname === path + '/open') return Response.json({ url: `${website}/?grant=${grant}` });
      assert.equal(pathname, path);
      if (args.slug === 'example-taken') return Response.json({ error: 'portal_slug_taken' }, { status: 409 });
      registered = true;
      return Response.json({ ok: true, deal_id: deal, client_portal_url: website, created: true });
    } },
    CARR: { fetch: async () => new Response(null, { status: 502 }) },
  };
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-client-website', viewer: 'joe', reset: true } });
  await routeClientWebsiteWorker(page, env);
  await page.context().route(website + '/?*', async route => {
    assert.equal(new URL(route.request().url()).searchParams.get('grant'), grant);
    await route.fulfill({ body: '<h1>Example client website</h1>', contentType: 'text/html' });
  });

  await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
  const overview = page.getByRole('tabpanel', { name: 'Overview' });
  await overview.getByText('No client website linked.', { exact: true }).waitFor();
  await overview.getByText('Set up client website', { exact: true }).click();
  const passwordInput = overview.getByLabel('Password', { exact: true });
  const nameInput = overview.getByLabel('Website name', { exact: true });
  const save = overview.getByRole('button', { name: 'Register website' });
  await nameInput.fill('example-taken');
  await passwordInput.fill(password);
  await save.click();
  await overview.getByText('That website name is already taken. Choose another name.', { exact: true }).waitFor();
  assert.equal(await passwordInput.inputValue(), '');
  await nameInput.fill('example-website');
  await passwordInput.fill(password);
  await save.click();

  const open = overview.getByRole('button', { name: /Client website.*opens in a new tab/ });
  await open.waitFor();
  assert.equal(await open.count(), 1);
  assert.equal(await open.evaluate(button => getComputedStyle(button).textDecorationLine), 'underline');
  await overview.getByRole('region', { name: 'Deal snapshot' }).screenshot({ path: join(evidence, 'client-website-deal.png') });
  assert.equal(await overview.getByText('Set up client website', { exact: true }).count(), 0);
  assert.equal(await overview.getByText('No client website linked.', { exact: true }).count(), 0);
  const popupOpened = page.waitForEvent('popup');
  await open.click();
  const popup = await popupOpened;
  await popup.getByRole('heading', { name: 'Example client website' }).waitFor();
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(await popup.getByLabel('Password', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(async secret => {
    const { dockEntries } = await import('/js/pipeline.js');
    return [document.body.innerHTML, JSON.stringify([...dockEntries().values()]),
      JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(value => value.includes(secret));
  }, password), false);
  assert.deepEqual(passwordRequests, [path, path]);
  assert.deepEqual(writes.map(([url, { idempotency_key, ...body }]) => {
    if (url === path) assert.match(idempotency_key, /^[\da-f-]{36}$/i);
    return [url, body];
  }), [
    [path, { slug: 'example-taken', password }],
    [path, { slug: 'example-website', password }],
    [path + '/open', {}],
  ]);
});

async function clientWebsitePage(t, { readsOn = true, savesOn = true, closed = false, linked = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  t.after(() => page.close());
  const deal = crypto.randomUUID();
  const website = 'https://share.doctorcre.com/example-website';
  const grant = crypto.randomUUID();
  const row = { id: deal, deal_id: deal, name: 'Example Website Deal', phase: closed ? 'closed' : 'research',
    ...(closed ? { outcome: 'won' } : {}), seen: 1, owner: 'joe', client_portal_url: linked ? website : null };
  const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: closed ? [] : [row, {
    id: crypto.randomUUID(), name: 'Example Deal Without Website', phase: 'research', owner: 'joe',
  }] };
  const enginePaths = [];
  const env = {
    ENGINE_ROUTING: { get: async key => ({ 'deals-from-engine': readsOn, 'deals-saves-from-engine': savesOn }[key] ? 'on' : null) },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      enginePaths.push(path);
      if (path === '/api/engine/deals') return Response.json(board);
      if (path === `/api/engine/deals/${deal}`) return Response.json({ ...row, email_follow_ups: [] });
      assert.equal(path, `/api/engine/deals/${deal}/client-website/open`);
      return Response.json({ url: `${website}/?grant=${grant}` });
    } },
    CARR: { fetch: async request => {
      const { id, params } = await request.json();
      assert.equal(params.name, 'deal-room-board');
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(board) }] } });
    } },
  };
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-client-website', viewer: 'joe', reset: true } });
  await routeClientWebsiteWorker(page, env);
  return { page, deal, website, grant, enginePaths };
}

for (const [blocked, toast] of [
  [true, 'Allow pop-ups for DoctorCRE and try again.'],
  [false, 'Could not open the client website. Refresh the deal and try again.'],
]) {
  test(`client website reports a ${blocked ? 'blocked popup' : 'refused grant'} and leaves no extra tab`, async t => {
    const { page, deal } = await clientWebsitePage(t);
    const requests = [];
    if (blocked) await page.addInitScript(() => { window.open = () => null; });
    await page.route('**/client-website/open', route => {
      requests.push(route.request().method());
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
    await page.getByRole('tabpanel', { name: 'Overview' }).getByRole('button', { name: /Client website/ }).click();
    await page.getByText(toast, { exact: true }).waitFor();
    assert.deepEqual(requests, blocked ? [] : ['POST']);
    assert.equal(page.context().pages().length, 1);
  });
}

for (const [closed, savesOn] of [[true, true], [false, false]]) {
  test(`client website setup is hidden ${closed ? 'on a closed deal' : 'with reads on and saves off'}`, async t => {
    const { page, deal } = await clientWebsitePage(t, { closed, savesOn, linked: false });
    await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
    const overview = page.getByRole('tabpanel', { name: 'Overview' });
    await overview.getByText('No client website linked.', { exact: true }).waitFor();
    assert.equal(await overview.getByText('Set up client website', { exact: true }).count(), 0);
  });
}

for (const readsOn of [true, false]) {
  test(`board card client website with Deals reads ${readsOn ? 'on' : 'off'}`, async t => {
    const { page, deal, website, grant, enginePaths } = await clientWebsitePage(t, { readsOn, savesOn: false });
    await page.context().route(url => url.href === website || url.href === `${website}/?grant=${grant}`, route =>
      route.fulfill({ body: '<h1>Example client website</h1>', contentType: 'text/html' }));
    await page.goto(`${origin}/deals?mode=live`);
    const card = page.locator('.kanban-card').filter({ hasText: 'Example Website Deal' });
    await card.getByRole('button', { name: 'Example Website Deal', exact: true }).waitFor();
    assert.equal(await page.locator('#kanban').getByText('Client website', { exact: false }).count(), 1);
    assert.equal(enginePaths.includes('/api/engine/deals'), readsOn);
    const grants = () => enginePaths.filter(path => path.endsWith('/client-website/open'));
    assert.deepEqual(grants(), []);
    const open = card.getByRole(readsOn ? 'button' : 'link', { name: /Client website/ });
    assert.equal(await open.count(), 1);
    if (readsOn) await card.screenshot({ path: join(evidence, 'client-website-card.png') });
    const popupOpened = page.waitForEvent('popup');
    await open.press('Enter');
    const popup = await popupOpened;
    await popup.getByRole('heading', { name: 'Example client website' }).waitFor();
    assert.equal(popup.url(), readsOn ? `${website}/?grant=${grant}` : website);
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.deepEqual(grants(), readsOn ? [`/api/engine/deals/${deal}/client-website/open`] : []);
    assert.equal(new URL(page.url()).searchParams.has('deal'), false);
  });
}

for (const width of [1440, 390]) {
  test(`Monday review keeps engine order and your place at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date('2026-11-16T04:00:00Z'));
    const [deal, prospect, parked] = Array.from({ length: 3 }, () => crypto.randomUUID());
    const row = { id: deal, deal_id: deal, name: 'Zephyr Deal', phase: 'research', owner: 'dell', seen: 1, seen_change_id: 1 };
    const prospectRow = { party_id: prospect, name: 'Birch Prospect', owner: null, how_found: 'referral',
      change_id: 2, latest_note: null, reviewed: null, seen_change_id: 0, state: 'dropped', needs_attention: true,
      follow_ups: [{ next_step_id: prospect, owner: 'joe', change_id: 1, what: 'Call back', due_on: '2026-11-16' }] };
    const parkedRow = { deal_id: parked, name: 'Alder Deal', phase: 'pending', reviewed: null,
      state: 'open', seen_change_id: 0, operating_state: 'parked' };
    const reviewId = crypto.randomUUID();
    const review = [
      { ...row, reviewed: { review_id: reviewId, by: 'joe', at: '2026-11-09T15:00:00Z' }, state: 'open' }, prospectRow, parkedRow,
    ];
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `monday-review-${width}`, viewer: 'joe', reset: true } });
    let enabled = false, savesOn = false;
    const writes = [], dealNotes = [];
    const weeks = [];
    const env = {
      ASSETS: { fetch: async () => new Response(await readFile(join(outDir, 'site', 'monday-review.html')), {
        headers: { 'content-type': 'text/html' },
      }) },
      ENGINE_ROUTING: { get: async key => (key === 'deals-from-engine' && enabled) || (key === 'deals-saves-from-engine' && savesOn) ? 'on' : null },
      ENGINE: { fetch: async request => {
        const url = new URL(request.url);
        if (request.method === 'POST') {
          const body = await request.json();
          assert.ok(body.idempotency_key);
          assert.ok(request.headers.get('x-carr-csrf'));
          writes.push([url.pathname, body]);
          if (url.pathname === '/api/engine/activities') {
            if (body.about[0].deal_id) dealNotes.unshift({ id: crypto.randomUUID(), kind: 'note', text: body.summary, actor: 'joe', recorded_at: '2026-11-09T15:00:00Z' });
            if (body.about[0].party_id) prospectRow.latest_note = { by: 'joe', at: '2026-11-09T15:00:00Z', summary: body.summary };
            return Response.json({ activity_id: crypto.randomUUID(), change_id: 7 }, { status: 201 });
          }
          if (url.pathname === '/api/engine/next-steps') {
            if (body.party_id) prospectRow.follow_ups[0].what = body.what;
            else Object.assign(review[0], { next_step: body.what, next_date: body.due_on });
            return Response.json({ next_step_id: crypto.randomUUID(), change_id: 8 }, { status: 201 });
          }
          const item = body.party_id ? prospectRow : review[0];
          if (item.seen_change_id !== body.seen_change_id)
            return Response.json({ error: 'version_conflict', current_version: item.seen_change_id }, { status: 409 });
          item.seen_change_id++;
          item.reviewed = url.pathname.endsWith('/remove') ? null : { review_id: reviewId, by: 'joe', at: '2026-11-09T15:00:00Z' };
          return Response.json({ review_id: reviewId }, { status: item.reviewed ? 201 : 200 });
        }
        if (url.pathname === '/api/engine/weekly-reviews') {
          weeks.push(url.searchParams.get('week_of'));
          return Response.json({ items: review });
        }
        if (url.pathname === '/api/engine/prospects') return Response.json({ count: 0, prospects: [] });
        if (url.pathname.endsWith(prospect)) return Response.json({ ...prospectRow, notes: [] });
        if (url.pathname.endsWith(parked)) return Response.json(parkedRow);
        if (url.pathname.endsWith(deal)) return Response.json({ ...row, next_step: review[0].next_step, next_date: review[0].next_date, thread: [...dealNotes,
          { id: 'example-note', kind: 'note', text: 'Example new note', actor: 'joe', recorded_at: '2026-11-09T15:00:00Z' },
        ] });
        return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] });
      } },
      CARR: { fetch: async request => {
        if (request.method === 'GET') return new Response('Signed in');
        const { id } = await request.json();
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ deals: [row] }) }] } });
      } },
    };
    await page.route(url => url.pathname === '/mcp' || url.pathname.startsWith('/api/engine/weekly-reviews')
      || url.pathname.startsWith('/api/engine/prospects')
      || (url.pathname === '/deals' && url.searchParams.get('view') === 'review'), async route => {
      const request = route.request();
      if (new URL(request.url()).pathname === '/mcp' && !['deal-room-board', 'get-deal-room', 'add-deal-note', 'set-next-step'].includes(request.postDataJSON()?.params?.name))
        return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const reviewPath = `${origin}/api/engine/weekly-reviews?week_of=2026-11-09`;
    assert.equal((await handleDoctorcreRequest(new Request(reviewPath), env)).status, 404);
    await page.goto(`${origin}/deals?view=review&mode=live`);
    assert.equal(new URL(page.url()).searchParams.get('view'), null);
    await page.getByRole('button', { name: row.name }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Monday review' }).count(), 0);
    assert.deepEqual(weeks, []);

    enabled = true;
    const closedSave = new Request(reviewPath, { method: 'POST', headers: { 'x-carr-csrf': 'synthetic' },
      body: JSON.stringify({ deal_id: deal, week_of: '2026-11-09', seen_change_id: 1, idempotency_key: crypto.randomUUID() }) });
    assert.equal((await handleDoctorcreRequest(closedSave, env)).status, 404);
    await page.goto(`${origin}/deals?owner=joe&mode=live`);
    await page.getByRole('link', { name: 'Monday review' }).click();
    await page.getByText('1 of 3 reviewed this week').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Parked', exact: true }).count(), 0);
    assert.deepEqual(weeks, ['2026-11-09']);
    await page.getByText(/Reviewed by Joe · Nov 9/).waitFor();
    await page.getByText('Example new note').waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('link', { name: 'Birch Prospect' }).waitFor();
    await page.getByText(/Prospect · Unclaimed · Dropped · Needs attention/).waitFor();
    await page.getByText(/Due Mon, Nov 16/).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('link', { name: row.name }).waitFor();
    await page.getByRole('button', { name: 'As a list' }).click();
    const items = page.getByRole('main', { name: 'Monday review' }).getByRole('listitem');
    assert.deepEqual(await items.getByRole('link').allTextContents(), [row.name, 'Birch Prospect', 'Alder Deal']);
    assert.match(await page.getByRole('link', { name: 'Birch Prospect' }).getAttribute('href'), new RegExp(`prospect=${prospect}`));
    await page.getByRole('checkbox', { name: 'Not reviewed' }).check();
    assert.deepEqual(await items.getByRole('link').allTextContents(), ['Birch Prospect', 'Alder Deal']);
    await page.getByRole('checkbox', { name: 'Not reviewed' }).uncheck();
    await page.getByRole('link', { name: 'Birch Prospect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Birch Prospect' });
    await dialog.getByText(/Joe · Call back/).waitFor();
    await dialog.getByRole('button', { name: 'Back to Monday review' }).click();
    await page.getByRole('button', { name: 'As a list', pressed: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, `monday-review-${width}.png`), fullPage: true });
    await page.getByRole('link', { name: row.name }).click();
    await page.locator('#panelTitle').getByText(row.name).waitFor();
    await page.getByRole('button', { name: 'Back to Monday review' }).click();
    await page.getByRole('button', { name: 'As a list', pressed: true }).waitFor();
    assert.deepEqual(await items.getByRole('link').allTextContents(), [row.name, 'Birch Prospect', 'Alder Deal']);
    await page.getByRole('link', { name: parkedRow.name }).click();
    await page.locator('#panelTitle').getByText(parkedRow.name).waitFor();

    savesOn = true;
    await page.goto(`${origin}/deals?view=review&mode=live`);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('0 of 3 reviewed this week').waitFor();
    await page.reload();
    await page.getByText('0 of 3 reviewed this week').waitFor();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('link', { name: prospectRow.name }).waitFor();
    await page.getByText('1 of 3 reviewed this week').waitFor();
    prospectRow.seen_change_id++;
    prospectRow.reviewed = { review_id: crypto.randomUUID(), by: 'dell', at: '2026-11-09T16:00:00Z' };
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByText('Changed by the other partner. Review reloaded.').waitFor();
    await page.getByText(/Reviewed by Dell/).waitFor();
    assert.equal(writes.filter(([path]) => path.startsWith('/api/engine/weekly-reviews')).length, 3);

    await page.getByLabel('Add note').fill('Example review note');
    await page.getByLabel('Add note').press('Enter');
    await page.getByText('Example review note', { exact: true }).waitFor();
    await page.getByText('Follow-up', { exact: true }).click();
    await page.getByLabel('Your follow-up').fill('Confirm the address');
    await page.getByLabel('Follow-up date').fill('2026-11-17');
    await page.getByRole('button', { name: 'Set your follow-up' }).click();
    await page.getByText(/Confirm the address · Due/).waitFor();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByLabel('Add note').fill('Example deal note');
    await page.getByLabel('Add note').press('Enter');
    await page.getByText('Example deal note', { exact: true }).waitFor();
    await page.getByText('Change next step', { exact: true }).click();
    await page.getByLabel('Next step', { exact: true }).fill('Send the plan');
    await page.getByLabel('Due date').fill('2026-11-17');
    await page.getByRole('button', { name: 'Save next step' }).click();
    await page.getByText(/Send the plan · Due/).waitFor();
    assert.equal(writes.filter(([path]) => path === '/api/engine/activities').length, 2);
    assert.equal(writes.filter(([path]) => path === '/api/engine/next-steps').length, 2);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, `monday-review-saves-${width}.png`), fullPage: true });
  });
}

test('the switched-on Timeline shows one ordered history including a newly saved note', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  t.after(() => page.close());
  await page.clock.setFixedTime(new Date('2026-11-18T15:00:00Z'));
  const deal = crypto.randomUUID();
  const row = { id: deal, deal_id: deal, name: 'Example Timeline Deal', phase: 'legal', seen: 1, owner: 'joe' };
  const thread = [{ id: 'copied-note', kind: 'note', text: 'Tour plans confirmed', actor: 'dell', created_at: '2026-11-17T20:00:00Z' }];
  const beforeDocument = '2026-11-16T13:00:00Z';
  const stepChanges = [
    ['Send the floor plan', 'done', 'Done'],
    ['Ask for the rent quote', 'cancelled', 'Cancelled'],
    ['Book an evening tour', 'expired', 'Expired'],
  ];
  const dates = [
    ['due-diligence', 'due_diligence', 'open', 'Due diligence · Confirmed'],
    ['lease-end', 'lease_end', 'cleared', 'Lease expiration · Done'],
    ['option', 'option_notice', 'dropped', 'Option notice · Dropped'],
    ['phase-effective', 'phase_effective_date', 'passed', 'Phase effective date · Passed'],
  ];
  const dealChanges = [
    ['operating_state', 'Parked · Client paused · Back in spring', 'Parked · Client paused · Back in spring'],
    ['operating_state', 'Active', 'Active again'],
    ['attention', false, 'Needs attention cleared'],
    ['won_value', 125000, 'Closed value · $125,000'],
    ['won_value', 125050.5, 'Closed value · $125,050.50'],
  ];
  const events = [
    { id: 'copied-event', activity_id: 'copied-note', verb: 'add-deal-note', field: 'note', new_value: { note: thread[0].text }, actor: 'dell', recorded_at: '2026-11-17T20:00:01Z' },
    { id: 'move', verb: 'move-phase', field: 'phase', new_value: 'legal', actor: 'agent', recorded_at: '2026-11-18T01:00:00Z' },
    { id: 'attention', verb: 'update-deal', field: 'attention', new_value: true, actor: 'joe', recorded_at: '2026-11-17T14:00:00Z' },
    ...dealChanges.map(([field, new_value], i) => ({
      id: `change-${i}`, verb: 'update-deal', field, new_value, actor: 'joe', recorded_at: beforeDocument,
    })),
  ];
  const detail = { ...row, thread, events, email_follow_ups: [],
    phase_started_on: { legal: '2026-11-17' },
    documents: [{ id: 'file', name: 'Example plan.pdf', actor: 'mail_capture', prepared_at: '2026-11-16T14:00:00Z' }],
    next_actions: [
      { id: 'step', owner: 'dell', actor: 'joe', description: 'Check the floor plan', status: 'open', updated_at: '2026-11-17T18:00:00Z' },
      ...stepChanges.map(([description, status]) => ({
        id: status, owner: 'dell', actor: 'joe', description, status, due_on: '2026-11-19', updated_at: beforeDocument,
      })),
    ],
    critical_dates: dates.map(([id, kind, status]) => ({
      id, kind, status, due_on: '2026-11-19', actor: 'dell',
      updated_at: status === 'open' ? '2026-11-17T19:00:00Z' : beforeDocument,
    })),
  };
  let switchesOn = false;
  const carr = [], engine = [];
  const env = {
    ENGINE_ROUTING: { get: async key => switchesOn && ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      engine.push(path);
      if (path === '/api/engine/deals') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] });
      if (path === `/api/engine/deals/${deal}`) return Response.json(detail);
      assert.equal(path, '/api/engine/activities');
      const { kind, about, summary, happened_at } = await request.json();
      assert.deepEqual({ kind, about, summary }, { kind: 'note', about: [{ deal_id: deal }], summary: 'Tour plans confirmed' });
      const id = crypto.randomUUID();
      thread.push({ id, kind, text: summary, actor: 'joe', created_at: happened_at });
      return Response.json({ activity_id: id }, { status: 201 });
    } },
    CARR: { fetch: async request => {
      const { id, params: { name } } = await request.json();
      carr.push(name);
      const data = name === 'deal-room-board'
        ? { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] }
        : { ...row, thread, phase_started_on: detail.phase_started_on };
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    } },
  };
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-timeline', viewer: 'joe', reset: true } });
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'get-deal-room', 'add-deal-note'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  const timeline = page.getByRole('tabpanel', { name: 'Timeline' });
  const openTimeline = async () => {
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await timeline.getByText('Tour plans confirmed', { exact: true }).first().waitFor();
  };
  await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
  await openTimeline();
  assert.equal(await timeline.getByText('Phase timeline', { exact: true }).count(), 1);
  assert.ok(carr.includes('get-deal-room'));
  assert.deepEqual(engine, []);

  switchesOn = true;
  await page.reload();
  await openTimeline();
  const rows = timeline.getByRole('listitem');
  const contents = await rows.allTextContents();
  assert.equal(contents.length, 6 + stepChanges.length + (dates.length - 1) + dealChanges.length);
  assert.match(contents[0], /Automatically.*Nov 17.*7:00 PM.*Legal/);
  assert.match(contents[1], /Dell.*Nov 17.*2:00 PM.*Tour plans confirmed/);
  assert.match(contents[2], /Dell.*Nov 17.*1:00 PM.*Due diligence.*Due Nov 19/);
  assert.match(contents[3], /Joe.*Check the floor plan$/);
  assert.match(contents[5], /Automatically.*Nov 16.*Example plan\.pdf/);
  const descriptions = await rows.locator('p').allTextContents();
  for (const [description, , state] of stepChanges) {
    assert.ok(descriptions.includes(`${description} · ${state} · Due Nov 19, 2026`), `Next step should say ${state}`);
  }
  for (const [, , , caption] of dates) {
    assert.ok(descriptions.includes(`${caption} · Due Nov 19, 2026`), `Critical date should say ${caption}`);
  }
  for (const description of ['Needs attention', ...dealChanges.map(([, , label]) => label)]) {
    assert.equal(descriptions.filter(text => text === description).length, 1, description);
  }
  assert.doesNotMatch(contents.join(' '), /2026-11-|move-phase|add deal note|Active work ·|Attention flag/);

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByLabel('Update', { exact: true }).fill('Tour plans confirmed');
  await page.getByRole('button', { name: 'Add update' }).click();
  await page.locator('#detailUpdateStatus').getByText('Update added', { exact: true }).waitFor();
  await openTimeline();
  const notes = rows.filter({ hasText: 'Tour plans confirmed' });
  assert.equal(await notes.count(), 2);
  assert.match(await notes.nth(0).innerText(), /Joe\s+Nov 18, 9:00 AM/);
  assert.match(await notes.nth(1).innerText(), /Dell\s+Nov 17, 2:00 PM/);
  assert.doesNotMatch(carr.join(' '), /add-deal-note/);
  const filter = timeline.getByLabel('Filter by type');
  await filter.selectOption('Note');
  assert.equal(await rows.count(), 2);
  await filter.selectOption('');
  await timeline.screenshot({ path: join(evidence, 'engine-timeline.png') });
});
