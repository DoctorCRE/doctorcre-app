import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { FixtureHtmlRewriter } from './fixtures/worker-html.ts';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { controlFloor } from "./control-floor.ts";

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'out/test-artifacts/dealroom-acceptance');
let outDir, server, browser, origin;

before(async () => {
  globalThis.HTMLRewriter = FixtureHtmlRewriter;
  outDir = await temporaryDirectory('dealroom-acceptance-');
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  server = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  origin = server.origin;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});

for (const width of [1440, 390]) {
  test(`parking, renewal and ended deal captions at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Los_Angeles' });
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date('2026-11-20T18:00:00Z'));
    const deal = (name, fields) => ({ id: crypto.randomUUID(), name, owner: 'joe', phase: 'research', seen: 1, ...fields });
    const parked = { operating_state: 'parked', parking_reason: 'client_paused' };
    const legacyStep = 'Confirm the revised floor plan with the site manager. '.repeat(8).trim();
    const automatic = deal('Example Automatic Parking', { ...parked, parked_automatically: true, parked_by: null, next_step: legacyStep });
    const partner = deal('Example Partner Parking', { ...parked, parking_note: 'Waiting for the tenant', parked_automatically: false, parked_by: 'dell' });
    const renewal = { kind: null, reason: 'renewal', renewal_lease_unrecorded: true, client_name: 'Example Practice', closed_on: '2026-11-02' };
    const nextActions = [
      { id: crypto.randomUUID(), owner: 'joe', description: 'Send the sample plan', status: 'open', due_on: '2026-10-21' },
      { id: crypto.randomUUID(), owner: 'dell', description: 'Check the sample lease', status: 'open', due_on: '2026-10-20' },
      { id: crypto.randomUUID(), owner: 'joe', description: 'Find the sample map', status: 'done', due_on: '2026-10-19' },
    ];
    const items = [{ id: crypto.randomUUID(), title: 'Review fixture checklist', status: 'open', due_on: '2026-10-19', bullets: [] }];
    const won = deal('Example Closed Renewal', { ...renewal, client_name: 'Example Closed Renewal', type: 'renewal',
      phase: 'closed', outcome: 'won', next_actions: nextActions, items });
    const undated = deal('Example Undated Deal', { phase: 'invoiced', kind: 'build_to_suit', type: 'build_to_suit',
      client_name: 'Example Clinic', owner: 'dell', outcome: null, closed_on: null, invoiced_on: null, next_actions: nextActions });
    const reasonOnly = deal('Example Former Office', { phase: 'closed', outcome: 'won', closed_on: '2026-10-15',
      kind: null, type: 'relocation', reason: 'relocation', client_name: 'Example Studio' });
    const lost = deal('Example Lost Renewal', { ...renewal, kind: 'sale_leaseback', type: 'sale_leaseback', ...parked, phase: 'pending', outcome: 'lost', lost_reason: 'Plans changed', next_actions: nextActions });
    const lostNoReason = deal('Example Lost Without Deal Reason', { phase: 'dead', outcome: 'lost' });
    const lostUnknown = deal('Example Lost Renewal With Unknown Type', { ...renewal, type: 'renewal', ...parked, phase: 'closed', outcome: 'lost',
      closed_on: null, lost_reason: 'not recorded before this system' });
    const withLease = deal('Example Renewal With Lease', { kind: 'lease', reason: 'renewal', type: 'lease', phase: 'dead', outcome: 'lost' });
    const rows = [automatic, partner, won, undated, reasonOnly, lost, lostNoReason, lostUnknown, withLease];
    const board = () => ({ schema_version: 'local-deals-board.v2', actor: 'joe',
      deals: [automatic, partner], closed_deals: [won, undated, reasonOnly], lost_deals: [lost, lostNoReason, lostUnknown, withLease] });
    const switches = new Set();
    let revivals = 0;
    const env = {
      ENGINE_ROUTING: { get: async key => switches.has(key) ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/api/engine/deals') return Response.json(board());
        if (path === `/api/engine/deals/${automatic.id}/changes`) {
          const { idempotency_key, ...change } = await request.json();
          assert.match(idempotency_key, /^[\da-f-]{36}$/);
          assert.deepEqual(change, { seen_change_id: 1, fields: { parking_reason: null, parking_note: null } });
          Object.assign(automatic, { operating_state: 'active', parking_reason: null, parked_automatically: false, seen: 2 });
          revivals++;
          return Response.json({ deal_id: automatic.id, change_id: automatic.seen });
        }
        const row = rows.find(item => path === `/api/engine/deals/${item.id}`);
        return row ? Response.json({ ...row, deal_id: row.id, email_follow_ups: [] }) : new Response(null, { status: 404 });
      } },
      CARR: { fetch: async request => {
        const { id, params } = await request.json();
        const data = params.name === 'deal-room-board' ? board() : rows.find(item => item.id === params.arguments.deal);
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
      } },
    };
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `deal-captions-${width}`, viewer: 'joe', reset: true } });
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (!['deal-room-board', 'get-deal-room', 'patch-deal-field'].includes(request.postDataJSON()?.params?.name)) return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });

    const card = row => page.locator(`article[data-id="${row.id}"]`);
    const detail = page.locator('#recordPanel');
    const caption = (scope, text) => scope.getByText(text, { exact: true });
    const capture = (locator, name) => locator.screenshot({ path: join(evidence, `deal-captions-${width}-${name}.png`) });
    const openParked = () => page.getByRole('button', { name: 'Parked', exact: true }).click();
    const openDetail = async row => {
      const title = row.operating_state === 'parked' ? caption(card(row), row.name)
        : card(row).getByRole('button', { name: row.name, exact: true });
      await title.click();
      await page.locator('#panelTitle').getByText(row.name, { exact: true }).waitFor();
    };
    const back = () => page.getByRole('button', { name: 'Back to deals', exact: true }).click();
    const parkedPhase = caption(detail.locator('#workspaceFacts'), 'Research · Parked');
    const boardUrl = `${origin}/deals?mode=live`;
    await page.goto(boardUrl);
    await openParked();
    await card(automatic).waitFor();
    if (width === 390) {
      await page.getByRole('button', { name: 'List', exact: true }).click();
      const step = caption(card(automatic), legacyStep);
      await step.waitFor();
      assert.ok(await step.evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth));
      await page.getByRole('button', { name: 'Board', exact: true }).click();
    }
    assert.equal(await caption(card(automatic), 'Parked automatically').count(), 0);
    await openDetail(automatic);
    await detail.getByRole('button', { name: 'Revive', exact: true }).waitFor();
    assert.equal(await caption(detail, 'Parked automatically').count(), 0);
    assert.equal(await parkedPhase.count(), 0);
    assert.deepEqual(await detail.locator('#detailOwner option').allTextContents(), ['Unassigned', 'Joe', 'Dell']);
    await page.goto(`${boardUrl}&view=closed`);
    await caption(card(won), 'Renewal').waitFor();
    assert.equal(await card(undated).count(), 0);
    assert.equal(await caption(card(won), 'Lease not recorded').count(), 0);
    await openDetail(won);
    assert.equal(await caption(detail.locator('#workspaceFacts'), 'Client').count(), 0);
    await caption(detail, 'Renewal').waitFor();
    assert.equal(await caption(detail, 'Lease not recorded').count(), 0);
    await page.goto(`${boardUrl}&deal=${lost.id}`);
    await page.locator('#panelTitle').getByText(lost.name, { exact: true }).waitFor();
    assert.equal(await caption(detail, 'Reason for loss').count(), 0);

    switches.add('deals-from-engine');
    await page.goto(boardUrl);
    await openParked();
    await caption(card(automatic), 'Client paused').waitFor();
    await caption(card(partner), 'Client paused').waitFor();
    await capture(page.locator('.parked-lane'), 'parked');
    await openDetail(automatic);
    await caption(detail, 'Parked automatically').waitFor({ timeout: 5000 });
    assert.equal(await parkedPhase.isVisible(), true);
    await capture(detail.locator('[data-detail-read="parked"]'), 'automatic-detail');
    await back();
    await openDetail(partner);
    await caption(detail, 'Parked by Dell').waitFor({ timeout: 5000 });
    await back();
    const detailFacts = detail.locator('.deal-snapshot-facts');
    const tabRowFacts = detail.locator('#workspaceFacts');
    const fact = (scope, label) => caption(scope, label).locator('..');
    const search = page.locator('#closedSearch');
    assert.equal(await page.title(), 'Deals · DoctorCRE');
    assert.equal(await search.getAttribute('placeholder'), 'Deal, client, kind, or close date');
    const expectSearch = async (query, row) => {
      await search.fill(query);
      assert.deepEqual(await page.locator('#closedDealsList h3').allTextContents(), [row.name], query);
    };
    for (const [label, row] of [['Closed deals', won], ['Lost deals', lost]]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await caption(card(row), 'Renewal').waitFor({ timeout: 5000 });
      await caption(card(row), 'Lease not recorded').waitFor({ timeout: 5000 });
      const expectedType = row === lost ? 'Sale-leaseback' : 'Not recorded';
      await caption(fact(card(row), 'Deal kind'), expectedType).waitFor({ timeout: 5000 });
      if (row === lost) {
        await caption(fact(card(lostNoReason), 'Deal reason'), 'Not recorded').waitFor({ timeout: 5000 });
        await caption(fact(card(lostUnknown), 'Deal kind'), 'Not recorded').waitFor({ timeout: 5000 });
        await caption(card(lostUnknown), 'Lease not recorded').waitFor();
        assert.equal(await fact(card(lostUnknown), 'Reason for loss').locator('dd').innerText(), 'Not recorded before this system');
        await caption(card(row), 'Reason for loss').waitFor();
        await caption(card(row), 'Plans changed').waitFor();
        await caption(card(withLease), 'Renewal').waitFor();
        assert.equal(await caption(card(withLease), 'Lease not recorded').count(), 0);
        await expectSearch('plans changed', lost);
        await expectSearch('sale-leaseback', lost);
        await search.fill('sale_leaseback');
        await page.getByText('No lost deals match this search.').waitFor();
        await search.clear();
        await openDetail(lostUnknown);
        await caption(fact(tabRowFacts, 'Deal kind'), 'Not recorded').waitFor();
        await caption(fact(detailFacts, 'Reason for loss'), 'Not recorded before this system').waitFor({ timeout: 5000 });
        await caption(fact(detailFacts, 'Close date'), 'Close date not recorded').waitFor();
        assert.equal(await fact(detail.locator('#workspaceFacts'), 'Phase').locator('dd').textContent(), 'Lost');
        await back();
        await caption(fact(card(withLease), 'Deal kind'), 'Lease').waitFor();
        await openDetail(withLease);
        await caption(fact(tabRowFacts, 'Deal kind'), 'Lease').waitFor();
        await back();
      } else {
        await caption(fact(card(undated), 'Deal reason'), 'Not recorded').waitFor({ timeout: 5000 });
        await caption(card(undated), 'Close date not recorded').waitFor({ timeout: 5000 });
        await caption(card(won), 'Mon, Nov 2, 2026').waitFor();
        await expectSearch('Mon, Nov 2, 2026', won);
        for (const query of ['undated', 'example clinic', 'build-to-suit', 'close date not recorded', 'dell']) {
          await expectSearch(query, undated);
        }
        await search.clear();
        await openDetail(undated);
        await caption(fact(tabRowFacts, 'Deal kind'), 'Build-to-suit').waitFor();
        const undatedSteps = detail.getByRole('region', { name: 'Next steps' });
        assert.equal(await undatedSteps.getByRole('heading', { name: 'Open before this deal ended' }).count(), 1,
          'An invoiced deal stays ended even when its dates and outcome are missing');
        assert.match(await undatedSteps.innerText(), /Due Wed, Oct 21, 2026/);
        assert.doesNotMatch(await undatedSteps.innerText(), /days? late/);
        await back();
        await caption(fact(card(reasonOnly), 'Deal kind'), 'Not recorded').waitFor();
        await caption(fact(card(reasonOnly), 'Deal reason'), 'Relocation').waitFor({ timeout: 5000 });
        await expectSearch('relocation', reasonOnly);
        await openDetail(reasonOnly);
        await caption(fact(tabRowFacts, 'Deal kind'), 'Not recorded').waitFor();
        await caption(fact(tabRowFacts, 'Deal reason'), 'Relocation').waitFor();
        await back();
        await search.clear();
        await capture(page.locator('#closedDealsList'), 'closed-list');
      }
      await capture(card(row), row.outcome);
      await openDetail(row);
      if (row === won) await caption(fact(detail.locator('#workspaceFacts'), 'Client'), won.name).waitFor({ timeout: 5000 });
      await caption(fact(tabRowFacts, 'Deal reason'), 'Renewal · Lease not recorded').waitFor({ timeout: 5000 });
      await caption(fact(tabRowFacts, 'Deal kind'), expectedType).waitFor();
      if (row === lost) {
        await caption(fact(detailFacts, 'Reason for loss'), 'Plans changed').waitFor({ timeout: 5000 });
        await caption(fact(detailFacts, 'Close date'), 'Mon, Nov 2, 2026').waitFor();
      }
      const phase = fact(detail.locator('#workspaceFacts'), 'Phase').locator('dd');
      assert.equal(await phase.textContent(), row === lost ? 'Lost' : 'Closed');
      const steps = detail.getByRole('region', { name: 'Next steps' });
      await steps.getByText('Send the sample plan', { exact: true }).waitFor({ timeout: 5000 });
      assert.match(await steps.innerText(), /Send the sample plan\s+Joe · Due Wed, Oct 21, 2026/);
      assert.match(await steps.innerText(), /Check the sample lease\s+Dell · Due Tue, Oct 20, 2026/);
      assert.doesNotMatch(await steps.innerText(), /days? late|Find the sample map/);
      await detail.getByText('Change next step', { exact: true }).click();
      assert.equal(await detail.getByText('Current next date is overdue.').isVisible(), false);
      if (row === won) {
        await detail.getByRole('button', { name: items[0].title, exact: true }).click();
        const item = page.getByRole('dialog', { name: items[0].title });
        await item.getByText('Due Oct 19', { exact: true }).waitFor();
        await item.getByRole('button', { name: 'Close item' }).click();
        await capture(steps, 'ended-steps');
      }
      await capture(detailFacts, `${row.outcome}-detail`);
      await back();
    }

    switches.add('deals-saves-from-engine');
    await page.goto(`${boardUrl}&view=list`);
    await openParked();
    await caption(card(automatic), 'Parked automatically').waitFor({ timeout: 5000 });
    const refreshedBoard = page.waitForResponse(response => revivals === 1 && response.url().endsWith('/mcp')
      && response.request().postDataJSON()?.params?.name === 'deal-room-board');
    await card(automatic).getByRole('button', { name: 'Revive', exact: true }).click();
    await page.getByText('Deal revived', { exact: true }).waitFor();
    await refreshedBoard;
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.kanban-column').getByRole('button', { name: automatic.name, exact: true }).waitFor();
    assert.equal(revivals, 1);
    assert.equal(await caption(card(automatic), 'Parked automatically').count(), 0);
  });
}

for (const width of [1440, 390]) {
  test(`switched Local Deals keeps phase counts, shows the engine's attention and retries history at ${width}px`, async t => {
    const fixture = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
    t.after(() => fixture.close());
    const { origin } = fixture;
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Europe/Paris' });
    t.after(() => page.close());
    page.setDefaultTimeout(5000);
    await page.clock.setFixedTime(new Date('2026-11-19T01:00:00Z'));
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `phase-attention-${width}`, viewer: 'joe', reset: true } });

    const makeDeal = (name, fields) => ({ id: crypto.randomUUID(), name, owner: 'joe', phase: 'research', seen: 1, attention: null, ...fields });
    const step = { id: crypto.randomUUID(), owner: 'joe', description: 'Send the floor plan', due_on: '2026-11-17' };
    const late = makeDeal('Example Late Deal', { next_step: step.description, next_date: step.due_on, open_actions: [step],
      attention: { reason: 'A next step is late.', since: '2026-11-18' } });
    const flagged = makeDeal('Example Flagged Deal', { attention: true });
    const parked = makeDeal('Example Parked Deal', { phase: 'closing', operating_state: 'parked' });
    const proposalId = crypto.randomUUID();
    let failHistoryRead = false;
    let savesOn = false;
    const env = {
      ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (savesOn && key === 'deals-saves-from-engine') ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/api/engine/deals') {
          if (failHistoryRead) return new Response(null, { status: 503 });
          return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe',
            deals: [late, flagged, parked], closed_deals: [], lost_deals: [] });
        }
        assert.equal(path, `/api/engine/deals/${late.id}`);
        return Response.json({ ...late, deal_id: late.id, next_actions: [step], email_follow_ups: [
          { proposal_id: proposalId, kind: 'next_step', what: 'Check the plan', due_on: step.due_on },
        ] });
      } },
    };
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (!['deal-room-board', 'get-deal-room', 'patch-deal-field'].includes(request.postDataJSON()?.params?.name)) return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });

    const url = `${origin}/deals?mode=live`;
    const button = name => page.getByRole('button', { name, exact: true });
    const card = deal => page.locator(`article[data-id="${deal.id}"]`);
    const date = 'Due Tue, Nov 17, 2026 · 1 day late';
    const panel = page.locator('#recordPanel');
    await page.goto(`${url}&filter=flagged`);
    await button(late.name).waitFor({ timeout: 3000 });
    assert.equal(await button(flagged.name).count(), 0, 'a stored flag is not attention');
    assert.equal(await card(late).getByText('Needs attention', { exact: true }).isVisible(), true);

    await page.goto(url);
    await card(late).getByRole('button', { name: 'Needs attention: A next step is late.', exact: true }).waitFor();
    assert.equal(await card(flagged).locator('.deal-board-attention').count(), 0);
    const phases = ['Prospective Client', 'Research', 'Site Selection', 'Negotiating', 'Legal', 'Due Diligence', 'Closing'];
    for (const name of phases) {
      assert.equal(await page.getByRole('region', { name: `${name}, ${name === 'Research' ? 2 : 0} cards`, exact: true }).isVisible(), true);
    }
    await button('Collapse Research').click();
    assert.equal(await page.getByRole('region', { name: 'Research, 2 cards', exact: true }).isVisible(), true);
    await button('Expand Research').click();
    await button('Parked').click();
    await card(parked).waitFor();
    assert.match(await page.locator('#boardLive').innerText(), /^2 open deals · 1 parked/);
    await page.locator('#kanban').screenshot({ path: join(evidence, `phase-attention-${width}-board.png`) });
    await button('List').click();
    await card(late).getByText(date, { exact: false }).waitFor();
    await button(late.name).click();
    await panel.getByRole('list', { name: 'Open steps' }).getByText(date, { exact: false }).waitFor();
    await panel.getByRole('list', { name: 'Suggested steps' }).getByText(date, { exact: false }).waitFor();
    const attention = panel.getByRole('region', { name: 'Next steps' }).getByText('Needs attention. A next step is late.', { exact: true });
    await attention.waitFor();

    savesOn = true;
    await page.reload();
    await attention.waitFor({ timeout: 3000 });
    assert.equal(await panel.getByRole('button', { name: /needs attention/i }).count(), 0, 'no partner sets or clears it');
    await page.screenshot({ path: join(evidence, `phase-attention-${width}-detail.png`) });

    for (const view of ['closed', 'lost']) {
      failHistoryRead = true;
      await page.goto(`${url}&view=${view}`);
      await page.getByText(`Could not load ${view} deals.`, { exact: true }).waitFor({ timeout: 3000 });
      assert.equal(await page.getByText(`No ${view} deals.`, { exact: true }).count(), 0);
      if (view === 'closed') await page.locator('#closedDealsView').screenshot({ path: join(evidence, `phase-attention-${width}-retry.png`) });
      failHistoryRead = false;
      await page.locator('#closedDealsView').getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByText(`No ${view} deals.`, { exact: true }).waitFor();
    }
  });
}

for (const [actor, readsOn, savesOn] of [['joe', false, false], ['joe', true, true], ['dell', true, true], ['dell', true, false]]) {
  test(`deal files and email follow-ups for ${actor} with Deals reads ${readsOn ? 'on' : 'off'} and saves ${savesOn ? 'on' : 'off'}`, async t => {
    const page = await browser.newPage({ viewport: { width: actor === 'joe' ? 1440 : 390, height: 1000 } });
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date('2026-11-18T15:00:00Z'));
    const [deal, plan, earlierPlan, letter, first, second] = Array.from({ length: 6 }, () => crypto.randomUUID());
    const namespace = `deal-file-read-${actor}-${readsOn}-${savesOn}`;
    const row = { id: deal, deal_id: deal, name: 'Example File Deal', phase: 'research', seen: 1, owner: 'joe' };
    const documents = [
      { id: plan, name: 'Example Plan.pdf', kind: 'lease', version: 2, prepared_at: '2026-11-03T14:00:00+00:00' },
      { id: letter, name: 'Example Letter.pdf', kind: 'loi', version: 1, prepared_at: '2026-11-02T14:00:00+00:00' },
      { id: earlierPlan, name: 'Example Plan.pdf', kind: 'lease', version: 1, prepared_at: '2026-11-01T14:00:00+00:00' },
    ];
    const refusals = actor === 'joe' && savesOn ? [
      ['next_step', 409, 'open_step_exists', 'You already have an open step on this deal. Finish or change it first, or dismiss this suggestion.'],
      ['file_to_deal', 400, 'database_refused_the_statement', 'This email can’t be filed on this deal. Dismiss this suggestion.'],
      ['next_step', 422, 'invalid_field_value', 'Check the suggestion and any changes you made, or dismiss it.'],
      ['phase_move', 409, 'version_conflict', 'This deal has moved since the suggestion. Dismiss it.'],
      ['phase_move', 409, 'already_decided', 'This suggestion is already gone. Reload the deal to see what remains.'],
    ].map(([kind, status, error, hint], index) => ({
      kind, status, error, hint, id: crypto.randomUUID(), title: `Review example decision ${index + 1}`,
    })) : [];
    const planTitle = 'Review the floor plan with Casey';
    const letterTitle = "Choose the deal for Morgan Example's email";
    const filedEmail = { activity_id: crypto.randomUUID(), kind: 'email', subject: actor === 'joe' ? '(no subject)' : '',
      sender_name: 'Example Sender', happened_at: '2026-11-01T14:00:00+00:00',
      summary: 'Email from Example Sender <sender@example.test>: (no subject)' };
    let email_follow_ups = [
      { proposal_id: first, kind: 'next_step', title: planTitle, what: 'Send the plan (no subject)', owner: 'dell', due_on: '2026-11-02', email: filedEmail,
        evidence: 'Email from the surveyor: the new plan is ready.\nMorgan <team@example.test> and "Example Sender" <sender@example.test> will review it with Casey casey@example.test on Friday and send their comments.' },
      { proposal_id: crypto.randomUUID(), kind: 'file_to_deal', email: filedEmail },
      { proposal_id: second, kind: 'file_to_deal', title: letterTitle,
        email: { subject: 'Re: Letter attached for "Morgan Example" <morgan@example.test> and Casey <casey@example.test> with Alex alex@example.test and Plan Desk "plans@west"@example.test copied',
          sender: 'Morgan Example <sender@example.test>', happened_at: '2026-11-02T15:00:00Z', summary: 'The letter is attached.' } },
      { proposal_id: crypto.randomUUID(), kind: 'next_step', what: 'Email sample@example.test for the plan',
        email: { subject: 'Updated plan for sample@example.test' } },
      { proposal_id: crypto.randomUUID(), kind: 'file_to_deal',
        email: { subject: 'sender@example.test' } },
      ...refusals.map(({ kind, id, title }) => ({
        proposal_id: id, kind, title, what: 'Review the example', to_phase: 'legal', email: { sender: 'sender@example.test' },
      })),
    ];
    const completed = { id: 'executed_lease', label: 'Executed lease', status: 'complete', due_on: null,
      evidence_ref: 'Example Plan.pdf', source: { document: 'lease-guide' } };
    const overdue = { id: `critical-date:${first}`, label: 'lease end', status: 'overdue', due_on: '2026-11-14',
      evidence_ref: 'Example option notice', source: { record_verb: 'add-critical-date' } };
    const checklist = { schema_version: 'deal-checklist.v1', template_state: 'current',
      phases: [{ id: 'legal', label: 'Legal / lease', items: [completed, overdue] }], due_items: [overdue] };
    const carr = [], opened = [], decisions = [];
    const bytes = Buffer.from('%PDF-1.7 synthetic revised plan');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const writes = [], uploads = [], uploadRequests = [];
    const revised = { id: crypto.randomUUID(), name: 'Revised plan.pdf', kind: 'lease', version: 3 };
    const env = {
      ENGINE_ROUTING: { get: async key => ({ 'deals-from-engine': readsOn, 'deals-saves-from-engine': savesOn })[key] ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/api/engine/deals') {
          const partner = request.headers.get('cookie')?.includes(`fixture.${namespace}.dell`) ? 'dell' : 'joe';
          return Response.json({ schema_version: 'local-deals-board.v2', actor: partner, deals: [row] });
        }
        if (path === `/api/engine/deals/${deal}`) return Response.json({ ...row, checklist, documents, email_follow_ups, correspondence: [filedEmail] });
        if (path === `/api/engine/files/${hash}`) {
          assert.equal(request.method, 'PUT');
          assert.ok(request.headers.get('x-carr-csrf'));
          assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
          uploads.push(hash);
          return Response.json({ sha256: hash }, { status: uploads.length === 1 ? 201 : 200 });
        }
        if (path === `/api/engine/deals/${deal}/documents`) {
          assert.equal(request.method, 'POST');
          assert.ok(request.headers.get('x-carr-csrf'));
          assert.equal(uploads.length, writes.length + 1);
          const body = await request.json();
          assert.match(body.idempotency_key, /^[\da-f-]{36}$/);
          writes.push(body);
          if (writes.length === 1) {
            documents.unshift(revised);
            if (actor === 'dell') return Response.json({ document_id: revised.id, deal_id: deal }, { status: 201 });
            return Response.json({ error: 'engine_unavailable' }, { status: 503 });
          }
          if (body.kind !== revised.kind) return Response.json({ error: 'already_filed', document_id: revised.id }, { status: 409 });
          return Response.json({ document_id: revised.id, deal_id: deal, replayed: true });
        }
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
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace, viewer: actor, reset: true } });
    const routeThroughWorker = async route => {
      const request = route.request();
      if (new URL(request.url()).pathname.startsWith('/api/engine/files/')) uploadRequests.push(request.url());
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    };
    async function routeEngine(target) {
      await target.route('**/api/engine/documents/*', routeThroughWorker);
      await target.route('**/api/engine/files/*', routeThroughWorker);
      await target.route('**/api/engine/deals/*/documents', routeThroughWorker);
      await target.route('**/mcp', route => [
        'deal-room-board', 'get-deal-room', 'list-deal-documents', 'list-email-proposals', 'decide-engine-deal-email',
      ].includes(route.request().postDataJSON()?.params?.name) ? routeThroughWorker(route) : route.continue());
    }
    await routeEngine(page);

    const fromBoard = actor === 'dell' && savesOn;
    await page.goto(`${origin}/deals?mode=live${fromBoard ? '' : `&deal=${deal}`}`);
    if (fromBoard) await page.locator('.kanban-column').getByRole('button', { name: row.name, exact: true }).click();
    const followups = page.getByRole('region', { name: readsOn ? 'Next steps' : 'Email follow-ups' });
    if (!readsOn) await followups.getByText('No email follow-ups.', { exact: true }).waitFor({ timeout: 5000 });
    if (readsOn) {
      const suggested = followups.getByRole('list', { name: 'Suggested steps' });
      const planCard = suggested.getByRole('listitem').filter({ hasText: 'Send the plan' });
      await planCard.getByText(/^From Example's email, Sun, Nov 1/).waitFor({ timeout: 5000 });
      assert.deepEqual((await suggested.getByRole('heading', { level: 3 }).allTextContents()).slice(0, 4),
        [planTitle, letterTitle, 'Updated plan for', 'Email follow-up']);
      const letterCard = suggested.getByRole('listitem').filter({ hasText: 'The letter is attached.' });
      assert.equal(await planCard.count(), 1);
      assert.doesNotMatch(await planCard.innerText(), /File email to this deal/);
      assert.match(await letterCard.innerText(), /File email to this deal/);
      assert.doesNotMatch(await letterCard.innerText(), /Re: Letter attached/);
      assert.match(await letterCard.innerText(), /From Morgan's email, Mon, Nov 2/);
      assert.deepEqual({
        opening: await planCard.getByRole('heading').innerText(),
        excerpt: await planCard.locator('.deal-suggestion-email').innerText(),
        subject: await letterCard.getByRole('heading').innerText(),
        summary: await letterCard.getByText('The letter is attached.', { exact: true }).count(),
      }, {
        opening: planTitle,
        excerpt: 'Email from the surveyor: the new plan is ready. Morgan and Example Sender will review it with Casey on Friday and send their comments.',
        subject: letterTitle,
        summary: 1,
      });
      assert.doesNotMatch(await followups.innerText(), /@example\.test/);
      assert.match(await followups.innerText(), /Send the plan \(No subject\).*Dell.*16 days late/);
      assert.doesNotMatch(await planCard.innerText(), /\(no subject\)/);
      assert.doesNotMatch(await followups.innerText(), /2026-11-01T|file_to_deal/);
      const path = page.getByRole('region', { name: 'Deal path' });
      const lease = path.locator('[data-todo="executed_lease"]');
      assert.equal(await lease.getAttribute('data-state'), 'done');
      await lease.getByText('Executed lease', { exact: true }).click();
      await lease.getByText('Example Plan.pdf', { exact: true }).waitFor();
      assert.equal(await path.getByText('lease end', { exact: true }).count(), 0, 'a critical date shows in its own row');
      await path.screenshot({ path: join(evidence, `engine-checklist-${actor}.png`) });
      if (savesOn) {
        await followups.evaluate(element => element.scrollIntoView({ block: 'end' }));
        await followups.screenshot({ path: join(evidence, `engine-followups-${actor}.png`) });
        await planCard.getByRole('button', { name: 'Edit', exact: true }).click();
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
          const card = suggested.getByRole('listitem').filter({ hasText: refusal.title });
          await card.getByRole('button', { name: 'Accept', exact: true }).click();
          const receipt = page.locator('#receiptDock .receipt').filter({ hasText: refusal.hint });
          await receipt.waitFor();
          assert.equal(await receipt.getByRole('button', { name: 'Try again' }).count(), 0);
          const reload = receipt.getByRole('button', { name: 'Reload deal' });
          if (refusal.error === 'already_decided') await reload.click();
          else {
            assert.equal(await reload.count(), 0);
            if (refusal.kind === 'next_step') {
              await card.getByRole('button', { name: 'Edit', exact: true }).click();
              await card.getByLabel('Next step', { exact: true }).fill('');
            }
            await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
          }
          await card.waitFor({ state: 'detached' });
          if (refusal.error !== 'already_decided') assert.deepEqual(decisions.at(-1), [refusal.id, 'dismiss', undefined]);
        }
        for (const title of ['Updated plan for', 'Email follow-up']) {
          const card = suggested.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
          await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
          await card.waitFor({ state: 'detached' });
        }
        await suggested.waitFor({ state: 'detached' });
      } else assert.equal(await suggested.getByRole('button').count(), 0);
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
      const upload = tab.getByRole('button', { name: 'Upload to this deal', exact: true });
      if (savesOn) {
        await upload.waitFor({ timeout: 5000 });
        const type = tab.getByLabel('Document type');
        const replaces = tab.getByLabel('Replaces');
        const file = tab.getByLabel('File', { exact: true });
        await type.selectOption({ label: 'Lease' });
        await file.setInputFiles({ name: 'Large plan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
        await upload.click();
        await tab.getByText('Choose a file no larger than 25 MB.', { exact: true }).waitFor({ timeout: 5000 });
        assert.deepEqual(uploadRequests, []);

        await file.setInputFiles({ name: 'Phone photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('synthetic photo') });
        await upload.click();
        await tab.getByText('Choose a PDF, Word, Excel or PowerPoint file.', { exact: true }).waitFor({ timeout: 5000 });
        assert.deepEqual(uploadRequests, []);
        assert.equal(await file.getAttribute('accept'), '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx');
        await tab.getByText('PDF, Word, Excel or PowerPoint · Up to 25 MB', { exact: true }).waitFor();

        await file.setInputFiles({ name: revised.name, mimeType: 'application/pdf', buffer: bytes });
        await tab.getByText('Choose a PDF, Word, Excel or PowerPoint file.', { exact: true }).waitFor({ state: 'hidden' });
        const back = page.getByRole('button', { name: 'Back to deals', exact: true });
        const canceled = page.waitForEvent('dialog', { timeout: 5000 }).then(async dialog => {
          const message = dialog.message();
          await dialog.dismiss();
          assert.equal(message, 'Leave this deal and discard the selected file?');
        });
        await Promise.all([canceled, back.click()]);
        assert.equal(await file.evaluate(input => input.files[0]?.name), revised.name);
        assert.deepEqual(await replaces.locator('option').allTextContents(), ['None', 'Example Plan.pdf · Version 2', 'Example Plan.pdf · Version 1']);
        await replaces.selectOption(plan);
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: join(evidence, `engine-upload-${actor}.png`) });
        await upload.click();
        if (actor === 'joe') {
          await tab.getByText('Could not confirm the upload. Try again.').waitFor();
          await upload.click();
        }
        await tab.getByRole('link', { name: 'Revised plan.pdf, Version 3' }).waitFor();
        const [firstWrite, replay] = writes;
        assert.deepEqual(firstWrite, { idempotency_key: firstWrite.idempotency_key, sha256: hash, name: revised.name, kind: 'lease', supersedes_id: plan });
        if (actor === 'joe') assert.deepEqual(replay, firstWrite);
        const other = await browser.newPage({ viewport: page.viewportSize() });
        t.after(() => other.close());
        const otherActor = actor === 'joe' ? 'dell' : 'joe';
        await other.request.post(`${origin}/api/test/seed`, { data: { namespace, viewer: otherActor } });
        await routeEngine(other);
        await other.goto(`${origin}/deals?deal=${deal}&mode=live`);
        await other.getByRole('tab', { name: 'Documents', exact: true }).click();
        await other.getByRole('link', { name: 'Revised plan.pdf, Version 3' }).waitFor();
        await page.reload();
        await page.getByRole('tab', { name: 'Documents', exact: true }).click();
        await tab.getByRole('link', { name: 'Revised plan.pdf, Version 3' }).waitFor();
        assert.equal(await tab.getByRole('link', { name: 'Example Plan.pdf, Version 2' }).count(), 1);
        await tab.getByLabel('File', { exact: true }).setInputFiles({ name: revised.name, mimeType: 'application/pdf', buffer: bytes });
        await type.selectOption({ label: 'LOI' });
        await upload.click();
        await tab.getByText('This file is already on this deal as Revised plan.pdf.').waitFor();
        assert.equal(writes.at(-1).supersedes_id, undefined);
        await tab.screenshot({ path: join(evidence, `engine-documents-${actor}.png`) });
        const confirmed = page.waitForEvent('dialog', { timeout: 5000 }).then(dialog => dialog.accept());
        await Promise.all([confirmed, fromBoard ? page.evaluate(() => history.back()) : back.click()]);
        await tab.waitFor({ state: 'hidden' });
        assert.equal(new URL(page.url()).searchParams.get('deal'), null);
      } else {
        assert.equal(await upload.count(), 0);
        await tab.screenshot({ path: join(evidence, `engine-documents-${actor}.png`) });
      }
    } else {
      await tab.getByText('No documents filed for this deal.').waitFor();
      assert.ok(carr.includes('list-deal-documents'));
      assert.ok(carr.includes('list-email-proposals'));
      assert.deepEqual(opened, []);
    }
  });
}
after(async () => {
  Reflect.deleteProperty(globalThis, 'HTMLRewriter');
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
    titleFontSize: parseFloat(getComputedStyle(document.getElementById('panelTitle')).fontSize),
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
  await page.evaluate(() => { document.getElementById('appMainSlot').scrollTo(0,220); scrollTo(0,220); });
  await page.screenshot({ path: join(evidence, `${width}-${theme}-scrolled.png`), animations: 'disabled' });
  const titleHitTest = await page.locator('#panelTitle').evaluate(title => {
    const range = document.createRange(); range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const shown = title.getBoundingClientRect().right;
    const hits = [...range.getClientRects()].flatMap(({left, right, top, bottom}) => [left + 1, (left + Math.min(right, shown)) / 2, Math.min(right, shown) - 1].map(x => {
      const hit = document.elementFromPoint(x, (top + bottom) / 2);
      return {x, visible: hit === title || title.contains(hit)};
    }));
    return {scrollTop: scrollY + document.getElementById('appMainSlot').scrollTop, text: text.toJSON(), hits};
  });
  await writeFile(join(evidence, `${width}-${theme}-hit-test.json`), JSON.stringify({...titleHitTest, header}, null, 2));
  assert.ok(titleHitTest.scrollTop > 100, 'exercise the sticky header after scrolling');
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

for (const width of [1440, 390]) {
  test(`Board shows the engine's attention and detail labels both next steps at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Los_Angeles' });
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date('2026-11-19T06:30:00Z'));
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `owner-next-step-${width}`, viewer: 'joe', reset: true } });
    const ownerStep = { id: crypto.randomUUID(), change_id: 33, owner: 'dell', description: 'Send the floor plan', due_on: '2026-11-18' };
    const otherStep = { id: crypto.randomUUID(), change_id: 77, owner: 'joe', description: 'Call the architect', due_on: '2026-11-15' };
    const item = { id: crypto.randomUUID(), title: 'Check the plans', status: 'open', due_on: '2026-11-18', bullets: [] };
    const deal = { id: '00000000-0000-4000-8000-000000000080', name: 'Example Two-Partner Deal',
      owner: 'dell', phase: 'research', seen: 1, open_actions: [otherStep, ownerStep],
      attention: { reason: 'A next step is late.', since: '2026-11-19' },
      items: [item, { id: crypto.randomUUID(), title: 'Review the layout', status: 'open', due_on: null, bullets: [] }],
      next_step: otherStep.description, next_date: otherStep.due_on,
      phase_change: { source: 'copied', automatic: true, event_id: crypto.randomUUID(), prior_phase: 'pending', evidence_date: '2026-11-16' },
      last_step: { summary: 'Reviewed the example offer', occurred_at: '2026-11-17T18:00:00Z' } };
    const checklistOnly = { ...deal, id: '00000000-0000-4000-8000-000000000081', name: 'Example Checklist Deal', attention: null,
      next_step: 'Check the plans', open_actions: [], phase_change: null, items: [
        { id: 'example-checklist-item', title: 'Check the plans', status: 'open', due_on: otherStep.due_on, bullets: [] },
      ] };
    const singleStep = { ...deal, id: '00000000-0000-4000-8000-000000000082', name: 'Example One-Step Deal',
      open_actions: [otherStep], attention: null };
    const flagged = { ...checklistOnly, id: crypto.randomUUID(), name: 'Example Flagged Deal', attention: true };
    const parkedDeal = { ...checklistOnly, id: crypto.randomUUID(), name: 'Example A Parked Deal',
      operating_state: 'parked', parking_reason: 'client_paused', parked_automatically: true };
    const account = crypto.randomUUID();
    const national = { ...deal, id: crypto.randomUUID(), name: 'Example Location Deal', items: [item],
      account_client_id: account, workspace_kind: 'national_account' };
    const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [parkedDeal, deal, checklistOnly, singleStep, flagged, national],
      accounts: [{ account_client_id: account, account_name: 'Example Account', account_owner: 'dell' }] };
    const writes = [], moves = [];
    const steps = new Map([deal, national].map(row => [row.id, structuredClone(row.open_actions)]));
    const env = {
      ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === `/api/engine/deals/${deal.id}/changes`) {
          const body = await request.json();
          moves.push(body.phase);
          deal.phase = body.phase.to;
          return Response.json({ deal_id: deal.id, change_id: ++deal.seen });
        }
        if (request.method === 'POST') {
          assert.equal(path, '/api/engine/next-steps');
          const body = await request.json();
          writes.push(body);
          const own = steps.get(body.deal_id)[0];
          if (body.seen_current_step?.next_step_id !== own.id || body.seen_current_step?.change_id !== own.change_id)
            return Response.json({ error: 'version_conflict' }, { status: 409 });
          Object.assign(own, { description: body.what, due_on: body.due_on, change_id: own.change_id + 1 });
          return Response.json({ next_step_id: crypto.randomUUID(), change_id: own.change_id }, { status: 201 });
        }
        if (path === '/api/engine/deals') return Response.json(board);
        const row = board.deals.find(row => path === `/api/engine/deals/${row.id}`);
        return Response.json({ ...row, deal_id: row.id, email_follow_ups: [],
          next_actions: [...steps.get(row.id).map(action => ({ ...action, status: 'open' })),
            { ...item, owner: 'joe', description: item.title, change_id: 45 }] });
      } },
    };
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (!['deal-room-board', 'get-deal-room', 'set-next-step', 'add-deal-note', 'patch-deal-field'].includes(request.postDataJSON()?.params?.name)) return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });

    await page.goto(`${origin}/deals?mode=live`);
    for (const view of ['Board', 'List']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      const card = page.locator(`article[data-id="${deal.id}"]`);
      await card.waitFor({ timeout: 5000 });
      const visibleText = await card.innerText();
      const empty = page.locator(`article[data-id="${checklistOnly.id}"]`);
      const onlyStep = page.locator(`article[data-id="${singleStep.id}"]`);
      if (view === 'Board') {
        assert.equal(visibleText.replace(/\s+/g, ' '), `${deal.name} Needs attention D Owner: Dell`);
        assert.equal(await card.getByRole('button', { name: 'Needs attention: A next step is late.', exact: true }).count(), 1);
        assert.equal((await empty.innerText()).replace(/\s+/g, ' '), `${checklistOnly.name} D Owner: Dell`);
        assert.equal((await onlyStep.innerText()).replace(/\s+/g, ' '), `${singleStep.name} D Owner: Dell`);
        const flaggedCard = page.locator(`article[data-id="${flagged.id}"]`);
        assert.equal((await flaggedCard.innerText()).replace(/\s+/g, ' '), `${flagged.name} D Owner: Dell`, 'a stored flag is not attention');
      } else {
        assert.match(visibleText, /Send the floor plan.*Due Wed, Nov 18.*1 day late/);
        assert.doesNotMatch(visibleText, /Call the architect|\d+ days late|overdue|Still needed|Last:/);
        assert.equal(await card.locator('.auto-move time').innerText(), 'Mon, Nov 16, 2026');
        assert.equal(await card.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
        assert.match(await empty.innerText(), /No next step set/);
        assert.match(await onlyStep.innerText(), /Call the architect.*Due Sun, Nov 15/);
      }
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth));
      await card.screenshot({ path: join(evidence, `owner-next-step-${width}-${view.toLowerCase()}.png`) });
      const parked = page.locator(`#kanban [data-id="${parkedDeal.id}"]`);
      assert.equal(await parked.isVisible(), false);
      if (view === 'List') {
        await page.getByRole('button', { name: 'Parked', exact: true }).click();
        const group = page.getByRole('region', { name: 'Parked · 1' });
        assert.equal(await group.getByRole('button', { name: parkedDeal.name, exact: true }).isVisible(), true);
        assert.equal(await parked.getByRole('button', { name: 'Revive', exact: true }).isVisible(), true);
        assert.equal(await parked.count(), 1);
        assert.equal(await page.locator('#kanban .deal-row').last().getAttribute('data-id'), parkedDeal.id);
        assert.equal(await page.locator('.deal-list-head').textContent(), 'DealPhaseNext stepOwner');
        await group.screenshot({ path: join(evidence, `parked-list-${width}.png`) });
        await page.getByRole('button', { name: 'Parked', exact: true }).click();
        assert.equal(await parked.isVisible(), false);
      }
    }
    await page.getByRole('button', { name: deal.name, exact: true }).click();
    const snapshot = page.getByRole('region', { name: 'Deal snapshot' });
    for (const description of [ownerStep.description, otherStep.description]) {
      const visibleStep = snapshot.getByText(description, { exact: false });
      await visibleStep.waitFor();
      assert.equal(await visibleStep.count(), 1);
    }
    const stepRows = snapshot.getByRole('list', { name: 'Open steps' }).getByRole('listitem');
    assert.match(await stepRows.first().innerText(), /Send the floor plan\s+Dell · Due Wed, Nov 18, 2026 · 1 day late/);
    assert.match(await stepRows.nth(1).innerText(), /Call the architect\s+Joe · Due Sun, Nov 15, 2026 · 4 days late/);
    assert.equal(await page.getByRole('region', { name: 'Deal path' }).getByRole('button', { name: 'Undo', exact: true }).isVisible(), true);
    assert.equal(await snapshot.getByText('Also open:', { exact: true }).count(), 0);
    const task = snapshot.getByRole('listitem').filter({ hasText: item.title });
    assert.match(await task.innerText(), /Check the plans.*Joe.*Wed, Nov 18, 2026/s);
    assert.match(await snapshot.getByRole('listitem').filter({ hasText: 'Review the layout' }).innerText(),
      /Owner not recorded.*No due date/s);
    assert.deepEqual(await page.locator('#detailOwner option').allTextContents(), ['Joe', 'Dell']);
    await snapshot.screenshot({ path: join(evidence, `owner-next-step-${width}-detail.png`) });
    await task.getByRole('button', { name: item.title, exact: true }).click();
    const itemDialog = page.getByRole('dialog', { name: item.title });
    await itemDialog.getByRole('button', { name: 'Mark done' }).waitFor();
    await itemDialog.getByRole('button', { name: 'Close item' }).click();

    const discard = page.getByRole('button', { name: 'Discard draft', exact: true });
    assert.equal(await discard.count(), 0);
    assert.equal(await page.getByLabel('Update', { exact: true }).count(), 0);
    await page.getByText('Add step', { exact: true }).click({ timeout: 3000 });
    const localStep = page.getByLabel('Your next step', { exact: true });
    assert.equal(await localStep.inputValue(), otherStep.description);
    await localStep.fill('Unsaved step');
    await discard.click();
    assert.equal(await localStep.inputValue(), otherStep.description);
    assert.equal(await discard.count(), 0);
    await localStep.fill('Confirm the plan');
    await page.getByLabel('Next date', { exact: true }).fill('2026-11-23');
    await page.locator('#detailUpdateForm').screenshot({ path: join(evidence, `owner-next-step-${width}-local-editor.png`) });
    await page.getByRole('button', { name: 'Save next step', exact: true }).click();
    await page.getByText('Next step saved.', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].due_on, '2026-11-23');
    assert.deepEqual(writes[0].seen_current_step, { next_step_id: otherStep.id, change_id: 77 });
    assert.deepEqual(steps.get(deal.id)[1], ownerStep);
    await snapshot.getByText('Confirm the plan', { exact: false }).waitFor();

    await page.goto(`${origin}/deals?view=national&mode=live`);
    assert.equal(await page.title(), 'Deals · DoctorCRE');
    await page.getByRole('button', { name: /Example Account/ }).click();
    const nationalRow = page.locator(`[data-deal-id="${national.id}"]`);
    assert.equal(await nationalRow.locator('.deal-items li').getAttribute('data-overdue'), 'true');
    await nationalRow.locator('[data-next-step]').click();
    const nationalStep = page.locator('#stepText');
    await nationalStep.waitFor();
    assert.equal(await nationalStep.inputValue(), otherStep.description);
    await nationalStep.fill('Ask for the updated plan');
    const current = steps.get(national.id)[0];
    Object.assign(current, { description: 'Send the newest plan', change_id: 78 });
    const save = page.getByRole('button', { name: 'Set next step', exact: true });
    await save.click();
    await page.getByText(/The next step changed/).waitFor();
    assert.equal(await nationalStep.inputValue(), 'Ask for the updated plan');
    assert.deepEqual(writes[1].seen_current_step, { next_step_id: otherStep.id, change_id: 77 });
    await page.getByRole('button', { name: 'Review current values' }).click();
    await page.locator('#formDialog').screenshot({ path: join(evidence, `owner-next-step-${width}-national-editor.png`) });
    await save.click();
    await page.getByText(/Next step confirmed/).waitFor();
    assert.deepEqual(writes[2].seen_current_step, { next_step_id: otherStep.id, change_id: 78 });
    assert.equal(current.description, 'Ask for the updated plan');
    assert.deepEqual(steps.get(national.id)[1], ownerStep);

    await nationalRow.locator('[data-next-step]').click();
    await nationalStep.waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    Object.assign(current, { description: 'Confirm the lender meeting', due_on: '2026-11-24', change_id: 90 });
    await nationalRow.locator('[data-next-step]').click();
    await nationalStep.waitFor();
    assert.equal(await nationalStep.inputValue(), 'Confirm the lender meeting');
    assert.equal(await page.locator('#stepDate').inputValue(), '2026-11-24');
    await nationalStep.fill('Confirm the meeting time');
    await save.click();
    await page.locator('#formDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(writes[3].seen_current_step, { next_step_id: otherStep.id, change_id: 90 });
    assert.equal(current.description, 'Confirm the meeting time');

    await page.goto(`${origin}/deals?deal=${deal.id}&mode=live`);
    const path = page.getByRole('region', { name: 'Deal path' });
    await path.getByRole('button', { name: 'Legal', exact: true }).click({ timeout: 10000 });
    await path.getByRole('button', { name: 'Move to Legal' }).click();
    await page.waitForFunction(() => !document.querySelector('.deal-path-ask'));
    assert.deepEqual(moves, [{ from: 'research', to: 'legal' }]);
    assert.equal(writes.length, 4, 'a phase move saves no next step');
  });
}

test('Undoing an invoice close restores late steps to the deal page', async t => {
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

  const steps = page.getByRole('list', { name: 'Open steps' });
  const undo = page.getByRole('button', { name: 'Undo invoice close' });
  const openClosedDeal = async () => {
    await page.goto(`${origin}/deals?mode=live`);
    await page.getByRole('button', { name: 'Closed deals', exact: true }).click();
    if (switchesOn) {
      await page.locator('#closedDealsList .auto-move').getByText('Tue, Nov 17, 2026', { exact: true }).waitFor({ timeout: 3000 });
    }
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    const endedSteps = page.getByRole('region', { name: 'Open before this deal ended' });
    await endedSteps.getByRole('listitem').filter({ hasText: 'Call the architect' }).getByText('Mon, Nov 16, 2026').waitFor({ timeout: 5000 });
    assert.doesNotMatch(await endedSteps.innerText(), /days? late|Overdue/);
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
  await steps.getByText('Call the architect again').waitFor();
  await undo.click();
  await page.locator('.deal-path [aria-current="step"][data-phase="legal"]').waitFor();
  assert.equal(await page.locator('#detailPhase').count(), 0);
  await steps.getByRole('listitem').filter({ hasText: 'Call the architect again' }).getByText(/2 days late/).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Open before this deal ended' }).count(), 0);
  assert.equal(await undo.count(), 0);
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).waitFor();
  assert.notEqual(undoRequests[0].idempotency_key, undoRequests[1].idempotency_key);
  assert.deepEqual(oldReads, []);
});

for (const width of [1440, 390]) test(`a fresh automatic call move shows its evidence and can be undone at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo' });
  t.after(() => page.close());
  await page.clock.setFixedTime(new Date('2026-11-19T18:00:00Z'));
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `call-move-${width}`, viewer: 'joe', reset: true } });
  const receipt = { source: 'call_capture', automatic: true, event_id: crypto.randomUUID(), phase: 'legal',
    prior_phase: 'research', reason: null, evidence_date: '2026-10-19', recorded_at: '2026-10-21T00:00:00Z',
    call: { activity_id: crypto.randomUUID(), happened_at: '2026-10-19T02:30:00Z' } };
  const deal = { id: crypto.randomUUID(), name: 'Example Clinic Move', owner: 'joe', phase: 'legal', seen: 23, phase_change: receipt };
  const partner = { ...deal, id: crypto.randomUUID(), name: 'Example Partner Move', phase_change: null };
  const board = () => ({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [deal, partner] });
  let savesOn = false;
  const writes = [];
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (savesOn && key === 'deals-saves-from-engine') ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/deals') return Response.json(board());
      if (request.method === 'GET') {
        const row = [deal, partner].find(item => path === `/api/engine/deals/${item.id}`);
        assert.ok(row);
        return Response.json({ ...row, deal_id: row.id, email_follow_ups: [], seen: row.seen + 1 });
      }
      assert.equal(path, `/api/engine/deals/${deal.id}/phase/undo`);
      writes.push(await request.json());
      Object.assign(deal, { phase: 'research', phase_change: null, seen: 25 });
      return Response.json({ deal_id: deal.id, phase: deal.phase, phase_changed_at: '2026-11-18T18:00:00Z' });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'get-deal-room', 'undo-automatic-phase-move'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  const caption = scope => scope.locator('.auto-move');
  const undo = scope => scope.getByRole('button', { name: 'Undo', exact: true });
  const hasCall = async scope => {
    const mark = caption(scope);
    await mark.getByText('Moved automatically', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await mark.count(), 1);
    assert.equal(await mark.locator('time[datetime="2026-10-19"]').innerText(), 'Mon, Oct 19, 2026');
    assert.match(await mark.innerText(), /Oct 18, 9:30 PM/);
  };
  const card = page.locator(`.kanban-card[data-id="${deal.id}"]`);
  const snapshot = page.getByRole('region', { name: 'Deal path' });
  await page.goto(`${origin}/deals?mode=live`);
  await card.waitFor();
  assert.equal(await caption(card).count(), 0);
  await card.getByRole('button', { name: deal.name, exact: true }).click();
  await hasCall(snapshot);
  assert.equal(await undo(snapshot).count(), 0);

  savesOn = true;
  await page.goto(`${origin}/deals?mode=live`);
  await card.waitFor();
  assert.equal(await caption(card).count(), 0);
  assert.equal(await caption(page.locator(`.kanban-card[data-id="${partner.id}"]`)).count(), 0);
  await card.screenshot({ path: join(evidence, `call-move-board-${width}.png`) });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.locator(`.deal-row[data-id="${deal.id}"]`);
  await hasCall(row);
  assert.equal(await undo(row).count(), 0);
  await row.getByRole('button', { name: deal.name, exact: true }).click();
  await hasCall(snapshot);
  await undo(snapshot).waitFor();
  await snapshot.screenshot({ path: join(evidence, `call-move-detail-${width}.png`) });
  await undo(snapshot).press('Enter');
  await caption(snapshot).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await page.locator('.deal-path [aria-current]').getAttribute('data-phase'), 'research');
  assert.equal(writes.length, 1);
  assert.match(writes[0].idempotency_key, /^[a-f\d-]{36}$/i);
  assert.deepEqual(writes[0], { idempotency_key: writes[0].idempotency_key, event_id: receipt.event_id, base_version: 24 });
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  assert.equal(await card.locator('xpath=ancestor::*[@data-column]').getAttribute('data-column'), 'research');
  assert.equal(await caption(card).count(), 0);
});

test('keyboard Undo on the deal page returns the deal to the previous phase', async t => {
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'automatic-phase-undo', viewer: 'joe', reset: true } });
  const row = (name, prior_phase = 'research', automatic = true) => ({
    id: crypto.randomUUID(), name, owner: 'joe', phase: 'legal', seen: 23,
    phase_change: { source: 'copied', automatic, event_id: crypto.randomUUID(), phase: 'legal', prior_phase,
      evidence_date: '2026-10-19', recorded_at: '2026-10-20T00:00:00Z' },
  });
  const success = row('Example Restored Deal');
  Object.assign(success.phase_change, {
    source: 'call_capture', call: { activity_id: crypto.randomUUID(), happened_at: '2026-10-19T15:00:00Z' },
  });
  const closed = row('Example Formerly Closed Deal', 'closed');
  const lost = row('Example Formerly Lost Deal', 'dead');
  const invoiced = row('Example Formerly Invoiced Deal', 'invoiced');
  const refused = row('Example Refused Undo Deal');
  const stale = row('Example Changed Deal');
  const staleRefresh = Promise.withResolvers();
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
        if (deal === stale && !deal.phase_change) await staleRefresh.promise;
        return Response.json({ ...deal, deal_id: deal.id, email_follow_ups: [] });
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
  const snapshot = page.getByRole('region', { name: 'Deal path' });
  const undo = snapshot.getByRole('button', { name: 'Undo', exact: true });
  const open = deal => card(deal).getByRole('button', { name: deal.name, exact: true }).click();
  const back = () => page.getByRole('button', { name: 'Back to deals' }).click();
  for (const keys of [[], ['deals-from-engine'], ['deals-from-engine', 'deals-saves-from-engine']]) {
    switches = new Set(keys);
    await page.goto(`${origin}/deals?mode=live`);
    await card(success).waitFor();
    assert.equal(await card(success).getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  }
  assert.ok(oldReads.length);
  oldReads.length = 0;
  await open(manual);
  await snapshot.waitFor();
  assert.equal(await snapshot.getByText('Moved automatically', { exact: true }).count(), 0);
  assert.equal(await undo.count(), 0);
  await back();
  await open(success);
  await snapshot.getByText('Moved automatically', { exact: true }).waitFor();
  assert.equal(await snapshot.locator('time[datetime="2026-10-19"]').textContent(), 'Mon, Oct 19, 2026');
  await undo.press('Enter');
  await page.waitForFunction(() => document.querySelector('.deal-path [aria-current]')?.dataset.phase === 'research');
  const restored = page.locator('[data-column="research"]').getByRole('button', { name: success.name, exact: true });
  await back();
  await restored.waitFor();
  assert.equal(await card(success).count(), 1);
  assert.equal(await restored.evaluate(node => node === document.activeElement || node.closest('article') === document.activeElement), true);

  const refusal = snapshot.getByText('Undo would return this deal to Closed deals or Lost deals.', { exact: true });
  for (const deal of [closed, lost, invoiced, refused]) {
    await open(deal);
    if (deal === refused) await undo.click();
    await refusal.waitFor();
    assert.equal(await undo.count(), 0, deal.name);
    assert.equal(await page.locator('.deal-path [aria-current]').getAttribute('data-phase'), 'legal');
    await back();
  }
  await open(stale);
  const refreshed = snapshot.getByText('This deal changed. The deal page was refreshed.', { exact: true });
  try {
    await Promise.all([
      page.waitForRequest(request => {
        const params = request.method() === 'POST' && request.postDataJSON()?.params;
        return !stale.phase_change && params?.name === 'get-deal-room' && params.arguments.deal === stale.id;
      }),
      undo.press('Space'),
    ]);
    assert.deepEqual({ notices: await refreshed.count(), undoEnabled: await undo.isEnabled() }, { notices: 0, undoEnabled: false });
  } finally {
    staleRefresh.resolve();
  }
  await refreshed.waitFor();
  assert.equal(await undo.count(), 0);
  assert.equal(await page.locator('.deal-path [aria-current]').getAttribute('data-phase'), 'negotiation');
  await page.screenshot({ path: join(evidence, 'automatic-phase-undo.png') });
  await back();
  await page.locator('[data-column="negotiation"]').getByRole('button', { name: stale.name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await open(parked);
  await undo.click();
  await snapshot.getByText('Moved automatically', { exact: true }).waitFor({ state: 'detached' });
  await back();
  assert.equal(await card(parked).count(), 1);
  assert.equal(writes.length, 4);
  assert.equal(new Set(writes).size, 4);
  await restored.click();
  await page.getByRole('heading', { name: success.name, exact: true }).waitFor();
  assert.deepEqual(oldReads, []);
});

async function openDealForUndoConflict(t, { archived = false } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'undo-refresh-conflict', viewer: 'joe', reset: true } });
  const id = crypto.randomUUID();
  const name = 'Example Undo Refresh Deal';
  const eventId = crypto.randomUUID();
  let changed = false;
  let unavailable = false;
  let nextDetail;
  const deal = () => ({ id, deal_id: id, name, owner: 'joe', seen: changed ? 24 : 23,
    phase: changed ? 'negotiation' : archived ? 'closed' : 'legal',
    ...(!changed && archived ? { outcome: 'won', closed_on: '2026-10-20' } : {}),
    phase_change: changed ? null : { source: 'copied', automatic: true, event_id: eventId, prior_phase: 'research',
      phase: archived ? 'closed' : 'legal', evidence_date: '2026-10-19', recorded_at: '2026-10-20T00:00:00Z' },
    email_follow_ups: [] });
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/deals') {
        return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe',
          deals: archived && !changed ? [] : [deal()], closed_deals: archived && !changed ? [deal()] : [], lost_deals: [] });
      }
      if (path === `/api/engine/deals/${id}/phase/undo`) {
        changed = true;
        return Response.json({ error: 'version_conflict', current_version: 24 }, { status: 409 });
      }
      assert.equal(path, `/api/engine/deals/${id}`);
      const response = unavailable ? new Response(null, { status: 502 }) : Response.json(deal());
      if (nextDetail) {
        const { started, release } = nextDetail;
        nextDetail = undefined;
        started.resolve();
        await release.promise;
      }
      return response;
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'undo-automatic-phase-move'].includes(body?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  const snapshot = page.getByRole('region', { name: 'Deal path' });
  const undo = snapshot.getByRole('button', { name: 'Undo', exact: true });
  const open = () => page.getByRole('button', { name, exact: true }).click();
  await page.goto(`${origin}/deals?mode=live`);
  if (archived) await page.getByRole('button', { name: 'Closed deals', exact: true }).click();
  await open();
  await undo.waitFor();
  return {
    page, undo, open,
    refresh: page.getByRole('button', { name: 'Refresh deal', exact: true }),
    refreshed: snapshot.getByText('This deal changed. The deal page was refreshed.', { exact: true }),
    warning: snapshot.getByText('This deal changed. Refresh Deals to see the current phase.', { exact: true }),
    phase: page.locator('.deal-path [aria-current]'),
    setDetailUnavailable(value) { unavailable = value; },
    holdNextDetail() {
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      nextDetail = { started, release };
      t.after(() => release.resolve());
      return { started: started.promise, release: release.resolve };
    },
  };
}

test('Undo on the deal page waits for a read newer than the conflict', async t => {
  const { page, undo, refresh, refreshed, phase, holdNextDetail } = await openDealForUndoConflict(t, { archived: true });
  const older = holdNextDetail();
  await refresh.click();
  await older.started;
  await undo.press('Space');
  await page.locator('#closedDealsList').getByText('Example Undo Refresh Deal', { exact: true }).waitFor({ state: 'detached' });
  older.release();
  await refreshed.waitFor();
  assert.equal(await undo.count(), 0, 'the refresh notice must not accompany a stale Undo');
  assert.equal(await phase.getAttribute('data-phase'), 'negotiation');
});

test('Undo on the deal page discards feedback after leaving the deal', async t => {
  const { page, undo, open, phase, warning, holdNextDetail } = await openDealForUndoConflict(t);
  const pending = holdNextDetail();
  await undo.press('Space');
  await pending.started;
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await page.locator('#recordPanel').waitFor({ state: 'hidden' });
  pending.release();
  await open();
  await phase.waitFor();
  assert.equal(await phase.getAttribute('data-phase'), 'negotiation');
  assert.deepEqual({
    announcement: await page.locator('#dragLive').textContent(),
    warnings: await warning.count(),
  }, { announcement: '', warnings: 0 });
});

test('Undo on the deal page clears the warning after a successful refresh retry', async t => {
  const { page, undo, refresh, warning, holdNextDetail, setDetailUnavailable } = await openDealForUndoConflict(t);
  setDetailUnavailable(true);
  await undo.press('Space');
  await warning.waitFor();
  setDetailUnavailable(false);
  const pending = holdNextDetail();
  await refresh.click();
  await pending.started;
  pending.release();
  await page.waitForFunction(() => document.querySelector('.deal-path [aria-current]')?.dataset.phase === 'negotiation');
  assert.equal(await undo.count(), 0);
  assert.equal(await warning.count(), 0, 'a successful retry must clear the refresh warning');
});

test('Undo on the deal page times out without blocking the workspace', async t => {
  const { page, undo, warning, holdNextDetail } = await openDealForUndoConflict(t, { archived: true });
  await page.clock.install();
  const pending = holdNextDetail();
  await undo.press('Space');
  await pending.started;

  const timeline = page.getByRole('tab', { name: 'Activity', exact: true });
  await timeline.click();
  assert.equal(await timeline.getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.clock.fastForward(11_000);

  await warning.waitFor();
  assert.equal(await undo.isEnabled(), false);
  pending.release();
});

for (const width of [1440, 390]) {
  test(`National Accounts shows every closed deal in its account at ${width}px`, async t => {
    const fixture = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
    t.after(() => fixture.close());
    const { origin } = fixture;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    t.after(() => page.close());
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `national-closed-${width}`, viewer: 'joe', reset: true } });
    const accounts = ['Example North', 'Example South', 'Example New'].map(account_name => ({
      account_client_id: crypto.randomUUID(), account_name, account_owner: 'joe',
    }));
    const row = (name, account, phase, facts = {}) => ({
      id: crypto.randomUUID(), name, client_name: name, phase, owner: 'joe',
      account_client_id: account?.account_client_id, ...facts,
    });
    const open = row('Example Open Market', accounts[0], 'research');
    const undated = row('Example Undated Location', accounts[0], 'closed');
    const dated = row('Example Dated Location', accounts[0], 'closed', {
      closed_on: '2026-11-02', kind: 'lease', seen: 1,
      phase_change: { automatic: true, event_id: crypto.randomUUID(), prior_phase: 'legal', phase: 'closed', evidence_date: '2026-11-01' },
    });
    const other = row('Example Other Location', accounts[1], 'closed');
    const local = row('Example Local Deal', null, 'closed');
    const lost = row('Example Lost Location', accounts[0], 'dead');
    const board = { schema_version: 'local-deals-board.v2', actor: 'joe', accounts, deals: [open],
      closed_deals: [dated, undated, local, other], lost_deals: [lost] };
    let readsOn = false;
    const env = {
      ENGINE_ROUTING: { get: async key => readsOn && key === 'deals-from-engine' ? 'on' : null },
      ENGINE: { fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/api/engine/deals') return Response.json(board);
        const deal = board.closed_deals.find(record => path === `/api/engine/deals/${record.id}`);
        return deal ? Response.json({ ...deal, deal_id: deal.id, email_follow_ups: [] }) : new Response(null, { status: 404 });
      } },
      CARR: { fetch: async request => {
        const { id } = await request.json();
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(board) }] } });
      } },
    };
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (!['deal-room-board', 'get-deal-room'].includes(request.postDataJSON()?.params?.name)) return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });

    const nationalUrl = `${origin}/deals?view=national&mode=live`;
    const openAccount = account => page.getByRole('button', { name: new RegExp(account.account_name) }).click();
    const closed = page.getByRole('button', { name: 'Closed deals', exact: true });
    await page.goto(nationalUrl);
    await openAccount(accounts[0]);
    assert.equal(await closed.count(), 0);

    readsOn = true;
    await page.goto(nationalUrl);
    await openAccount(accounts[0]);
    await closed.click({ timeout: 5000 });
    const view = page.getByRole('region', { name: 'Closed deals', exact: true });
    const titles = () => view.getByRole('heading', { level: 3 }).allTextContents();
    await view.getByText('2 closed deals', { exact: true }).waitFor();
    assert.deepEqual(await titles(), [dated.name, undated.name]);
    await view.locator('.auto-move time').getByText('Sun, Nov 1, 2026', { exact: true }).waitFor();
    assert.equal(await page.getByRole('table', { name: 'Active and parked deals' }).count(), 0);
    assert.equal(await page.getByRole('group', { name: 'Filter deals' }).count(), 0);
    const search = view.getByRole('searchbox', { name: 'Search closed deals' });
    assert.equal(await search.getAttribute('placeholder'), 'Deal, client, kind, or close date');
    await search.fill('Mon, Nov 2, 2026');
    assert.deepEqual(await titles(), [dated.name]);
    await search.clear();
    await view.getByText('Close date not recorded', { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, `national-closed-${width}.png`) });
    await view.getByRole('button', { name: undated.name, exact: true }).click();
    await page.locator('#panelTitle').getByText(undated.name, { exact: true }).waitFor();
    const client = page.locator('#workspaceFacts').getByText('Client', { exact: true }).locator('..');
    await client.getByText(undated.name, { exact: true }).waitFor({ timeout: 5000 });
    await page.locator('.workspace-header').screenshot({ path: join(evidence, `same-name-client-${width}.png`) });
    await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
    await view.getByText('2 closed deals', { exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Open deals', exact: true }).click();
    await page.getByRole('table', { name: 'Active and parked deals' }).getByText(open.name, { exact: true }).waitFor();

    for (const [account, names] of [[accounts[1], [other.name]], [accounts[2], []]]) {
      await page.getByRole('button', { name: /All national accounts/ }).click();
      await openAccount(account);
      await closed.click();
      await view.getByText(names.length ? '1 closed deal' : '0 closed deals', { exact: true }).waitFor();
      assert.deepEqual(await titles(), names);
    }

    await page.goto(`${origin}/deals?view=closed&mode=live`);
    const localView = page.getByRole('region', { name: 'Closed deals', exact: true });
    await localView.getByText('1 closed deal', { exact: true }).waitFor();
    assert.deepEqual(await localView.getByRole('heading', { level: 3 }).allTextContents(), [local.name]);
  });
}

for (const width of [1440, 390]) test(`National account rows open the deal and show the engine's attention at ${width}px`, async t => {
  const fixture = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  t.after(() => fixture.close());
  const { origin } = fixture;
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Europe/Paris' });
  t.after(() => page.close());
  let undoModuleReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/js/ui-automatic-phase-undo.generated.js') undoModuleReads++;
  });
  await page.clock.setFixedTime(new Date('2026-11-19T01:00:00Z'));
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `national-rows-${width}`, viewer: 'joe', reset: true } });
  const account = crypto.randomUUID();
  const receipt = { source: 'copied', automatic: true, event_id: crypto.randomUUID(),
    phase: 'legal', prior_phase: 'research', evidence_date: '2026-10-19' };
  const deal = { id: crypto.randomUUID(), name: 'Example Clinic Expansion', phase: 'legal', owner: 'joe', seen: 1, phase_change: receipt,
    account_client_id: account, market: 'Market unspecified in source', next_date: '2026-11-17', next_step: 'Review the floor plan',
    attention: { reason: 'A next step is late.', since: '2026-11-18' },
    open_actions: [{ id: crypto.randomUUID(), owner: 'joe', description: 'Review the floor plan', due_on: '2026-11-17' }] };
  const closing = { ...deal, id: crypto.randomUUID(), name: 'Example Dental Office', phase: 'closing', phase_change: null, attention: null, needs_attention: true,
    market: 'Example City', next_date: '2026-11-23', next_step: 'Sign the lease',
    open_actions: [{ id: crypto.randomUUID(), owner: 'joe', description: 'Sign the lease', due_on: '2026-11-23' }] };
  const writes = [];
  const undos = [];
  let savesOn = false;
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (savesOn && key === 'deals-saves-from-engine') ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/deals') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe',
        deals: [deal, closing], accounts: [{ account_client_id: account, account_name: 'Example National Account', account_owner: 'joe' }] });
      if (path === `/api/engine/deals/${deal.id}`) return Response.json({ ...deal, deal_id: deal.id, email_follow_ups: [] });
      if (path === `/api/engine/deals/${deal.id}/phase/undo`) {
        const { idempotency_key, ...change } = await request.json();
        assert.match(idempotency_key, /^[a-f\d-]{36}$/i);
        assert.deepEqual(change, { event_id: receipt.event_id, base_version: deal.seen });
        undos.push(change);
        Object.assign(deal, { phase: receipt.prior_phase, phase_change: null, seen: deal.seen + 1 });
        return Response.json({ deal_id: deal.id, phase: deal.phase, phase_changed_at: '2026-11-19T15:01:00Z' });
      }
      writes.push(path);
      return Response.json({ deal_id: deal.id, change_id: ++deal.seen });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'get-deal-room', 'patch-deal-field', 'undo-automatic-phase-move'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  const accountUrl = `${origin}/deals?view=national&mode=live`;
  const openAccount = () => page.getByRole('button', { name: /Example National Account/ }).click();
  const row = page.getByRole('row').filter({ hasText: deal.name });
  await page.goto(accountUrl);
  assert.ok(await page.getByRole('link', { name: 'Local Deals', exact: true }).isVisible());
  await openAccount();
  assert.equal(await row.getByRole('button').first().innerText(), deal.name);
  assert.equal(await row.getByRole('button', { name: /attention/i }).count(), 0, 'no partner sets or clears it');
  assert.match(await page.locator('#stats').innerText(), /2 active work · 1 overdue dates · 1 at closing/);
  assert.equal(await row.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  await row.getByText('Moved automatically', { exact: true }).waitFor({ timeout: 5000 });

  savesOn = true;
  await page.goto(accountUrl);
  await openAccount();
  const first = row.getByRole('button').first();
  assert.equal(await first.innerText(), deal.name);
  const moved = row.getByText('Moved automatically', { exact: true });
  assert.equal(await moved.count(), 1);
  assert.equal(await row.locator('time[datetime="2026-10-19"]').textContent(), 'Mon, Oct 19, 2026');
  assert.equal(await page.getByRole('row').filter({ hasText: closing.name })
    .getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: /attention/i }).count(), 0, 'no partner sets or clears it');
  assert.match(await row.innerText(), /No market recorded/);
  assert.equal(await row.locator('.due').innerText(), 'Due Tue, Nov 17, 2026 · 1 day late');
  assert.match(await page.getByRole('row').filter({ hasText: closing.name }).innerText(), /Example City/);
  assert.match(await page.locator('#stats').innerText(), /2 open deals · 1 late · 1 closing/);
  await first.click();
  await page.getByRole('heading', { name: deal.name, exact: true }).waitFor({ timeout: 5000 });
  const market = page.locator('#workspaceFacts').getByText('Market', { exact: true }).locator('..').locator('dd');
  assert.equal(await market.innerText(), 'No market recorded');
  assert.deepEqual(writes, []);

  await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
  await row.waitFor({ timeout: 5000 });
  const accountLocation = new URL(page.url());
  assert.equal(accountLocation.searchParams.get('view'), 'national');
  assert.equal(accountLocation.searchParams.get('account'), account);
  await page.reload();
  await row.waitFor({ timeout: 5000 });
  await page.locator('#boardSection').screenshot({ path: join(evidence, `national-account-${width}.png`) });
  const show = page.getByLabel('Show', { exact: true });
  const closingRow = page.getByRole('row').filter({ hasText: closing.name });
  await page.mouse.move(0, 0);
  assert.equal(await row.getByText('Needs attention', { exact: true }).isVisible(), true, 'attention shows without hover');
  assert.equal(await row.getByText('1 day late', { exact: true }).isVisible(), true, 'a late row still says it is late');
  assert.equal(await closingRow.getByText('Needs attention', { exact: true }).count(), 0, 'a stored flag is not attention');
  await show.selectOption({ label: 'Needs attention' });
  await closingRow.waitFor({ state: 'detached' });
  assert.equal(await row.count(), 1);
  await show.selectOption({ label: 'Active' });
  await closingRow.waitFor();
  assert.deepEqual(writes, []);
  assert.equal(undoModuleReads, 0);
  await row.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
  await moved.waitFor({ state: 'detached' });
  assert.equal(await row.getByLabel(`Phase for ${deal.name}`).inputValue(), 'Research');
  assert.equal(await row.count(), 1);
  assert.equal(await first.evaluate(button => button === document.activeElement), true);
  assert.equal(undos.length, 1);
  assert.equal(undoModuleReads, 1);
  await page.getByRole('button', { name: /All national accounts/ }).click();
  assert.equal(new URL(page.url()).searchParams.has('account'), false);
  await page.reload();
  await page.getByRole('button', { name: /Example National Account/ }).waitFor();
});

for (const [width, height, today] of [[1280, 800, 'closed'], [1280, 800, 'open'], [1440, 900, 'closed'], [1440, 900, 'open'], [390, 844, 'closed']]) {
  test(`a national account on the engine fits one screen at ${width}px with Today ${today}`, async t => {
    const phone = width < 600;
    const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'America/Chicago', reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    t.after(() => page.close());
    await page.addInitScript(today => localStorage.setItem('doctorcre:today:/deals?view=national', today), today);
    await page.clock.setFixedTime(new Date('2026-11-19T18:00:00Z'));
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `engine-national-fit-${width}-${today}`, viewer: 'joe', reset: true } });
    const account = crypto.randomUUID();
    const deal = (name, fields) => ({ id: crypto.randomUUID(), name, phase: 'research', seen: 1, owner: 'joe', account_client_id: account,
      workspace_kind: 'national_account', market: 'Example City', next_step: 'Call the landlord', next_date: '2026-11-24', ...fields });
    const step = crypto.randomUUID();
    const flagged = deal('Example Flagged Late Deal', { attention: { reason: 'A next step is late.', since: '2026-11-18' }, next_date: '2026-11-17',
      open_actions: [{ id: step, owner: 'joe', due_on: '2026-11-17', item_id: `next_action:${step}`, description: 'Call the landlord' }] });
    const deals = [flagged, deal('Example Quiet Deal'), deal('Example Closing Deal', { phase: 'closing' })];
    const env = {
      ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
      ENGINE: { fetch: async () => Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals,
        accounts: [{ account_client_id: account, account_name: 'Example National Account', account_owner: 'dell' }] }) },
    };
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (request.postDataJSON()?.params?.name !== 'deal-room-board') return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(`${origin}/deals?view=national&mode=live&account=${account}`);
    const row = page.getByRole('row').filter({ hasText: flagged.name });
    await row.waitFor({ timeout: 5000 });
    await page.mouse.move(0, height - 1);
    await page.screenshot({ path: join(evidence, `national-account-engine-${width}-today-${today}.png`) });
    const fit = await page.evaluate(() => {
      const box = node => node.getBoundingClientRect();
      const main = document.getElementById('appMainSlot');
      const visible = selector => [...document.querySelectorAll(selector)].filter(node => node.checkVisibility()).map(node => node.textContent.trim());
      const tabs = [...document.querySelectorAll('#appTabsSlot :is(a, button)')].filter(node => node.checkVisibility());
      return {
        pageScrolls: document.documentElement.scrollHeight > innerHeight,
        sideways: document.documentElement.scrollWidth > innerWidth,
        mainTop: Math.round(box(main).top + Number.parseFloat(getComputedStyle(main).paddingTop)),
        tabs: tabs.map(node => node.textContent.trim()),
        topBar: visible('#appTopbar :is(#syncStatus, [data-account-view])'),
        topBarClipped: [...document.querySelectorAll('#appTabsSlot, #appTopbar .app-layout-title')].some(node => node.scrollWidth > node.clientWidth),
        todayStamp: visible('#appSyncTime'),
        toolbar: visible('#appToolsSlot :is(#mondayReviewLink, #ownerButton, #dealFilter)').length,
        toolbarStamp: visible('#appToolsSlot #syncStatus'),
        actions: (style => `${style.display} ${style.columnGap} ${style.rowGap}`)(getComputedStyle(document.querySelector('#rows tr:first-child .row-actions'))),
        lineEnds: [...document.querySelectorAll('.deal-meta')].flatMap(meta => [...meta.children]
          .filter((node, index, all) => !all[index + 1] || box(all[index + 1]).top > box(node).top)
          .map(node => node.textContent.trim())),
      };
    });
    assert.equal(fit.sideways, false, 'nothing scrolls sideways');
    assert.ok(fit.lineEnds.every(text => text !== '·'), `no line of row details ends in a separator: ${JSON.stringify(fit.lineEnds)}`);
    assert.equal(await row.getByText('Needs attention', { exact: true }).isVisible(), true, 'attention shows without hover');
    assert.equal(await row.getByText('2 days late', { exact: true }).isVisible(), true, 'the row still says its step is late');
    assert.equal(fit.toolbar, 3, 'Monday review, the owner and Show sit in the toolbar');
    if (phone) {
      assert.deepEqual(fit.tabs, ['Local Deals', 'National Accounts', 'Open deals', 'Closed deals'], 'the phone tab bar holds the four views');
      assert.deepEqual(fit.toolbarStamp, ['Updated 12:00 PM'], 'the phone toolbar ends with the update time');
      const closedTab = page.locator('#appTabsSlot').getByRole('button', { name: 'Closed deals', exact: true });
      await closedTab.scrollIntoViewIfNeeded();
      const closedBox = await closedTab.boundingBox();
      assert.ok(closedBox.x >= 0 && closedBox.x + closedBox.width <= width, 'the tab row scrolls within itself to reach Closed deals');
      assert.equal((await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), false, 'nothing scrolls sideways');
      assert.equal(fit.actions, 'flex 8px 8px', 'row buttons keep the phone card flex row and its gap, wrapped or not');
      assert.equal(await row.locator('[data-operating-state]').isVisible(), true, 'touch keeps Park in reach');
      return;
    }
    assert.equal(fit.pageScrolls, false, 'the page itself does not scroll');
    assert.ok(fit.mainTop <= 112, `the deals start under one toolbar row, not at ${fit.mainTop}px`);
    assert.equal(fit.topBarClipped, false, 'the account name and the views fit the top bar');
    if (today === 'open') {
      assert.deepEqual(fit.topBar, ['Open deals', 'Closed deals'], 'the views sit in the top bar');
      assert.deepEqual(fit.todayStamp, ['Updated 12:00 PM'], 'Today says when it updated, once');
    } else assert.deepEqual(fit.topBar, ['Open deals', 'Closed deals', 'Updated 12:00 PM'], 'the views and the update time sit in the top bar');
    assert.equal(await row.locator('[data-operating-state]').evaluate(node => getComputedStyle(node).opacity), '0', 'the row stays quiet');
  });
}

for (const width of [1440, 390]) test(`National Accounts saves inline changes and requires a closing outcome at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'engine-national-fields', viewer: 'joe', reset: true } });
  const id = '00000000-0000-4000-8000-000000000071';
  const account = '00000000-0000-4000-8000-000000000072';
  await page.clock.setFixedTime(new Date('2026-11-19T18:00:00Z'));
  const name = 'Example Market Deal';
  const row = { id, name, phase: 'research', seen: 23, owner: 'joe', account_client_id: account, workspace_kind: 'national_account', market: ' market unspecified ' };
  const writes = [];
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      if (new URL(request.url).pathname === `/api/engine/deals/${id}`) return Response.json({ ...row, deal_id: id, email_follow_ups: [] });
      if (request.method === 'GET') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: ['dead', 'closed'].includes(row.phase) ? [] : [row],
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
    if (!['deal-room-board', 'get-deal-room', 'patch-deal-field', 'update-deal'].includes(body?.params?.name)) return route.continue();
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
  const dialog = page.getByRole('dialog', { name: `Close ${name}` });
  const openClosing = async () => {
    await phase.selectOption('Closed');
    await dialog.waitFor({ timeout: 5000 });
    assert.equal(await dialog.getByLabel('Won', { exact: true }).isChecked(), false);
    assert.equal(await dialog.getByLabel('Lost', { exact: true }).isChecked(), false);
    assert.equal(await dialog.getByLabel('Paused', { exact: true }).isVisible(), false);
    assert.equal(writes.length, 2);
  };
  await openClosing();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
  await phase.waitFor({ timeout: 5000 });
  const card = page.getByRole('row').filter({ hasText: name });
  await card.getByText('No market recorded', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await phase.inputValue(), 'Legal');
  await openClosing();
  const outcome = width === 1440 ? 'Won' : 'Lost';
  await dialog.getByLabel(outcome, { exact: true }).check();
  if (outcome === 'Lost') await dialog.locator('#completionLostReason').fill('Example plans changed');
  await dialog.screenshot({ path: join(evidence, `national-close-${width}.png`) });
  await dialog.getByRole('button', { name: 'Save outcome' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(writes.length, 3);
  assert.equal(writes[2].seen_change_id, 25);
  assert.deepEqual(writes[2].phase, {
    from: 'legal', to: outcome === 'Won' ? 'closed' : 'dead', on: '2026-11-19',
    ...(outcome === 'Lost' && { reason: 'Example plans changed' }),
  });
});

for (const width of [1440, 390]) test(`National Accounts asks how the deal ended with new saves off at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `legacy-national-close-${width}`, viewer: 'joe', reset: true } });
  await page.clock.setFixedTime(new Date('2026-11-19T18:00:00Z'));
  const account = crypto.randomUUID();
  const id = crypto.randomUUID();
  const name = 'Example Market Deal';
  const row = { id, deal_id: id, name, phase: 'research', base_version: 23, owner: 'joe',
    account_client_id: account, workspace_kind: 'national_account' };
  const writes = [];
  const env = {
    ENGINE_ROUTING: { get: async () => null },
    CARR: { fetch: async request => {
      const { id: requestId, params: { name: verb, arguments: args } } = await request.json();
      let data = row;
      if (verb === 'deal-room-board') data = { schema_version: 'local-deals-board.v2', actor: 'joe',
        deals: row.phase === 'closed' ? [] : [row],
        accounts: [{ account_client_id: account, account_name: 'Example National Account', account_owner: 'joe' }] };
      if (verb === 'patch-deal-field' || verb === 'update-deal') {
        writes.push({ verb, args });
        if (verb === 'patch-deal-field') row.phase = args.value;
        else Object.assign(row, args.fields);
        data = { ok: true, status: 'ok', deal_id: id, version: ++row.base_version };
      }
      return Response.json({ jsonrpc: '2.0', id: requestId, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request(), body = request.postDataJSON();
    if (!['deal-room-board', 'get-deal-room', 'patch-deal-field', 'update-deal'].includes(body?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: JSON.stringify(body),
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  await page.goto(`${origin}/deals?view=national&mode=live`);
  await page.getByRole('button', { name: /Example National Account/ }).click();
  await page.getByLabel(`Phase for ${name}`).selectOption('Closed');
  const dialog = page.getByRole('dialog', { name: `Close ${name}` });
  await dialog.waitFor({ timeout: 5000 });
  assert.deepEqual(writes, []);
  assert.equal(await dialog.getByLabel('Paused', { exact: true }).isVisible(), false);
  await dialog.screenshot({ path: join(evidence, `legacy-national-close-${width}.png`) });
  const save = dialog.getByRole('button', { name: 'Save outcome' });
  await save.click();
  await dialog.getByText('Choose Won or Lost.', { exact: true }).waitFor({ timeout: 5000 });
  assert.deepEqual(writes, []);

  const outcome = width === 1440 ? 'Won' : 'Lost';
  await dialog.getByLabel(outcome, { exact: true }).check();
  assert.deepEqual(writes, []);
  await save.click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  assert.deepEqual(writes.map(write => write.verb), ['patch-deal-field', 'update-deal']);
  assert.equal(writes[0].args.value, 'closed');
  assert.equal(writes[1].args.base_version, 24);
  assert.deepEqual(writes[1].args.fields, { outcome: outcome.toLowerCase(), closed_on: '2026-11-19' });
});

for (const width of [1440, 390]) test(`Add deal and Won or Lost save through the new database switch at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `engine-deals-${width}`, viewer: 'joe', reset: true } });
  const clientId = '00000000-0000-4000-8000-000000000040';
  const deals = new Map();
  const writes = [];
  let savesOn = false;
  const personId = '00000000-0000-4000-8000-000000000041';
  const leaseId = '00000000-0000-4000-8000-000000000042';
  const otherLeaseId = '00000000-0000-4000-8000-000000000043';
  const leaseReads = [];
  let leasesAvailable = true;
  const refusals = [
    ['Client role', { error: 'database_refused_the_statement', rule: 'deal_party_client_is_a_client' }, 'Choose an existing client.'],
    ['Market', { error: 'database_refused_the_statement', rule: 'deal_market_id_fkey' }, 'Choose an existing market.'],
    ['Renewal', { error: 'database_refused_the_statement', rule: 'deal_renews_lease_id_fkey' }, 'Choose an existing lease to renew.'],
    ['Duplicate', { error: 'deal_name_exists' }, 'A deal with this name already exists.'],
    ...['invalid_field_value', 'unknown_owner', 'version_conflict'].map(error => [error, { error }, 'Check the deal details and try again.']),
  ];
  const earlyDate = '2026-01-01';
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (key === 'deals-saves-from-engine' && savesOn) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const url = new URL(request.url);
      const id = url.pathname.split('/')[4];
      if (url.pathname === '/api/engine/parties/search') {
        assert.equal(url.searchParams.get('role'), 'client');
        assert.equal(url.searchParams.has('kind'), false);
        const query = url.searchParams.get('query');
        if (query === 'Example Unavailable') return Response.json({}, { status: 503 });
        const parties = ['person', 'company'].map(kind => ({
          id: kind === 'person' ? personId : clientId, display_name: 'Example Practice', kind,
          city: kind === 'person' ? null : 'Austin', deal_count: kind === 'person' ? 1 : 3,
          is_national_account: kind === 'company',
        })).filter(party => party.display_name.startsWith(query));
        return Response.json({ parties });
      }
      if (url.pathname.endsWith('/leases')) {
        leaseReads.push(id);
        if (!leasesAvailable) return Response.json({}, { status: 503 });
        return Response.json(id === clientId ? [
          { lease_id: leaseId, address: '10 Example Road', expiration_on: '2031-06-01',
            renewed_by: { deal_id: personId, name: 'Example Earlier Renewal' } },
          { lease_id: otherLeaseId, address: '20 Example Road', expiration_on: null, renewed_by: null },
        ] : []);
      }
      if (url.pathname === '/api/engine/prospects') return Response.json({ count: 0, prospects: [] });
      if (request.method === 'GET') {
        if (id) return Response.json({ ...deals.get(id), deal_id: id });
        const rows = [...deals.values()];
        return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe',
          deals: rows.filter(row => !row.outcome), closed_deals: rows.filter(row => row.outcome === 'won'),
          lost_deals: rows.filter(row => row.outcome === 'lost'),
          accounts: [{ account_client_id: clientId, account_name: 'Example National Account', account_owner: 'joe',
            base_version: 0, open_deals: 0, overdue_deals: 0, parked_deals: 0 }] });
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
        if (refusal)
          return Response.json(refusal[1], { status: 422 });
        const dealId = crypto.randomUUID();
        deals.set(dealId, { id: dealId, name: body.name, client_name: 'Example Practice', owner: body.owner, phase: body.phase, seen: 1,
          kind: body.kind, type: body.kind || body.reason, reason: body.reason });
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
  await page.route(/\/(mcp|api\/engine\/.*)(\?.*)?$/, async route => {
    const request = route.request();
    const body = request.postDataJSON();
    if (body && !['deal-room-board', 'get-deal-room', 'new-deal', 'update-deal', 'add-deal-note'].includes(body.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postData() ?? undefined,
    }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  await page.goto(`${origin}/deals?mode=live`);
  await page.getByText('0 open deals · 0 parked', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  await page.getByLabel('Deal name').fill('Example Stale Form');
  await page.getByLabel('Client', { exact: true }).fill('Example Practice');
  assert.equal(await page.getByLabel('Type', { exact: true }).isVisible(), true);
  const lookupPaths = ['/api/engine/parties/search?query=Example&role=client', `/api/engine/clients/${clientId}/leases`];
  for (const path of lookupPaths) {
    assert.equal((await handleDoctorcreRequest(new Request(origin + path), env)).status, 404);
  }
  savesOn = true;
  await page.getByRole('button', { name: 'Create deal' }).click();
  await page.getByText('Reload Deals before adding a deal.', { exact: true }).waitFor();
  assert.equal(writes.length, 0);
  await page.reload();
  // With saves on, the headline gains the prospect count once that lane loads.
  await page.getByText('0 open deals · 0 parked · 0 prospects', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  await page.getByLabel('Deal name').fill('Example Unmatched Deal');
  const dialog = page.getByRole('dialog', { name: 'Add deal' });
  const clientInput = dialog.getByRole('textbox', { name: 'Client', exact: true });
  const create = dialog.getByRole('button', { name: 'Create deal' });
  const kind = dialog.getByLabel('Deal kind');
  const reason = dialog.getByLabel('Deal reason');
  const lease = dialog.getByLabel('Lease to renew');
  const company = dialog.getByRole('button', { name: 'Example Practice · Company · Austin · 3 deals' });
  const person = dialog.getByRole('button', { name: 'Example Practice · Person · No city recorded · 1 deal', exact: true });
  assert.equal(await kind.inputValue(), '');
  assert.equal(await reason.inputValue(), '');
  await clientInput.fill('Example Unknown');
  await dialog.getByText('No matching clients.').waitFor();
  await create.click();
  await dialog.getByText('Choose a client from the matches.').waitFor();
  await clientInput.fill('Example Unavailable');
  await dialog.getByText('Search is unavailable. Try again.').waitFor();
  await clientInput.fill('Example Pra');
  await reason.selectOption('renewal');
  await person.waitFor();
  await dialog.screenshot({ path: join(evidence, `engine-client-matches-${width}.png`) });
  await person.click();
  await dialog.getByText('No leases found for this client.').waitFor();
  await clientInput.fill('Example');
  leasesAvailable = false;
  await company.click();
  await dialog.getByText('Could not load leases.').waitFor();
  leasesAvailable = true;
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await lease.locator('option').filter({ hasText: '10 Example Road · Expires Sun, Jun 1, 2031 · already renewed by Example Earlier Renewal' }).waitFor({ state: 'attached' });
  assert.equal(await lease.locator(`option[value="${otherLeaseId}"]`).textContent(), '20 Example Road · Expiration not recorded');
  assert.deepEqual(leaseReads, [personId, clientId, clientId]);
  assert.equal(await lease.evaluate(control => control.matches(':invalid')), true);
  await create.click();
  assert.equal(writes.length, 0);
  await lease.selectOption(leaseId);
  await clientInput.fill('Example Pra');
  await company.click();
  await lease.locator(`option[value="${leaseId}"]`).waitFor({ state: 'attached' });
  assert.equal(await lease.inputValue(), '');
  await reason.selectOption('relocation');
  assert.equal(await lease.count(), 0);
  await reason.selectOption('renewal');
  await lease.selectOption(leaseId);
  if (width === 390) {
    await dialog.getByText('Already renewed by Example Earlier Renewal', { exact: true }).waitFor();
    await lease.selectOption(otherLeaseId);
    assert.equal(await dialog.getByText('Already renewed by Example Earlier Renewal', { exact: true }).count(), 0);
    await lease.selectOption(leaseId);
  }
  await kind.selectOption('lease');
  await dialog.getByLabel('Deal name').fill('Example Renewal Deal');
  const [formBox, createBox] = await Promise.all([dialog.boundingBox(), create.boundingBox()]);
  assert.ok(createBox.y + createBox.height <= formBox.y + formBox.height, `Create deal stays within the dialog (${createBox.y + createBox.height} / ${formBox.y + formBox.height})`);
  await dialog.screenshot({ path: join(evidence, `engine-renewal-${width}.png`) });
  await create.click();
  await page.getByRole('button', { name: 'Example Renewal Deal', exact: true }).click();
  await page.getByRole('heading', { name: 'Example Renewal Deal', exact: true }).waitFor();
  assert.partialDeepStrictEqual(writes.shift(), {
    client_id: clientId, kind: 'lease', reason: 'renewal', renews_lease_id: leaseId,
  });
  await page.getByRole('button', { name: 'Back to deals' }).click();
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();

  for (const [name, , hint] of refusals) {
    await dialog.getByLabel('Deal name').fill(`Example ${name}`);
    await clientInput.fill('Example');
    await company.click();
    await reason.selectOption(name === 'Renewal' ? 'renewal' : 'start_up');
    if (name === 'Renewal') await lease.selectOption(leaseId);
    await create.click();
    await dialog.getByText(hint, { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Deal name').isEnabled(), true);
  }
  writes.splice(0);

  for (const outcome of ['Won', 'Lost']) {
    const name = `Example ${outcome} Deal`;
    await page.getByLabel('Deal name').fill(name);
    await clientInput.fill('Example');
    await company.click();
    await reason.selectOption(outcome === 'Won' ? '' : 'start_up');
    if (outcome === 'Won') await page.getByLabel('Notes', { exact: true }).fill('Example opening note');
    await page.getByRole('button', { name: 'Create deal' }).click();
    await page.getByRole('button', { name, exact: true }).click();
    if (outcome === 'Won') {
      await page.getByRole('tab', { name: 'Activity' }).click();
      await page.getByRole('tabpanel', { name: 'Activity' }).getByRole('region', { name: 'Deal notes' }).getByText('Example opening note', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Overview' }).click();
    }
    const path = page.getByRole('region', { name: 'Deal path' });
    await path.getByRole('button', { name: 'Closed', exact: true }).click();
    const closeAsk = path.getByRole('form', { name: 'Close this deal' });
    assert.equal(await closeAsk.getByLabel('Paused', { exact: true }).count(), 0);
    await closeAsk.getByText(outcome, { exact: true }).click();
    if (outcome === 'Lost') {
      await closeAsk.getByRole('button', { name: 'Close deal' }).click();
      await closeAsk.getByText('Enter the reason the deal was lost.', { exact: true }).waitFor();
      await closeAsk.getByLabel('Reason the deal was lost').fill('The client chose another site');
    } else await closeAsk.getByLabel('Closed value (optional)').fill('1000');
    const date = closeAsk.getByLabel('Closed on', { exact: true });
    const today = await date.inputValue();
    assert.equal(await date.getAttribute('max'), today);
    await date.fill(earlyDate);
    await closeAsk.getByRole('button', { name: 'Close deal' }).click();
    await closeAsk.getByRole('status').getByText('Choose a closing date between the day the deal reached its current phase and today.', { exact: true }).waitFor();
    await date.fill(today);
    await page.screenshot({ path: join(evidence, `engine-${outcome.toLowerCase()}-dialog-${width}.png`) });
    await closeAsk.getByRole('button', { name: 'Close deal' }).click();
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
  assert.deepEqual(writes.filter(write => write.name).map(write => [write.kind, write.reason, write.renews_lease_id]),
    [[undefined, undefined, undefined], [undefined, 'start_up', undefined]]);
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  await clientInput.fill('Example Pra');
  await dialog.getByRole('link', { name: 'Open account', exact: true }).click();
  await page.locator('#workspaceTitle').getByText('Example National Account', { exact: true }).waitFor();
  assert.equal(writes.length, 7, 'opening an account does not save a deal');
});

test('switched-on Deals selects an existing market agent and decides critical dates', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.clock.setFixedTime(new Date('2026-11-25T17:00:00Z'));
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
  const dateRow = page.getByRole('region', { name: 'Critical dates' });
  await dateRow.waitFor();
  assert.equal(await dateRow.getByRole('button', { name: 'Add date' }).count(), 0);
  assert.equal(await page.locator('.critical-date').filter({ hasText: 'Jan 1, 2027' }).locator('.date-open').textContent(), 'Phase effective date');
  await page.goto(`${origin}/deals?view=national&mode=live`);
  await page.getByRole('button', { name: /Example National Account/ }).click();
  await page.getByRole('button', { name: 'Previous Agent' }).click();
  await page.getByLabel('Assigned local agent').waitFor();
  savesOn = true;
  await page.reload();
  await page.locator('#workspaceTitle').getByText('Example National Account', { exact: true }).waitFor();
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
  await card.locator(':scope > p').getByText('Jan 2, 2027', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  await card.locator('[data-countdown]').waitFor();
  await card.getByRole('button', { name: 'Lease expiration' }).click();
  const opened = page.getByRole('dialog', { name: 'Lease expiration' });
  await opened.getByText('Jan 2, 2027 · Confirmed', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'engine-critical-date.png') });
  await opened.getByRole('button', { name: 'Mark done' }).click();
  await opened.getByLabel('Reason').fill('The review is complete');
  await opened.getByRole('button', { name: 'Mark done' }).click();
  await card.waitFor({ state: 'detached' });

  const add = dateRow.getByRole('button', { name: 'Add date' });
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
  await added.getByRole('button', { name: 'Phase effective date' }).click();
  await added.getByRole('dialog').getByText('Signed by both sides', { exact: false }).waitFor();
  await page.screenshot({ path: join(evidence, 'engine-added-phase-date.png') });
  await page.keyboard.press('Escape');

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
    assert.equal(await card.locator('.date-open').textContent(), label);
    await card.locator('.date-open').click();
    await card.getByRole('dialog').getByText('Example clause', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
  }

  const path = page.getByRole('region', { name: 'Deal path' });
  await path.getByRole('button', { name: 'Site Selection', exact: true }).click();
  await path.getByRole('button', { name: 'Move to Site Selection' }).click();
  await path.locator('[aria-current="step"][data-phase="site_selection"]').waitFor();
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
  const row = { id: deal, deal_id: deal, name: 'Example Website Deal', phase: 'research', seen: 1, owner: 'joe', client_id: crypto.randomUUID() };
  const writes = [];
  const passwordRequests = [];
  page.on('request', request => {
    if (request.postData()?.includes(password)) passwordRequests.push(new URL(request.url()).pathname);
  });
  let registered = false;
  const env = {
    CLIENT_WEBSITE_ORIGIN: new URL(website).origin,
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

  await overview.getByText('Set up client website', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await overview.getByText(/Client website/).count(), 0, 'the Overview has no website link');
  await page.getByRole('tab', { name: 'Client portal', exact: true }).click();
  const portal = page.getByRole('tabpanel', { name: 'Client portal' });
  const open = portal.getByRole('button', { name: /^Open as client/ });
  await open.waitFor();
  await portal.screenshot({ path: join(evidence, 'client-website-deal.png') });
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

async function clientWebsitePage(t, { readsOn = true, savesOn = true, closed = false, linked = true, width = 1280, nextActions = [], fixtureOrigin = origin } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  t.after(() => page.close());
  const deal = crypto.randomUUID();
  const website = 'https://share.doctorcre.com/example-website';
  const grant = crypto.randomUUID();
  const row = { id: deal, deal_id: deal, name: 'Example Website Deal', phase: closed ? 'closed' : 'research',
    ...(closed ? { outcome: 'won' } : {}), seen: 1, owner: 'dell', client_id: crypto.randomUUID(),
    client_portal_url: linked ? website : null };
  const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: closed ? [] : [row, {
    id: crypto.randomUUID(), name: 'Example Deal Without Website', phase: 'research', owner: 'joe',
  }] };
  const enginePaths = [];
  const env = {
    CLIENT_WEBSITE_ORIGIN: new URL(website).origin,
    ENGINE_ROUTING: { get: async key => ({ 'deals-from-engine': readsOn, 'deals-saves-from-engine': savesOn }[key] ? 'on' : null) },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      enginePaths.push(path);
      if (path === '/api/engine/deals') return Response.json(board);
      if (path === `/api/engine/deals/${deal}`) return Response.json({ ...row, next_actions: nextActions, items: nextActions.filter(step => step.title), email_follow_ups: [] });
      assert.equal(path, `/api/engine/deals/${deal}/client-website/open`);
      return Response.json({ url: `${website}/?grant=${grant}` });
    } },
    CARR: { fetch: async request => {
      const { id, params } = await request.json();
      const data = params.name === 'get-deal-room' ? row : board;
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    } },
  };
  await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: 'engine-client-website', viewer: 'joe', reset: true } });
  await routeClientWebsiteWorker(page, env);
  return { page, deal, row, website, grant, enginePaths };
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
    await page.goto(`${origin}/deals?deal=${deal}&tab=client-portal&mode=live`);
    await page.getByRole('tabpanel', { name: 'Client portal' }).getByRole('button', { name: /^Open as client/ }).click();
    await page.getByText(toast, { exact: true }).waitFor();
    assert.deepEqual(requests, blocked ? [] : ['POST']);
    assert.equal(page.context().pages().length, 1);
  });
}

for (const [width, readsOn, savesOn] of [
  [1440, true, false], [390, true, false], [1440, false, false], [390, false, false],
  [1440, true, true], [390, true, true],
]) {
  test(`the deal page opens the client website with Deals reads ${readsOn ? 'on' : 'off'} and saves ${savesOn ? 'on' : 'off'} at ${width}px`, async t => {
    const { page, deal, website, grant, enginePaths } = await clientWebsitePage(t, { readsOn, savesOn, width });
    await page.context().route(url => url.href === website || url.href === `${website}/?grant=${grant}`, route =>
      route.fulfill({ body: '<h1>Example client website</h1>', contentType: 'text/html' }));
    await page.goto(`${origin}/deals?mode=live`);
    const card = page.locator('.kanban-card').getByRole('button', { name: 'Example Website Deal', exact: true });
    await card.waitFor();
    assert.equal(await page.locator('#kanban').getByText('Client website', { exact: false }).count(), 0);
    assert.equal(enginePaths.includes('/api/engine/deals'), readsOn);
    const grants = () => enginePaths.filter(path => path.endsWith('/client-website/open'));
    assert.deepEqual(grants(), []);
    await card.click();
    if (readsOn) await page.getByRole('tab', { name: 'Client portal', exact: true }).click();
    const open = readsOn
      ? page.getByRole('tabpanel', { name: 'Client portal' }).getByRole('button', { name: /^Open as client/ })
      : page.getByRole('region', { name: 'Deal snapshot' }).getByRole('link', { name: /Client website/ });
    await open.focus();
    const popupOpened = page.waitForEvent('popup');
    await page.keyboard.press('Enter');
    const popup = await popupOpened;
    await popup.getByRole('heading', { name: 'Example client website' }).waitFor();
    assert.equal(popup.url(), readsOn ? `${website}/?grant=${grant}` : website);
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.deepEqual(grants(), readsOn ? [`/api/engine/deals/${deal}/client-website/open`] : []);
    assert.equal(new URL(page.url()).searchParams.get('deal'), deal);
  });
}

for (const width of [1440, 390]) test(`Timeline shows read-only history from the old system at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Los_Angeles' });
  t.after(() => page.close());
  await page.clock.setFixedTime(new Date('2026-11-18T15:00:00Z'));
  const deal = crypto.randomUUID();
  const row = { id: deal, deal_id: deal, name: 'Example Timeline Deal', phase: 'legal', seen: 1, owner: 'joe' };
  const thread = [{ id: 'copied-note', kind: 'note', text: 'Tour plans confirmed', actor: 'dell', created_at: '2026-11-17T20:00:00Z' }];
  const copiedStepText = 'Confirm the sample drawings';
  const stepNote = (id, text, created_at) => ({ id, kind: 'note', actor: 'joe',
    text: `Recorded next step\n\n${text}`, created_at });
  thread.push(
    stepNote('first-step-note', copiedStepText, '2025-01-03T10:00:00.000002Z'),
    stepNote('second-step-note', copiedStepText, '2025-01-03T10:00:00.000004Z'),
  );
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
    ['operating_state', { state: 'parked', reason: 'other' }, 'Parked · Other'],
    ['operating_state', { state: 'parked', reason: 'prospect_never_active', note: 'Example note' }, 'Parked · Prospect never active · Example note'],
    ['operating_state', { state: 'parked', note: 'Example revised note' }, 'Parked · Example revised note'],
    ['operating_state', { state: 'active' }, 'Active again'],
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
  const imported_deal_history = [
    { actor: 'dell', verb: 'set-next-action', field: 'next_date', old_value: { next_date: '2025-01-06' }, new_value: { next_date: null } },
    { actor: 'agent', verb: 'record-finding', field: 'address', new_value: { found: false, expires_on: '2025-02-03' } },
    { actor: 'joe', verb: 'prepare-document', field: 'document', new_value: { template: 'Example lease <draft>', filled: 0, owed: 2 } },
    { actor: 'joe', verb: 'new-deal', field: null, new_value: { deal_type: 'lease', reason: 'Renewal' } },
  ].map((entry, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, imported: true, old_value: null,
    occurred_at: '2025-01-03T10:00:00Z', recorded_at: `2025-01-0${i === 0 ? 5 : 6}T00:00:00Z`,
    ...entry,
  }));
  imported_deal_history.unshift({ id: 'copied-step-event', imported: true, actor: 'joe', verb: 'set-next-step',
    field: 'next_step', new_value: { next_step: copiedStepText, next_date: '2025-01-08' },
    occurred_at: '2025-01-03T10:00:00.000001Z', recorded_at: '2025-01-03T10:00:00.000003Z' });
  const detail = { ...row, thread, events, imported_deal_history, email_follow_ups: [], correspondence: [],
    phase_started_on: { legal: '2026-11-17' },
    activities: [{ id: 'empty-call', kind: 'call', summary: ' ', occurred_at: beforeDocument }],
    documents: [{ id: 'file', name: 'Example plan.pdf', actor: 'mail_capture', prepared_at: '2026-11-16T14:00:00Z' }],
    next_actions: [
      { id: 'step', owner: 'dell', actor: 'joe', description: 'Check the floor plan', status: 'open', updated_at: '2026-11-17T18:00:00Z' },
      { id: 'checklist', owner: 'dell', actor: 'dell', title: 'Review the checklist', status: 'open', updated_at: beforeDocument },
      ...stepChanges.map(([description, status]) => ({
        id: status, owner: 'dell', actor: 'joe', description, status, due_on: '2026-11-19', updated_at: beforeDocument,
      })),
    ],
    critical_dates: dates.map(([id, kind, status]) => ({
      id, kind, status, due_on: '2026-11-19', actor: 'dell',
      updated_at: status === 'open' ? '2026-11-17T19:00:00Z' : beforeDocument,
    })),
  };
  let readsOn = false, savesOn = false;
  const carr = [], engine = [];
  const env = {
    ENGINE_ROUTING: { get: async key => ({ 'deals-from-engine': readsOn, 'deals-saves-from-engine': savesOn })[key] ? 'on' : null },
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
        : { ...row, thread, imported_deal_history, phase_started_on: detail.phase_started_on };
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    } },
  };
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `engine-timeline-${width}`, viewer: 'joe', reset: true } });
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'get-deal-room', 'add-deal-note'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  const timeline = page.getByRole('tabpanel', { name: 'Activity' });
  const oldHistory = timeline.getByRole('region', { name: 'History from the old system' });
  const openTimeline = async () => {
    await page.getByRole('tab', { name: 'Activity' }).click();
    assert.equal(await timeline.getByLabel('Filter by kind').count(), 1);
    await timeline.getByText('Tour plans confirmed', { exact: true }).first().waitFor();
  };
  await page.goto(`${origin}/deals?deal=${deal}&mode=live`);
  await openTimeline();
  await timeline.screenshot({ path: join(evidence, `timeline-wording-${width}.png`) });
  assert.equal(await timeline.getByText('Phase timeline', { exact: true }).count(), 1);
  assert.ok(carr.includes('get-deal-room'));
  assert.deepEqual(engine, []);
  assert.equal(await oldHistory.count(), 0);

  readsOn = true;
  await page.reload();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await timeline.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await timeline.getByText('Tour plans confirmed', { exact: true }).first().waitFor();
  assert.equal(await timeline.getByLabel('Filter by kind').count(), 0);
  assert.equal(await timeline.getByText('Phase timeline', { exact: true }).count(), 0);
  assert.equal(await oldHistory.count(), 0);
  assert.equal(await timeline.getByText('Dated events', { exact: true }).count(), 0);
  const rows = timeline.locator('.activity-row:not([hidden])');
  const line = async row => (await row.innerText()).replace(/\s+/g, ' ');
  const titles = () => timeline.locator('.activity-title').allTextContents();
  assert.equal(await rows.count(), 22);
  assert.equal(await timeline.locator('.activity-row :is(a, input, select, textarea, [contenteditable], button:not(.activity-open))').count(), 0);
  assert.equal(await timeline.locator('.activity-row > button.activity-open').count(), 22);
  assert.match(await line(rows.nth(0)), /^Moved to Legal Written by the assistant · Nov 17, 7:00 PM$/);
  assert.match(await line(rows.nth(1)), /^Tour plans confirmed Dell · Nov 17, 2:00 PM$/);
  assert.match(await line(rows.nth(3)), /^Example plan\.pdf Mail filing · Nov 16, 8:00 AM$/);
  const titleText = await titles();
  assert.match(titleText.find(text => text.startsWith('Opened the deal')), /Deal kind: Lease.*Deal reason: Renewal/);
  assert.match(titleText.find(text => text.startsWith('Prepared a document')), /Example lease <draft>.*Fields filled: 0.*Fields still needed: 2/);
  assert.match(titleText.find(text => text.startsWith('Checked the address')), /Result: Nothing found.*Feb 3, 2025/);
  assert.match(titleText.find(text => text.startsWith('Changed the next step date')), /Next step date cleared \(was Jan 6, 2025\)/);
  assert.equal(titleText.filter(text => text.includes(copiedStepText)).length, 3);
  assert.equal(titleText.filter(text => text.startsWith('Recorded next step')).length, 2);
  for (const description of ['Needs attention', ...dealChanges.map(([, , label]) => label)]) {
    assert.equal(titleText.filter(text => text === description).length, 1, description);
  }
  for (const [description, , state] of stepChanges) {
    assert.equal(titleText.includes(`${description} · ${state} · Due Nov 19, 2026`), true, `Finished next step should say ${state}`);
  }
  for (const [, , , caption] of dates) assert.equal(titleText.some(text => text.includes(caption)), false, caption);
  assert.equal(titleText.some(text => text.includes('Check the floor plan') || text.includes('Review the checklist')), false);
  const blob = await rows.evaluateAll(nodes => nodes.map(node => node.innerText).join('\n'));
  assert.doesNotMatch(blob, /2026-11-|2025-01-|next_date|set-next-action|record-finding|expires_on|\[object Object\]|move-phase|add deal note|Active work ·|Attention flag/);
  await rows.filter({ hasText: 'Parked · Other' }).screenshot({ path: join(evidence, `timeline-parking-${width}.png`) });
  const beforeNote = await titles();

  savesOn = true;
  await page.reload();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByText('Add step', { exact: true }).click();
  await page.getByText('Add a note', { exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Overview' }).getByLabel('Note', { exact: true }).fill('Tour plans confirmed');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.locator('#detailUpdateStatus').getByText('Update added', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await timeline.getByText('Tour plans confirmed', { exact: true }).first().waitFor();
  const notes = rows.filter({ hasText: 'Tour plans confirmed' });
  assert.equal(await notes.count(), 2);
  assert.match(await line(notes.nth(0)), /Joe · Nov 18, 9:00 AM/);
  assert.match(await line(notes.nth(1)), /Dell · Nov 17, 2:00 PM/);
  assert.doesNotMatch(carr.join(' '), /add-deal-note/);
  const chips = timeline.getByRole('group', { name: 'Activity filter' });
  await chips.getByRole('button', { name: 'Notes', exact: true }).click();
  assert.equal(await rows.count(), 4);
  await chips.getByRole('button', { name: 'All', exact: true }).click();
  assert.deepEqual((await titles()).slice(1), beforeNote);
  assert.equal(engine.filter(path => path === '/api/engine/activities').length, 1);
  await timeline.locator('.activity-list').screenshot({ path: join(evidence, `imported-deal-history-${width}.png`) });
});

for (const width of [1440, 390]) {
  test(`Monday review keeps engine order and your place at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    t.after(() => page.close());
    const origin = await dealFixtureOrigin(t);
    await page.clock.setFixedTime(new Date('2026-11-16T04:00:00Z'));
    const [deal, prospect, dropped, parked] = Array.from({ length: 4 }, () => crypto.randomUUID());
    const row = { id: deal, deal_id: deal, name: 'Zephyr Deal', phase: 'research', owner: 'dell', seen: 1,
      seen_change_id: 1, next_step: 'Check the lease', next_date: '2026-11-10' };
    const next_actions = [
      { id: crypto.randomUUID(), owner: 'dell', status: 'open', description: row.next_step, due_on: row.next_date, change_id: 3 },
      { id: crypto.randomUUID(), owner: 'joe', status: 'open', title: 'Checklist item', description: 'Checklist item', change_id: 4 },
      { id: crypto.randomUUID(), owner: 'joe', status: 'open', description: 'Send a draft', due_on: row.next_date,
        change_id: 5 },
    ];
    const prospectNote = { by: 'dell', at: '2026-11-09T15:00:00Z', summary: 'Example prospect note' };
    const prospectRow = { party_id: prospect, name: 'Birch Prospect', owner: null, how_found: 'referral',
      change_id: 2, latest_note: prospectNote, reviewed: null, seen_change_id: 0, state: 'open', needs_attention: true,
      follow_ups: [{ next_step_id: prospect, owner: 'joe', change_id: 1, what: 'Relationship touch — Birch. 45-day lead cadence.',
        display_title: 'Check in with Birch Person (lead)', due_on: '2026-11-16' }] };
    const droppedRow = { ...prospectRow, party_id: dropped, name: 'Cedar Prospect', state: 'dropped',
      dropped: { at: '2026-11-10T01:00:00Z', by: 'dell', reason: 'Plans changed' }, needs_attention: false,
      follow_ups: [] };
    const parkedRow = { deal_id: parked, name: 'Alder Deal', phase: 'pending', reviewed: null, seen: 2,
      state: 'open', seen_change_id: 0, operating_state: 'parked', needs_attention: true };
    const reviewId = crypto.randomUUID();
    let review = [
      { ...row, attention: { reason: 'A next step is late.', since: '2026-11-11' }, reviewed: { review_id: reviewId, by: 'joe', at: '2026-11-09T15:00:00Z' }, state: 'open' }, prospectRow, droppedRow, parkedRow,
    ];
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `monday-review-${width}`, viewer: 'joe', reset: true } });
    let enabled = false, savesOn = false, boardReads = 0, refuseMark = false, raceStep = false;
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
            if (body.party_id) Object.assign(prospectRow.follow_ups[0], { what: body.what, display_title: body.what });
            else if (body.deal_id === deal) {
              if (raceStep) {
                raceStep = false;
                Object.assign(next_actions[2], { description: 'Send the revised plan', change_id: 9 });
                return Response.json({ error: 'version_conflict' }, { status: 409 });
              }
              Object.assign(next_actions[2], { description: body.what, due_on: body.due_on, change_id: 8 });
              Object.assign(review[0], { next_step: body.what, next_date: body.due_on });
            }
            return Response.json({ next_step_id: crypto.randomUUID(), change_id: 8 }, { status: 201 });
          }
          if (refuseMark) return Response.json({ error: 'actor_not_provisioned' }, { status: 422 });
          const undo = url.pathname.endsWith('/remove');
          const item = review.find(item => undo
            ? url.pathname.endsWith(`/${item.reviewed?.review_id}/remove`)
            : body.party_id ? item.party_id === body.party_id : item.deal_id === body.deal_id);
          assert.ok(item);
          if (item.seen_change_id !== body.seen_change_id)
            return Response.json({ error: 'version_conflict', current_version: item.seen_change_id }, { status: 409 });
          item.seen_change_id++;
          const review_id = item.reviewed?.review_id ?? crypto.randomUUID();
          item.reviewed = undo ? null : { review_id, by: 'joe', at: '2026-11-09T15:00:00Z' };
          return Response.json({ review_id }, { status: undo ? 200 : 201 });
        }
        if (url.pathname === '/api/engine/weekly-reviews') {
          weeks.push(url.searchParams.get('week_of'));
          return Response.json({ items: review });
        }
        if (url.pathname === '/api/engine/prospects') return Response.json({ count: 0, prospects: [] });
        if (url.pathname.endsWith(dropped)) return Response.json({ ...droppedRow,
          notes: [{ ...prospectNote, activity_id: crypto.randomUUID() }] });
        if (url.pathname.endsWith(prospect)) return Response.json({ ...prospectRow, notes: [] });
        if (url.pathname.endsWith(parked)) return Response.json(parkedRow);
        if (url.pathname.endsWith(deal)) return Response.json({ ...row, next_step: review[0].next_step, next_date: review[0].next_date,
          next_actions, email_follow_ups: [], thread: [...dealNotes,
          { id: 'example-note', kind: 'note', text: 'Example new note', actor: 'joe', recorded_at: '2026-11-09T15:00:00Z' },
        ] });
        if (url.pathname === '/api/engine/deals') boardReads++;
        return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] });
      } },
      CARR: { fetch: async request => {
        if (request.method === 'GET') return new Response('Signed in');
        const { id } = await request.json();
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ deals: [row] }) }] } });
      } },
    };
    const routeReview = target => target.route(url => url.pathname === '/mcp' || url.pathname.startsWith('/api/engine/weekly-reviews')
      || url.pathname.startsWith('/api/engine/prospects')
      || (url.pathname === '/deals' && ['review', 'dropped-prospect'].includes(url.searchParams.get('view'))), async route => {
      const request = route.request();
      if (new URL(request.url()).pathname === '/mcp' && !['deal-room-board', 'get-deal-room', 'add-deal-note', 'set-next-step'].includes(request.postDataJSON()?.params?.name))
        return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await routeReview(page);
    const reviewPath = `${origin}/api/engine/weekly-reviews?week_of=2026-11-09`;
    assert.equal((await handleDoctorcreRequest(new Request(reviewPath), env)).status, 404);
    await page.goto(`${origin}/deals?view=review&mode=live`);
    assert.equal(new URL(page.url()).searchParams.get('view'), null);
    await page.getByRole('button', { name: row.name, exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Monday review' }).count(), 0);
    assert.deepEqual(weeks, []);

    enabled = true;
    const closedRead = await handleDoctorcreRequest(new Request(reviewPath), env);
    assert.equal(closedRead.status, 404);
    assert.deepEqual(await closedRead.json(), { error: 'not_found' });
    const closedSave = new Request(reviewPath, { method: 'POST', headers: { 'x-carr-csrf': 'synthetic' },
      body: JSON.stringify({ deal_id: deal, week_of: '2026-11-09', seen_change_id: 1, idempotency_key: crypto.randomUUID() }) });
    assert.equal((await handleDoctorcreRequest(closedSave, env)).status, 404);
    await page.goto(`${origin}/deals?view=review&mode=live`);
    assert.equal(new URL(page.url()).searchParams.get('view'), null);
    await page.getByRole('button', { name: row.name, exact: true }).waitFor();
    assert.equal(await page.getByRole('main', { name: 'Monday review' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Monday review' }).count(), 0);
    assert.deepEqual(weeks, []);

    savesOn = true;
    await page.goto(`${origin}/deals?owner=joe&mode=live`);
    await page.getByRole('link', { name: 'Monday review' }).click();
    assert.equal(await page.title(), 'Monday review · DoctorCRE');
    await page.getByText('1 of 4 reviewed this week').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Parked', exact: true }).count(), 0);
    assert.deepEqual(weeks, ['2026-11-09']);
    await page.getByText(/Reviewed by Joe · Nov 9/).waitFor();
    await page.getByText('Example new note').waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('link', { name: 'Birch Prospect' }).waitFor();
    await page.getByText(/Prospect · Unclaimed · Needs attention/).waitFor();
    await page.getByText('Check in with Birch Person (lead) · Due Mon, Nov 16, 2026', { exact: true }).waitFor();
    assert.equal(await page.getByText(/Relationship touch/).count(), 0);
    await page.getByText(prospectNote.summary).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('link', { name: row.name }).waitFor();
    await page.getByRole('button', { name: 'As a list' }).click();
    const items = page.getByRole('main', { name: 'Monday review' }).getByRole('listitem');
    assert.deepEqual(await items.getByRole('link').allTextContents(), [row.name, 'Birch Prospect', 'Cedar Prospect', 'Alder Deal']);
    assert.match(await page.getByRole('link', { name: 'Birch Prospect' }).getAttribute('href'), new RegExp(`prospect=${prospect}`));
    const prospectItem = items.filter({ hasText: prospectRow.name });
    const note = prospectItem.getByText(prospectNote.summary);
    const latestNotes = prospectItem.getByText('Latest notes', { exact: true });
    assert.equal(await latestNotes.count(), 1);
    assert.equal(await note.isVisible(), false);
    await latestNotes.click();
    await note.waitFor();
    await latestNotes.click();
    await note.waitFor({ state: 'hidden' });
    await items.filter({ hasText: parkedRow.name }).getByText(/Unassigned · Parked/).waitFor();
    assert.equal(await items.filter({ hasText: parkedRow.name }).getByText(/Needs attention/).count(), 0, 'a stored flag on a deal is not attention');
    assert.equal(await items.filter({ hasText: row.name }).getByText(/Needs attention/).count(), 1, "the engine's attention shows");
    await page.getByRole('checkbox', { name: 'Not reviewed' }).check();
    assert.deepEqual(await items.getByRole('link').allTextContents(), ['Birch Prospect', 'Cedar Prospect', 'Alder Deal']);
    const droppedItem = items.filter({ hasText: droppedRow.name });
    await droppedItem.getByRole('button', { name: 'Reviewed', exact: true }).waitFor();
    assert.equal(await droppedItem.getByLabel('Add note').count(), 0);
    const reviewPlace = () => page.evaluate(() => scrollY + document.getElementById('appMainSlot').scrollTop);
    await page.setViewportSize({ width, height: 420 });
    await droppedItem.evaluate(node => node.scrollIntoView({ block: 'end', behavior: 'instant' }));
    const place = await reviewPlace();
    assert.ok(place > 0, 'the review list scrolls at this height');
    await droppedItem.getByRole('link').click();
    const archive = page.getByRole('main', { name: droppedRow.name });
    await archive.getByText('Dropped Mon, Nov 9: Plans changed', { exact: true }).waitFor();
    await archive.getByRole('heading', { name: 'Notes', level: 2 }).waitFor();
    await archive.getByText(prospectNote.summary).waitFor();
    assert.equal(await archive.getByRole('button').count(), 0);
    assert.equal(await archive.locator('form').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, `monday-review-dropped-${width}.png`), fullPage: true });
    await archive.getByRole('link', { name: 'Back to Monday review' }).click();
    await page.getByRole('button', { name: 'As a list', pressed: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Not reviewed' }).isChecked(), true);
    await page.getByRole('link', { name: droppedRow.name }).and(page.locator(':focus')).waitFor();
    assert.ok(Math.abs((await reviewPlace()) - place) <= 2, 'Monday review returns to the same scroll place');
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'One at a time' }).click();
    await page.getByRole('link', { name: droppedRow.name }).waitFor();
    await page.getByRole('button', { name: 'As a list' }).click();
    await page.getByRole('checkbox', { name: 'Not reviewed' }).uncheck();
    await page.getByRole('link', { name: 'Birch Prospect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Birch Prospect' });
    await dialog.getByText(/Joe · Check in with Birch Person \(lead\)/).waitFor();
    await dialog.getByRole('button', { name: 'Back to Monday review' }).click();
    await page.getByRole('button', { name: 'As a list', pressed: true }).waitFor();
    await page.getByRole('link', { name: prospectRow.name }).and(page.locator(':focus')).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, `monday-review-${width}.png`), fullPage: true });
    await page.getByRole('link', { name: row.name }).click();
    await page.locator('#panelTitle').getByText(row.name).waitFor();
    await page.getByRole('button', { name: 'Back to Monday review' }).click();
    await page.getByRole('button', { name: 'As a list', pressed: true }).waitFor();
    assert.deepEqual(await items.getByRole('link').allTextContents(), [row.name, 'Birch Prospect', 'Cedar Prospect', 'Alder Deal']);
    await page.getByRole('link', { name: parkedRow.name }).click();
    await page.locator('#panelTitle').getByText(parkedRow.name).waitFor();

    const originalReview = review;
    review = review.map(item => ({ ...item, reviewed: review[0].reviewed }));
    await page.getByRole('button', { name: 'Back to Monday review' }).click();
    await page.getByText('4 of 4 reviewed this week').waitFor();
    await page.getByRole('checkbox', { name: 'Not reviewed' }).check();
    assert.equal(await page.getByText('Everything is reviewed this week.', { exact: true }).isVisible(), true);
    assert.equal(await items.count(), 0);

    review = originalReview;
    const readsBeforeReview = boardReads;
    await page.goto(`${origin}/deals?view=review&mode=live`);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('0 of 4 reviewed this week').waitFor();
    await page.reload();
    await page.getByText('0 of 4 reviewed this week').waitFor();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('link', { name: prospectRow.name }).waitFor();
    await page.getByText('1 of 4 reviewed this week').waitFor();
    prospectRow.seen_change_id++;
    prospectRow.reviewed = { review_id: crypto.randomUUID(), by: 'dell', at: '2026-11-09T16:00:00Z' };
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByText('Changed by the other partner. Review reloaded.').waitFor();
    await page.getByText(/Reviewed by Dell/).waitFor();
    assert.equal(writes.filter(([path]) => path.startsWith('/api/engine/weekly-reviews')).length, 3);

    const other = await browser.newPage({ viewport: { width, height: 900 } });
    t.after(() => other.close());
    const reviewTime = new Date('2026-11-16T04:00:00Z');
    await other.clock.install({ time: new Date(reviewTime.getTime() - 1000) });
    await other.clock.pauseAt(reviewTime);
    await other.request.post(`${origin}/api/test/seed`, {
      data: { namespace: `monday-review-other-${width}`, viewer: 'dell', reset: true },
    });
    await routeReview(other);
    await other.goto(`${origin}/deals?view=review&mode=live&layout=list&item=prospect-${prospect}`);
    const otherProspect = other.getByRole('listitem').filter({ hasText: prospectRow.name });
    await otherProspect.getByText('Latest notes', { exact: true }).click();
    await otherProspect.getByText(prospectNote.summary).waitFor();
    await otherProspect.getByText('Add note', { exact: true }).filter({ visible: true }).click();
    const prospectDraft = otherProspect.getByLabel('Add note');
    await prospectDraft.fill('Draft about the prospect');
    await page.getByLabel('Add note').fill('Example review note');
    await page.getByLabel('Add note').press('Enter');
    await page.getByText('Example review note', { exact: true }).waitFor();
    await other.clock.runFor(5000);
    await otherProspect.getByText('Example review note', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await prospectDraft.inputValue(), 'Draft about the prospect');
    assert.equal(await prospectDraft.and(other.locator(':focus')).count(), 1);
    assert.equal(await other.getByRole('button', { name: 'As a list', pressed: true }).count(), 1);
    await page.getByText('Follow-up', { exact: true }).click();
    await page.getByLabel('Your follow-up').fill('Confirm the address');
    await page.getByLabel('Follow-up date').fill('2026-11-17');
    await page.getByRole('button', { name: 'Set your follow-up' }).click();
    await page.getByText(/Confirm the address · Due/).waitFor();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await page.getByLabel('Add note').getAttribute('placeholder'), 'Write a note and press Enter');
    await other.getByRole('button', { name: 'One at a time' }).click();
    await other.getByRole('button', { name: 'Back', exact: true }).click();
    await other.getByText('Example new note').waitFor();
    const draft = other.getByLabel('Add note');
    await draft.fill('Unsent note from Dell');

    await page.getByRole('button', { name: 'As a list' }).click();
    const writer = items.filter({ has: page.getByRole('link', { name: row.name, exact: true }) });
    await writer.getByText('Add note', { exact: true }).filter({ visible: true }).click();
    await writer.getByLabel('Add note').fill('Example deal note');
    await writer.getByLabel('Add note').press('Enter');
    await writer.getByText('Note added.', { exact: true }).waitFor();
    await other.clock.runFor(5000);
    await other.getByText('Example deal note', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await draft.inputValue(), 'Unsent note from Dell');
    assert.equal(await draft.and(other.locator(':focus')).count(), 1);
    assert.equal(new URL(other.url()).searchParams.get('item'), `deal-${deal}`);
    assert.equal(await page.getByRole('button', { name: 'As a list', pressed: true }).count(), 1);
    await page.getByRole('button', { name: 'One at a time' }).click();
    await page.getByText('Example deal note', { exact: true }).waitFor();
    await page.getByText('Change next step', { exact: true }).click();
    const step = page.getByLabel('Next step', { exact: true });
    const nextDate = page.getByLabel('Next date');
    const stepBody = () => writes.filter(([path]) => path === '/api/engine/next-steps').at(-1)?.[1];
    const saveStep = () => page.getByRole('button', { name: 'Save next step' }).click();
    await step.waitFor();
    assert.equal(await step.inputValue(), 'Send a draft');
    assert.equal(await nextDate.inputValue(), '');
    await page.getByText('Current next date is overdue.').waitFor();
    await step.fill('Send the plan');
    await saveStep();
    await page.getByText('Next step saved.').waitFor();
    assert.equal(Object.hasOwn(stepBody(), 'due_on'), false);
    assert.deepEqual(stepBody().seen_current_step, { next_step_id: next_actions[2].id, change_id: 5 });
    assert.equal(writes.filter(([path]) => path === '/api/engine/activities').length, 2);
    assert.equal(writes.filter(([path]) => path === '/api/engine/next-steps').length, 2);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, `monday-review-saves-${width}.png`), fullPage: true });
    if (width === 1440) {
      raceStep = true;
      await step.fill('Send the old plan');
      await saveStep();
      await page.getByText('The next step changed. Review it before saving again.').waitFor();
      await step.waitFor();
      assert.equal(await step.inputValue(), 'Send the revised plan');
      assert.equal(stepBody().seen_current_step.change_id, 8);
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('link', { name: droppedRow.name }).waitFor();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('link', { name: parkedRow.name }).waitFor();
    await page.getByText('3 of 4 reviewed this week').waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('2 of 4 reviewed this week').waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    refuseMark = true;
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByText('This account cannot change the review mark.').waitFor();
    await page.getByText('Change next step', { exact: true }).click();
    await step.fill('Call about the plan');
    await saveStep();
    await page.getByText('Next step saved.').waitFor();
    assert.equal(stepBody().deal_id, parked);
    assert.equal(stepBody().seen_current_step, null);
    assert.equal(boardReads, readsBeforeReview, 'Review paging does not reload the Deals board');
    if (width === 1440) {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('link', { name: row.name }).click();
      await page.getByText('Add step', { exact: true }).click();
      await page.getByText('Add a note', { exact: true }).click();
      await page.getByRole('tabpanel', { name: 'Overview', exact: true }).getByLabel('Note', { exact: true }).fill('Example deal page update');
      const localStep = page.getByLabel('Your next step', { exact: true });
      assert.equal(await localStep.inputValue(), 'Send the revised plan');
      await localStep.fill('Send the final plan');
      await page.getByRole('button', { name: 'Save next step', exact: true }).click();
      await page.locator('#detailUpdateStatus').getByText('Update added', { exact: true }).waitFor();
      assert.deepEqual(stepBody().seen_current_step, { next_step_id: next_actions[2].id, change_id: 9 });
    }
    review = review.filter(item => item.deal_id);
    await other.reload();
    await other.getByText('Example deal note', { exact: true }).waitFor();
    const priorWeekReads = weeks.length;
    const dealRefresh = other.waitForResponse(response => response.request().postDataJSON()?.params?.name === 'get-deal-room');
    await Promise.all([dealRefresh, other.clock.runFor(5000)]);
    assert.equal(weeks.length, priorWeekReads);

    review[0].state = 'closed';
    next_actions[2].due_on = '2026-11-10';
    await page.goto(`${origin}/deals?view=review&mode=live&item=deal-${deal}`);
    await page.getByText(/Research · Dell · Closed/).waitFor();
    await page.getByText('Change next step', { exact: true }).click();
    await step.waitFor();
    assert.equal(await page.getByText('Current next date is overdue.').count(), 0);
  });
}

async function dealFixtureOrigin(t) {
  const fixture = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  t.after(() => fixture.close());
  return fixture.origin;
}

for (const width of [1440, 390]) test(`the deal shows its emails and meetings together at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  const fixtureOrigin = await dealFixtureOrigin(t);
  await page.clock.install({ time: new Date('2026-11-19T18:00:00Z') });
  const deal = { deal_id: crypto.randomUUID(), name: 'Example Floor Plan', phase: 'research', owner: 'joe', seen: 1 };
  const subject = 'Floor plan <draft>';
  const title = 'Review the floor plan and confirm whether the revised layout has room for the extra exam room and the new reception desk';
  const email_threads = [{ subject, latest_message_at: '2026-11-19T17:30:00+00:00' }];
  const thread = [{ kind: 'note', text: 'Bring the sample plan', actor: 'joe', created_at: '2026-11-18T12:00:00Z' }];
  const correspondence = [
    { activity_id: 'new-email', kind: 'email', subject, sender_name: 'Example Architect', sender: 'design@example.test', happened_at: '2026-11-19T17:30:00+00:00' },
    { activity_id: 'meeting', kind: 'meeting', title, happened_at: '2026-11-19T16:00:00+00:00' },
    { activity_id: 'old-email', kind: 'email', subject, sender_name: null, sender: 'plans@example.test', happened_at: '2026-11-18T15:00:00+00:00' },
  ];
  const callSummary = 'Discussed the next showing';
  const activities = [
    ...correspondence.map(entry => ({ id: entry.activity_id, kind: entry.kind,
      summary: entry.kind === 'email' ? entry.subject : entry.title, occurred_at: entry.happened_at })),
    { id: 'call', kind: 'call', summary: callSummary, occurred_at: '2026-11-18T12:00:00Z', actor: 'joe' },
  ];
  let readsOn = false;
  let entries = correspondence;
  let waiting = [];
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' && readsOn ? 'on' : null },
    ENGINE: { fetch: async request => {
      assert.equal(new URL(request.url).pathname, `/api/engine/deals/${deal.deal_id}`);
      return Response.json({ ...deal, thread, email_threads, email_follow_ups: waiting, correspondence: entries, activities });
    } },
    CARR: { fetch: async request => {
      const { id } = await request.json();
      const detail = { ...deal, thread, email_threads, activities: [{ id: 'meeting', kind: 'meeting', source: 'calendar', summary: title, occurred_at: '2026-11-19T16:00:00Z' }] };
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(detail) }] } });
    } },
  };
  const seeded = await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: 'deal-correspondence', viewer: 'joe' } });
  assert.equal(seeded.status(), 200);
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (request.postDataJSON()?.params?.name !== 'get-deal-room') return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  const tab = page.getByRole('tab', { name: 'Activity' });
  const panel = page.getByRole('tabpanel', { name: 'Activity' });
  await page.goto(`${fixtureOrigin}/deals?deal=${deal.deal_id}&mode=live`);
  await tab.click();
  await panel.getByRole('heading', { name: 'Email threads', exact: true }).waitFor();
  await panel.getByRole('heading', { name: 'Meetings', exact: true }).waitFor();

  readsOn = true;
  await page.reload();
  await tab.click();
  const rows = panel.locator('.activity-row');
  await rows.nth(0).getByText('Example Architect', { exact: false }).waitFor({ timeout: 5_000 });
  assert.equal(await rows.count(), 5);
  assert.match(await rows.nth(0).innerText(), /Floor plan <draft>[\s\S]*Example Architect[\s\S]*Nov 19, 11:30 AM/);
  assert.match(await rows.nth(1).innerText(), /^Review the floor plan[\s\S]*Nov 19, 10:00 AM/);
  assert.match(await rows.nth(2).innerText(), /Floor plan <draft>[\s\S]*plans@example\.test[\s\S]*Nov 18, 9:00 AM/);
  assert.equal(await panel.getByText('Bring the sample plan', { exact: true }).count(), 1);
  assert.equal(await panel.getByText(callSummary, { exact: true }).count(), 1);
  assert.equal(await page.getByText('File email to this deal', { exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.screenshot({ path: join(evidence, `deal-correspondence-${width}.png`) });

  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const overview = page.getByRole('tabpanel', { name: 'Overview', exact: true });
  assert.ok(await overview.getByText(callSummary, { exact: true }).count());
  for (const text of [subject, title]) {
    assert.equal(await overview.locator('.deal-opening-snapshot').getByText(text, { exact: true }).count(), 0, `Next steps show ${text}`);
  }
  await tab.click();
  thread.length = 0;
  activities.length = 0;
  entries = [];
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await panel.getByText('Nothing recorded yet.', { exact: true }).waitFor();
  assert.equal(await rows.count(), 0);
  waiting = [{ proposal_id: crypto.randomUUID(), kind: 'file_to_deal', email: { subject: '' } }];
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await panel.getByText('No emails or meetings filed yet. 1 email is waiting to be filed on Overview.', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.screenshot({ path: join(evidence, `deal-correspondence-waiting-${width}.png`) });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`a partner can finish deal steps at ${width}px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  await page.clock.setFixedTime(new Date('2026-11-20T16:00:00Z'));
  const fixtureOrigin = await dealFixtureOrigin(t);
  const deal = crypto.randomUUID();
  const row = { id: deal, deal_id: deal, name: 'Example Deal', owner: 'joe', phase: 'research', seen: 23 };
  const own = { id: crypto.randomUUID(), description: 'Send the sample plan. Confirm access with the property manager before sending it to the tenant.', owner: 'joe', due_on: '2026-11-24', status: 'open', change_id: 10,
    display_title: 'Send the sample plan.',
    display_instruction: 'Send the sample plan. Confirm access with the property manager before sending it to the tenant.',
    set_by: 'Example Partner', set_at: '2026-10-29T13:51:00Z' };
  const other = { ...own, id: crypto.randomUUID(), owner: 'dell', due_on: null, change_id: 11,
    set_by: null, set_at: '2026-10-30T14:30:00Z' };
  const writes = [];
  let ownReceipt;
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/deals') return Response.json({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [row] });
      if (path === `/api/engine/deals/${deal}`) return Response.json({ ...row, email_follow_ups: [], next_actions: [own, other] });
      const step = [own, other].find(step => path === `/api/engine/next-steps/${step.id}/end`);
      assert.ok(step, `Unexpected engine path ${path}`);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('origin'), fixtureOrigin);
      assert.ok(request.headers.get('x-carr-csrf'));
      const body = await request.json();
      assert.equal(body.resolution, 'done');
      assert.match(body.idempotency_key, /^[\da-f-]{36}$/i);
      writes.push({ id: step.id, ...body });
      if (step === own && ownReceipt) return Response.json(ownReceipt);
      if (body.base_version !== step.change_id)
        return Response.json({ error: 'version_conflict', current_version: step.change_id }, { status: 409 });
      const change_id = step.change_id + 1;
      Object.assign(step, { status: 'done', actor: 'joe', updated_at: '2026-11-20T17:00:00Z', change_id: null });
      const receipt = { next_step_id: step.id, status: 'done', change_id };
      if (step === own) {
        ownReceipt = receipt;
        return Response.json({ ...receipt, change_id: body.base_version });
      }
      return Response.json(receipt);
    } },
  };
  const seeded = await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: 'deal-step-done', viewer: 'joe' } });
  assert.equal(seeded.status(), 200);
  await page.route(/\/(mcp|api\/engine\/next-steps\/[^/]+\/end)$/, async route => {
    const request = route.request();
    if (new URL(request.url()).pathname === '/mcp' &&
      !['deal-room-board', 'get-deal-room'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  await page.goto(`${fixtureOrigin}/deals?deal=${deal}&mode=live`);
  const snapshot = page.getByRole('region', { name: 'Deal snapshot' });
  const steps = snapshot.getByRole('region', { name: 'Next steps' });
  const stepRows = steps.getByRole('listitem');
  const ownRow = stepRows.filter({ hasText: 'Set by Example Partner' });
  const otherRow = stepRows.filter({ hasText: 'Set Oct 30' });
  await steps.getByText(own.description, { exact: true }).first().waitFor();
  assert.equal(await stepRows.count(), 1, 'Both owners share one list item');
  assert.equal(await ownRow.locator('strong').textContent(), own.display_title);
  assert.equal(await steps.getByText(own.description, { exact: true }).count(), 1);
  await ownRow.getByText(/^Joe · Due/).waitFor();
  await ownRow.getByText('Set by Example Partner · Oct 29, 8:51 AM', { exact: true }).waitFor();
  await otherRow.getByText('Dell · No due date', { exact: true }).waitFor();
  await otherRow.getByText('Set Oct 30, 9:30 AM', { exact: true }).waitFor();
  const capture = (region, stage) => region.screenshot({ path: join(evidence, `deal-step-${stage}-${width}-${theme}.png`), animations: 'disabled' });
  await capture(snapshot, 'open');
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  const done = steps.getByRole('button', { name: 'Done', exact: true });
  assert.equal(await done.count(), 2);
  for (const button of await done.all()) {
    await button.scrollIntoViewIfNeeded();
    assert.ok(await button.evaluate((el, floor) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return width >= floor && height >= floor && el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }, controlFloor(width)), 'Done has an unobstructed full-size target');
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const otherDone = steps.getByRole('button', { name: 'Done', exact: true, description: /Dell/ });
  await steps.getByRole('button', { name: 'Done', exact: true, description: /Joe/ }).focus();
  await page.keyboard.press('Tab');
  assert.ok(await otherDone.evaluate(el => {
    const { outlineStyle, outlineWidth } = getComputedStyle(el);
    return el.matches(':focus-visible') && outlineStyle === 'solid' && parseFloat(outlineWidth) > 0;
  }), 'Tab reaches Done and shows a focus ring');
  await capture(page, 'focus');

  other.change_id = 15;
  await otherDone.focus();
  await page.keyboard.press('Enter');
  await page.getByText('This step changed. Review the latest version.', { exact: true }).waitFor();
  assert.equal(await stepRows.count(), 1);
  assert.equal(other.status, 'open');
  assert.ok(await otherDone.evaluate(button => document.activeElement === button));

  await page.keyboard.press('Enter');
  await otherDone.waitFor({ state: 'hidden' });
  assert.equal(other.status, 'done');
  assert.equal(own.status, 'open');
  assert.equal(await stepRows.count(), 1);
  assert.equal(await ownRow.getByText(own.description, { exact: true }).count(), 1);
  await ownRow.getByRole('button', { name: 'Done', exact: true, description: /Joe/ }).waitFor();
  await page.getByRole('tab', { name: 'Activity' }).click();
  const timeline = page.getByRole('tabpanel', { name: 'Activity' });
  const otherDoneRow = timeline.locator('.activity-row', { hasText: other.description });
  await otherDoneRow.waitFor();
  assert.match((await otherDoneRow.innerText()).replace(/\s+/g, ' '), /Done.*Joe/);

  Object.assign(row, { phase: 'closed', outcome: 'won' });
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Refresh deal' }).click();
  const ended = steps.getByRole('heading', { name: 'Open before this deal ended', exact: true });
  await ended.waitFor();
  await capture(steps, 'ended');
  await steps.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Could not confirm this step is done. Choose Done again to check.', { exact: true }).waitFor();
  await steps.getByRole('button', { name: 'Done', exact: true }).click();
  await ended.waitFor({ state: 'hidden' });
  await snapshot.getByText('No next step set.', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Activity' }).click();
  const doneRows = timeline.locator('.activity-row', { hasText: own.description });
  await doneRows.nth(1).waitFor();
  assert.equal(await doneRows.count(), 2);
  assert.match((await doneRows.nth(0).innerText()).replace(/\s+/g, ' '), /Done.*Joe/);
  assert.match((await doneRows.nth(1).innerText()).replace(/\s+/g, ' '), /Done.*Joe/);
  await capture(timeline, 'timeline');
  assert.deepEqual(writes.map(({ id, base_version }) => [id, base_version]), [[other.id, 11], [other.id, 15], [own.id, 10], [own.id, 10]]);
  assert.notEqual(writes[0].idempotency_key, writes[1].idempotency_key);
  assert.deepEqual(writes[3], writes[2]);
});

for (const width of [1440, 390]) test(`a changed checklist item stays open until reviewed again at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  const fixtureOrigin = await dealFixtureOrigin(t);
  const deal = crypto.randomUUID();
  const step = { id: crypto.randomUUID(), title: 'Review the floor plan', due_on: '2026-11-24', status: 'open', change_id: 0 };
  const short = { ...step, id: crypto.randomUUID(), title: 'Call the office' };
  const url = `https://example.test/plans/${'long-path-'.repeat(25)}`;
  const instruction = `Confirm signage against the plan (${url}) before replying.`;
  const row = { id: deal, deal_id: deal, name: 'Example Deal', owner: 'joe', phase: 'research', seen: 23 };
  const writes = [];
  const env = {
    ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const { pathname } = new URL(request.url);
      const { change_id, ...item } = step;
      if (pathname === '/api/engine/deals') return Response.json({
        schema_version: 'local-deals-board.v2', actor: 'joe', deals: [{ ...row, items: [item] }],
      });
      if (pathname === `/api/engine/deals/${deal}`) return Response.json({
        ...row, email_follow_ups: [], items: [item, short],
        next_actions: [{ ...step, description: `Confirm signage against [the plan](${url}) before replying.`,
          display_title: step.title,
          display_instruction: instruction, change_id: step.status === 'open' ? change_id : null },
        { ...short, description: short.title, display_title: short.title, display_instruction: null }],
      });
      if (pathname !== `/api/engine/next-steps/${step.id}/end`) return new Response(null, { status: 404 });
      const command = await request.json();
      writes.push(command);
      if (command.base_version !== undefined && command.base_version !== change_id)
        return Response.json({ error: 'version_conflict', current_version: change_id }, { status: 409 });
      step.status = 'done';
      return Response.json({ next_step_id: step.id, status: 'done', change_id: change_id + 1 });
    } },
  };
  const seeded = await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: 'checklist-version', viewer: 'joe' } });
  assert.equal(seeded.status(), 200);
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'get-deal-room', 'complete-deal-item'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  await page.goto(`${fixtureOrigin}/deals?deal=${deal}&mode=live`);
  const stillNeeded = page.locator('#recordPanel .deal-items').getByRole('listitem').filter({ hasText: step.title });
  const title = stillNeeded.getByRole('button', { name: step.title, exact: true });
  await title.waitFor();
  const shortRow = page.locator('#recordPanel .deal-items').getByRole('listitem').filter({ hasText: short.title });
  assert.equal(await shortRow.getByText(short.title, { exact: true }).count(), 1);
  await shortRow.getByRole('button', { name: short.title }).click();
  const shortSheet = page.getByRole('dialog', { name: short.title });
  await shortSheet.waitFor();
  assert.equal(await shortSheet.getByText(short.title, { exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  const body = stillNeeded.getByText(instruction, { exact: true });
  assert.equal(await body.isVisible(), true);
  const heading = await title.boundingBox();
  assert.ok((await body.boundingBox()).y >= heading.y + heading.height);
  assert.ok(await body.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight));
  await title.click();
  const sheet = page.getByRole('dialog', { name: step.title });
  const done = sheet.getByRole('button', { name: 'Mark done', exact: true });
  await done.waitFor();
  assert.equal(await sheet.getByText(instruction, { exact: true }).isVisible(), true);
  Object.assign(step, { due_on: '2026-11-26', change_id: 17 });
  await done.click();
  const reload = sheet.getByRole('button', { name: 'Reload item' });
  await reload.waitFor({ timeout: 5000 });
  assert.match(await sheet.getByRole('status').textContent(), /item changed/i);
  assert.equal(await done.count(), 0);
  assert.equal(await sheet.locator('time').textContent(), 'Nov 24');
  assert.deepEqual(writes.map(({ base_version }) => base_version), [0]);
  assert.equal(step.status, 'open');
  assert.equal(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await sheet.screenshot({ path: join(evidence, `checklist-conflict-${width}.png`) });

  await reload.click();
  await done.waitFor();
  assert.equal(await sheet.locator('time').textContent(), 'Nov 26');
  assert.equal(writes.length, 1);
  await done.click();
  await sheet.getByText('Item marked done', { exact: true }).waitFor();
  assert.equal(step.status, 'done');
  assert.deepEqual(writes.map(({ base_version }) => base_version), [0, 17]);
  assert.notEqual(writes[0].idempotency_key, writes[1].idempotency_key);
});

for (const width of [1440, 390]) {
  test(`a National deal shows its facts once and its next confirmed date at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Los_Angeles' });
    t.after(() => page.close());
    const fixtureOrigin = await dealFixtureOrigin(t);
    const [deal, account, lease, confirmed, proposed] = Array.from({ length: 5 }, () => crypto.randomUUID());
    const nextDate = { id: confirmed, kind: 'lease_expiration', due_on: '2026-11-19' };
    const row = {
      id: deal, deal_id: deal, name: 'Example Expansion', client_name: 'Example Practice', phase: 'closed',
      owner: 'dell', workspace_kind: 'national_account', account_client_id: account,
      type: 'purchase', kind: 'purchase', reason: 'renewal', renews_lease_id: lease,
      market: 'Example City', market_agent: 'Example Agent', outcome: 'won', closed_value: '125000',
      next_date: '2026-11-18',
    };
    const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [], closed_deals: [], lost_deals: [] };
    let readsOn = false;
    const env = {
      ENGINE_ROUTING: { get: async key => readsOn && key === 'deals-from-engine' ? 'on' : null },
      ENGINE: { fetch: async request => Response.json(new URL(request.url).pathname.endsWith(deal) ? {
        ...row, email_follow_ups: [], next_critical_date: nextDate,
        critical_dates: [
          { id: proposed, kind: 'option_notice', due_on: '2026-11-17', status: 'proposed' },
          { ...nextDate, status: 'open' },
        ],
      } : board) },
      CARR: { fetch: async request => {
        const { id, params } = await request.json();
        const data = params.name === 'deal-room-board' ? board : row;
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
      } },
    };
    const seeded = await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: 'national-deal-facts', viewer: 'joe' } });
    assert.equal(seeded.status(), 200);
    await page.route('**/mcp', async route => {
      const request = route.request();
      if (!['deal-room-board', 'get-deal-room'].includes(request.postDataJSON()?.params?.name)) return route.continue();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });

    const detail = page.locator('#recordPanel');
    const header = detail.locator('#workspaceFacts');
    const snapshot = detail.getByRole('region', { name: 'Deal snapshot' });
    const dates = detail.getByRole('region', { name: 'Critical dates' });
    const open = async () => {
      await page.goto(`${fixtureOrigin}/deals?deal=${deal}&mode=live`);
      await snapshot.waitFor();
    };
    await open();
    assert.equal(await header.getByText('Example City', { exact: true }).count(), 0);
    assert.equal(await snapshot.getByText('Example City', { exact: true }).count(), 0);

    readsOn = true;
    await open();
    const leaseDate = dates.locator('.critical-date').filter({ hasText: 'Lease expiration' }).locator(':scope > p > time[datetime="2026-11-19"]');
    await leaseDate.waitFor({ timeout: 5000 });
    // The next critical date left the header for the dates row under the tabs (design CHANGE 14).
    assert.equal(await header.locator('time').count(), 0);
    assert.equal(await header.getByText('Next critical date', { exact: true }).count(), 0);
    assert.equal(await header.getByText('Example Practice', { exact: true }).count(), 1);
    assert.equal(await snapshot.getByText('No next step set.', { exact: true }).count(), 1);
    for (const [label, value] of [['Market', 'Example City'], ['Deal kind', 'Purchase'], ['Deal reason', 'Renewal']]) {
      const fact = header.getByText(label, { exact: true });
      assert.equal(await fact.count(), 1);
      assert.equal(await fact.locator('..').getByText(value, { exact: true }).count(), 1);
      assert.equal(await snapshot.getByText(value, { exact: true }).count(), 0);
    }
    for (const [label, value] of [['Market agent', 'Example Agent'], ['Closed value', '$125,000.00']]) {
      const fact = snapshot.getByText(label, { exact: true });
      assert.equal(await fact.count(), 1);
      assert.equal(await fact.locator('..').getByText(value, { exact: true }).count(), 1);
      assert.equal(await header.getByText(value, { exact: true }).count(), 0);
    }
    assert.equal(await snapshot.getByText('Lease not recorded').count(), 0);
    assert.ok(!(await detail.textContent()).includes(lease));
    assert.equal(await detail.locator(`a[href*="${lease}"]`).count(), 0);
    assert.ok(await header.evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: join(evidence, `deal-facts-${width}.png`) });

  });
}

test('the switched Deals editor submits once on Enter and adds a line on Shift+Enter at 390px', async t => {
  const nextActions = [{ id: crypto.randomUUID(), owner: 'joe', status: 'open', description: 'Check the floor plan' }];
  const { page, deal } = await clientWebsitePage(t, { width: 390, nextActions });
  await page.goto(`${origin}/deals?deal=${deal}&focus=next-step&mode=live`);
  const form = page.locator('#detailUpdateForm');
  await form.evaluate(node => {
    node.dataset.submissionCount = '0';
    node.addEventListener('submit', event => {
      node.dataset.submissionCount = String(Number(node.dataset.submissionCount) + 1);
      event.preventDefault();
      event.stopPropagation();
    });
  });
  const field = page.getByLabel('Your next step', { exact: true });
  await field.fill('Send the floor plan');
  await field.press('Shift+Enter');
  assert.equal(await field.inputValue(), 'Send the floor plan\n');
  assert.equal(await form.getAttribute('data-submission-count'), '0');
  await field.press('Enter');
  assert.equal(await form.getAttribute('data-submission-count'), '1');
  assert.equal(await field.inputValue(), 'Send the floor plan\n');
});

for (const width of [1440, 390]) {
  test(`the switched Deals editor wraps the saved instruction at ${width}px`, async t => {
    const instruction = 'Confirm the revised floor plan with the site manager. '.repeat(8).trim();
    const nextActions = [{ id: crypto.randomUUID(), owner: 'joe', status: 'open', description: instruction }];
    const { page, deal, enginePaths } = await clientWebsitePage(t, { width, nextActions });
    await page.goto(`${origin}/deals?deal=${deal}&focus=next-step&mode=live`);
    const field = page.getByLabel('Your next step', { exact: true });
    await page.waitForFunction(expected => document.querySelector('#dealUpdateStep')?.value === expected, instruction);
    assert.ok(await field.evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight));
    assert.ok(enginePaths.includes(`/api/engine/deals/${deal}`));
  });

  test(`a Home link focuses the exact deal step at ${width}px`, async t => {
    const nextActions = ['dell', 'joe'].map(owner => ({
      id: crypto.randomUUID(), owner, status: 'open', due_on: '2026-11-10',
      description: 'Check the lease',
      set_by: 'Example Partner', set_at: '2026-11-03T16:00:00Z', set_from: 'meeting',
    }));
    nextActions.push({ id: crypto.randomUUID(), owner: 'joe', status: 'open', title: 'Confirm the site visit' });
    const fixtureOrigin = await dealFixtureOrigin(t);
    const { page, deal } = await clientWebsitePage(t, { width, nextActions, fixtureOrigin });
    for (const step of nextActions) {
      await page.goto(`${fixtureOrigin}/deals?deal=${deal}&focus=next-step&step=${step.id}&mode=live`);
      const destination = step.title
        ? page.getByRole('button', { name: step.title, exact: true })
        : page.getByRole('group', { name: new RegExp(`^${step.description} ${step.owner}`, 'i') });
      const focused = destination.and(page.locator(':focus'));
      await focused.waitFor();
      assert.equal(await focused.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }), true);
      if (!step.title) {
        assert.match(await focused.textContent(), /Set by Example Partner · Nov 3.*10:00 AM · From a meeting/);
        await page.screenshot({ path: join(evidence, `home-step-${step.owner}-${width}.png`) });
      }
    }
    await page.goto(`${fixtureOrigin}/deals?deal=${deal}&focus=next-step&mode=live`);
    await page.locator('#detailNextStepEditor[open]').getByRole('textbox', { name: /next step/i }).waitFor();
  });

  test(`Client portal opens the other partner's website at ${width}px`, async t => {
    const fixtureOrigin = await dealFixtureOrigin(t);
    const { page, deal, website, grant, enginePaths } = await clientWebsitePage(t, { width, fixtureOrigin });
    await page.context().route(`${website}/?grant=${grant}`, route =>
      route.fulfill({ body: '<h1>Example client website</h1>', contentType: 'text/html' }));
    await page.goto(`${fixtureOrigin}/deals?deal=${deal}&tab=client-portal&mode=live`);
    const view = page.getByRole('tabpanel', { name: 'Client portal' });
    const open = view.getByRole('button', { name: /^Open as client/ });
    await open.waitFor();
    assert.deepEqual((await view.getByRole('button').allTextContents()).slice(0, 2), ['Copy client link', 'Open as client (opens in a new tab)']);
    await page.route('http://127.0.0.1:4682/api/state', route => route.fulfill({ json: { state: 'idle' } }));
    await page.getByRole('button', { name: /account and settings/i }).click();
    await page.getByRole('button', { name: 'Check call recorder status' }).click();
    await page.getByRole('button', { name: 'Call mode', exact: true }).click();
    const recorder = page.getByRole('dialog', { name: /Call mode/i });
    await recorder.getByRole('button', { name: 'Start another call' }).waitFor();
    await recorder.getByRole('button', { name: 'Close Call Mode' }).click();
    await page.screenshot({ path: join(evidence, `client-portal-${width}.png`) });
    const popupPromise = page.waitForEvent('popup');
    await open.click();
    const popup = await popupPromise;
    await popup.getByRole('heading', { name: 'Example client website' }).waitFor();
    assert.deepEqual(enginePaths.filter(path => path.endsWith('/open')), [`/api/engine/deals/${deal}/client-website/open`]);
  });

  test(`Old tab links open the tab that took over at ${width}px`, async t => {
    const fixtureOrigin = await dealFixtureOrigin(t);
    const { page, deal } = await clientWebsitePage(t, { width, fixtureOrigin });
    for (const [old, name] of [['client-view', 'Client portal'], ['timeline', 'Activity'], ['correspondence', 'Activity'], ['market-terms', 'Overview']]) {
      await page.goto(`${fixtureOrigin}/deals?deal=${deal}&tab=${old}&mode=live`);
      await page.getByRole('tab', { name, exact: true }).and(page.locator('[aria-selected="true"]')).waitFor();
    }
  });
}

for (const [width, savesOn] of [[1440, true], [390, true], [390, false]]) {
  test(`closed deal website setup with Deals saves ${savesOn ? 'on' : 'off'} at ${width}px`, async t => {
    const fixtureOrigin = await dealFixtureOrigin(t);
    const { page, deal } = await clientWebsitePage(t, { closed: true, savesOn, linked: false, width, fixtureOrigin });
    await page.goto(`${fixtureOrigin}/deals?deal=${deal}&mode=live`);
    const overview = page.getByRole('tabpanel', { name: 'Overview' });
    await overview.locator('[data-detail-read="path"]').waitFor();
    const setup = overview.getByText('Set up client website', { exact: true });
    if (savesOn) {
      await setup.click();
      await overview.getByLabel('Website name').waitFor();
      await overview.getByLabel('Password').waitFor();
      await overview.locator('.client-portal-register').screenshot({ path: join(evidence, `closed-website-setup-${width}.png`) });
    } else {
      assert.equal(await setup.count(), 0);
    }
  });
}

for (const width of [1440, 390]) {
  test(`the National review entry opens Monday review at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    t.after(() => page.close());
    const fixtureOrigin = await dealFixtureOrigin(t);
    const account = { account_client_id: crypto.randomUUID(), account_name: 'Example National Account', account_owner: 'dell' };
    const board = { schema_version: 'local-deals-board.v2', actor: 'joe', accounts: [account], deals: [] };
    let savesOn = false;
    await page.request.post(`${fixtureOrigin}/api/test/seed`, { data: { namespace: `national-review-entry-${width}`, viewer: 'joe', reset: true } });
    const env = {
      ASSETS: { fetch: async () => new Response(await readFile(join(outDir, 'site', 'monday-review.html')), {
        headers: { 'content-type': 'text/html' },
      }) },
      ENGINE_ROUTING: { get: async key => key === 'deals-from-engine' || (key === 'deals-saves-from-engine' && savesOn) ? 'on' : null },
      ENGINE: { fetch: async request => Response.json(
        new URL(request.url).pathname === '/api/engine/weekly-reviews' ? { items: [] } : board,
      ) },
      CARR: { fetch: async () => new Response('Signed in') },
    };
    const throughWorker = async route => {
      const request = route.request();
      const response = await handleDoctorcreRequest(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }), env);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    };
    await page.route('**/mcp', route => route.request().postDataJSON()?.params?.name === 'deal-room-board'
      ? throughWorker(route) : route.continue());
    await page.route(url => url.pathname === '/api/engine/weekly-reviews' ||
      (url.pathname === '/deals' && url.searchParams.get('view') === 'review'), throughWorker);

    for (const switchedOn of [false, true]) {
      savesOn = switchedOn;
      await page.goto(`${fixtureOrigin}/deals?view=national&mode=live`);
      await page.getByRole('button', { name: /Example National Account/ }).click();
      const active = page.locator(switchedOn ? '#mondayReviewLink:not([hidden])' : '#agendaButton:not([hidden])');
      await active.waitFor({ state: 'attached' });
      if (!await active.isVisible()) await page.getByRole('button', { name: 'Workspace sidebar' }).click();
      await active.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Review deals' }).count(), switchedOn ? 0 : 1);
      assert.equal(await page.getByRole('link', { name: 'Monday review' }).count(), switchedOn ? 1 : 0);
    }
    await page.screenshot({ path: join(evidence, `national-review-entry-${width}.png`) });
    await page.getByRole('link', { name: 'Monday review' }).click();
    await page.getByRole('main', { name: 'Monday review' }).waitFor();
  });
}

for (const width of [1440, 390]) test(`Closed deals offers only available automatic Undo at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `closed-undo-${width}`, viewer: 'joe', reset: true } });
  const row = (name, source, undoable) => ({ id: crypto.randomUUID(), name, owner: 'joe', phase: 'closed', seen: 7,
    phase_change: { source, undoable, automatic: true, event_id: crypto.randomUUID(), phase: 'closed', prior_phase: 'legal', evidence_date: '2026-11-17' } });
  const blocked = row('Example Recorded Invoice', 'copied', false);
  const copied = row('Example Copied Close', 'copied', true);
  const invoice = row('Example Invoice Close', 'invoice', true);
  const rows = [blocked, copied, invoice], writes = [];
  const board = () => ({ schema_version: 'local-deals-board.v2', actor: 'joe', deals: [], closed_deals: rows, lost_deals: [] });
  const env = { ENGINE_ROUTING: { get: async key => ['deals-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/deals') return Response.json(board());
      writes.push({ path, body: await request.json() });
      if (path.includes(invoice.phase_change.event_id) && writes.length === 1)
        return Response.json({ error: 'version_conflict', hint: 'This invoice close cannot be undone.' }, { status: 409 });
      const index = rows.findIndex(item => path.includes(item.id) || path.includes(item.phase_change.event_id));
      if (index >= 0) rows.splice(index, 1);
      return Response.json({ status: 'undone', invoice_id: invoice.phase_change.event_id, deal_id: copied.id, phase: 'legal', phase_changed_at: '2026-11-19T18:00:00Z' });
    } } };
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (!['deal-room-board', 'undo-automatic-phase-move', 'undo-invoice-close'].includes(request.postDataJSON()?.params?.name)) return route.continue();
    const response = await handleDoctorcreRequest(new Request(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() }), env);
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await page.goto(`${origin}/deals?mode=live`);
  await page.getByRole('button', { name: 'Closed deals', exact: true }).click();
  const card = deal => page.locator(`article[data-id="${deal.id}"]`);
  await card(blocked).getByText('Closed automatically', { exact: true }).waitFor();
  assert.equal(await card(blocked).getByRole('button', { name: /Undo/ }).count(), 0);
  await card(copied).getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await card(invoice).getByRole('button', { name: 'Undo invoice close' }).waitFor();
  await page.locator('#closedDealsView').screenshot({ path: join(evidence, `closed-undo-${width}.png`) });
  await card(invoice).getByRole('button', { name: 'Undo invoice close' }).click();
  await card(invoice).getByText('This invoice close cannot be undone.', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(writes[0].path, `/api/engine/invoice-emails/${invoice.phase_change.event_id}/undo`);
  await card(invoice).getByRole('button', { name: 'Undo invoice close' }).click();
  await card(invoice).waitFor({ state: 'detached' });
  await card(copied).getByRole('button', { name: 'Undo', exact: true }).click();
  await card(copied).waitFor({ state: 'detached' });
  assert.equal(writes[2].path, `/api/engine/deals/${copied.id}/phase/undo`);
});
