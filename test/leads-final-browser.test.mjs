import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, settles } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { lead, workspace, detail, emptyQuietFollowUps, id } from './leads-workspace-fixture.mjs';

async function capture(page, name, measurements) {
  if (!process.env.LEADS_FINAL_DIR) return;
  await mkdir(process.env.LEADS_FINAL_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.LEADS_FINAL_DIR}/${name}.png` });
  await writeFile(`${process.env.LEADS_FINAL_DIR}/${name}.json`, JSON.stringify(measurements, null, 2));
}

test('Claim is offered on unclaimed leads across active stages', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, {
    stage: n < 43 ? 'new' : 'qualified', owner: n === 1 ? 'example-partner' : null, registry_ref: n === 1 || n === 2 ? null : `L-${n + 1}`,
  }));
  board.leads.push(lead(46, { stage: 'archived' }));
  const getQuiet = () => ({ ...emptyQuietFollowUps(), proposals: [{
    subject_type: 'lead', subject_id: id(2), ref: null, name: 'Dr. Example 2',
    basis: 'last_contact', anchor_on: '2026-08-01', due_on: '2026-09-15', days_overdue: 16, owner: 'example-partner',
  }] });
  const writes = [];
  await routeLeads(page, { getBoard: () => board, getQuiet, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  const claim = page.locator('#leadBoard').getByRole('button', { name: 'Claim', exact: true }).first();
  assert.ok(await claim.count(), 'the board exposes a labelled Claim action');
  const bounds = await claim.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900, `Claim is on the first screen: ${JSON.stringify(bounds)}`);
  assert.equal(await page.locator('.lead-card').nth(1).getByRole('button', { name: 'Claim', exact: true }).count(), 0, 'owned leads cannot be claimed');
  assert.equal(await page.locator('[data-stage="qualified"] [data-claim]').count(), 2);
  const owned = page.locator('.lead-card').nth(1);
  await owned.getByText('Follow-up late').waitFor();
  assert.deepEqual(await owned.locator(':scope > *').allTextContents(), [
    'Dr. Example 2', 'Example-partner', 'Follow-up late',
  ]);
  assert.equal(await page.locator('.lead-card .work-card-status').count(), 1);
  assert.deepEqual(await page.locator('.lead-card').first().locator(':scope > *').allTextContents(), [
    'Dr. Example 1', 'Unclaimed', 'Claim',
  ]);
  await page.locator('#ownerFilter').selectOption('unclaimed');
  assert.equal(await page.locator('#leadCount').innerText(), '44 leads');
  assert.equal(await page.locator('.lead-card').nth(1).locator('.work-card-meta').innerText(), 'Unclaimed');
  await page.locator('#stageFilter').selectOption('qualified');
  assert.equal(await page.locator('#leadCount').innerText(), '2 leads');
  await page.locator('#stageFilter').selectOption('archived');
  assert.equal(await page.locator('#leadCount').innerText(), '1 lead');
  assert.equal(await page.locator('#leadBoard [data-claim]').count(), 0);
  await page.locator('#stageFilter').selectOption('');
  await claim.focus();
  await page.keyboard.press('Space');
  await settles(async () => assert.equal(await page.locator('#moveAnnouncement').innerText(), 'Lead claimed'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'claim-lead');
  assert.equal(writes[0].arguments.lead, 'L-1');
  assert.equal(Object.hasOwn(writes[0].arguments, 'lead_id'), false);
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false);
});

test('A mixed board keeps an unversioned lead readable and only the versioned lead can save', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const editable = lead(1);
  const readOnly = lead(2, {
    base_version: undefined, new_from_email: true,
    possible_clients: [{ client_id: id(901), name: 'Example Client Match' }],
  });
  const board = { ...workspace(), leads: [editable, readOnly, lead(3, { stage: null })] };
  const writes = [];
  await routeLeads(page, {
    getBoard: () => board,
    onWrite: request => {
      writes.push(request);
      if (request.name === 'claim-lead' && request.arguments.lead === editable.registry_ref) editable.owner = 'example-partner';
    },
  });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  assert.deepEqual(await page.locator('#leadBoard .lead-open').allTextContents(), ['Dr. Example 1', 'Dr. Example 2']);
  assert.equal(await page.locator('#leadBoardError').isVisible(), false);
  const card = page.locator(`[data-lead-id="${readOnly.id}"]`);
  const claim = card.getByRole('button', { name: 'Claim', exact: true });
  assert.equal(await claim.isDisabled(), true);
  await claim.evaluate(button => button.click());
  const open = card.getByRole('button', { name: 'Dr. Example 2', exact: true });
  await open.press('Alt+ArrowRight');
  assert.equal(await page.locator('#stageDialog').isVisible(), false);
  await open.click();
  const drawer = page.locator('#leadDetail');
  await drawer.getByText("Can't edit right now. Refresh to try again.", { exact: true }).waitFor();
  assert.equal(await drawer.getByRole('button', { name: 'Claim', exact: true }).isDisabled(), true);
  assert.equal(await drawer.getByRole('combobox', { name: 'Stage' }).isDisabled(), true);
  assert.equal(await drawer.getByRole('button', { name: 'Link to client Example Client Match' }).isDisabled(), true);
  await drawer.getByRole('button', { name: 'Close lead details' }).click();
  await page.locator(`[data-lead-id="${editable.id}"]`).getByRole('button', { name: 'Claim', exact: true }).click();
  await settles(async () => assert.equal(await page.locator('#moveAnnouncement').innerText(), 'Lead claimed'));
  assert.deepEqual(writes.map(({ name, arguments: { lead, base_version } }) => [name, lead, base_version]), [
    ['claim-lead', editable.registry_ref, editable.base_version],
  ]);
});

test('An invalid first Leads response hides results and Retry can load the board', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const board = { ...workspace(), leads: [lead(1, { stage: null })] };
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  const banner = page.locator('#leadBoardError');
  const retry = banner.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor();
  assert.equal(await banner.innerText(), "Leads couldn't be loaded. Retry");
  assert.equal(await page.locator('#leadTerritory').isVisible(), false);
  assert.equal(await page.locator('#stageFilter').isVisible(), false);
  assert.equal(await page.locator('#marketCounts').innerText(), '');
  assert.equal(await page.locator('#leadBoard [data-stage]').count(), 0);
  assert.equal(await page.locator('#leadCount').innerText(), '');
  board.leads = [lead(1)];
  await retry.click();
  await page.locator('.lead-card').waitFor();
  assert.equal(await banner.isVisible(), false);
  assert.equal(await page.locator('#stageFilter').isVisible(), true);
});

test('An invalid Leads refresh identifies a load failure and keeps the last update visible', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const board = { ...workspace(), leads: [lead(1)] };
  let invalid = false;
  await routeLeads(page, { getBoard: () => invalid ? [] : board });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').waitFor();
  invalid = true;
  await page.getByRole('button', { name: 'Refresh leads', exact: true }).click();
  const banner = page.locator('#leadBoardError');
  await banner.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await banner.innerText(), "Leads couldn't be loaded. Showing the last update. Retry");
  assert.deepEqual(await page.locator('#leadBoard .lead-open').allTextContents(), ['Dr. Example 1']);
});

for (const width of [390, 768, 1280, 1440]) for (const theme of ['dark', 'light']) {
  test(`The selected stage fills the board at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    const board = workspace();
    board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, { stage: n < 43 ? 'new' : 'qualified' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await routeLeads(page, { getBoard: () => board });
    await page.goto('http://localhost/leads');
    await page.locator('.lead-card').first().waitFor();
    const claim = await page.locator('#leadBoard [data-claim]').first().boundingBox();
    await capture(page, `${width}-${theme}-board`, {
      claim,
      card: await page.locator('.lead-card').first().boundingBox(),
    });
    assert.ok(claim.y >= 0 && claim.y + claim.height < 900, `Claim is visible without scrolling ${JSON.stringify(claim)}`);
    assert.equal(await page.locator('#leadBoard [data-claim]').first().evaluate(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, 'Claim is not covered by the fixed phone chrome');
    await page.locator('#stageFilter').selectOption('qualified');
    const layout = await page.evaluate(() => {
      const board = document.querySelector('#leadBoard').getBoundingClientRect();
      const stages = [...document.querySelectorAll('.stage-column')].map(node => node.getBoundingClientRect()).filter(box => box.width);
      return { boardWidth: board.width, stageWidths: stages.map(box => box.width), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await capture(page, `${width}-${theme}-qualified`, layout);
    assert.deepEqual(layout.stageWidths.map(value => Math.round(value)), [Math.round(layout.boardWidth)], JSON.stringify(layout));
    assert.equal(await page.locator('.stage-column:visible .lead-card').count(), 2);
    assert.equal(layout.overflow, false);
    assert.deepEqual(errors, []);
  });

  test(`An empty board offers one explanation and a working refresh at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    const board = workspace();
    board.leads = [];
    const writes = [];
    let reads = 0;
    await routeLeads(page, { getBoard: () => board, onRead: () => reads++, onWrite: value => writes.push(value) });
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    const content = await page.locator('#leadBoard').innerText();
    await capture(page, `${width}-${theme}-empty`, { content });
    assert.equal(await page.locator('#leadBoard .stage-column').count(), 0, 'empty boards do not render six empty stages');
    assert.equal(await page.locator('#leadBoard p').count(), 1);
    assert.equal(await page.locator('#leadBoard p').innerText(), 'No active leads are on the board.');
    assert.equal(await page.locator('#leadBoard button').count(), 1);
    assert.equal(await page.locator('.territory').isVisible(), false, 'a genuinely empty board has no empty supporting panels');
    const before = reads;
    board.leads = [lead(1)];
    await page.locator('#leadBoard').getByRole('button', { name: 'Refresh leads', exact: true }).click();
    await page.locator('.lead-card').waitFor();
    assert.ok(reads > before, 'the empty-state action fetches a fresh board');
    await page.locator('#leadSearch').fill('no-synthetic-match');
    assert.equal(await page.locator('.territory').isVisible(), true, 'territory remains available for filtered emptiness');
    await capture(page, `${width}-${theme}-filtered-empty`, { content: await page.locator('#leadBoard').innerText() });
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    assert.equal(await page.locator('#leadSearch').evaluate(node => node === document.activeElement), true, 'reset returns focus to search');
    assert.equal(await page.locator('.lead-card').count(), 1);
    assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}

for (const failure of ['network', 401, 403]) test(`Slice A initial Leads identity failure ${failure} gives the correct recovery`, async t => {
 const browser = await chromium.launch(); t.after(() => browser.close());
 const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
 const writes = []; let failing = true;
 await routeLeads(page, { onWrite: value => writes.push(value) });
 await page.route('**/api/system-work/session', route => {
  if (!failing) return route.fallback();
  return failure === 'network' ? route.abort('internetdisconnected') : route.fulfill({ status: failure, json: {} });
 });
 await page.goto('http://localhost/leads');
 const error = page.locator('#leadBoardError');
 await error.waitFor();
 if (failure === 'network') {
  assert.match(await error.textContent(), /Connection/);
  assert.equal(await error.getByRole('link', { name: 'Sign in', exact: true }).count(), 0);
  assert.equal(await page.locator('#leadBoard .lead-card').count(), 0);
  failing = false;
  await error.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('#leadBoard .lead-card').first().waitFor();
  assert.equal(await error.isVisible(), false);
 } else {
  assert.equal(await error.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
  assert.equal(await error.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
 }
 assert.deepEqual(writes, []);
});


test('Leads detail reaches the 101st captured correspondence and stage change', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const writes = [];
  const rows = Array.from({ length: 101 }, (_, n) => ({ id: id(1000 + n), kind: 'email_in', occurred_at: '2026-10-01T10:00:00Z', summary: `Synthetic captured entry ${n + 1}` }));
  const stages = Array.from({ length: 101 }, (_, n) => ({ event_id: id(2000 + n), mutation_order: String(101 - n), occurred_at: '2026-10-01T10:00:00Z', prior_stage: 'new', stage: 'engaged', reason: `Synthetic stage change ${n + 1}` }));
  await routeLeads(page, { onWrite: value => writes.push(value), getDetail: (row, args) => ({
    ...detail(row), correspondence: rows.slice(args.correspondence_cursor ? 100 : 0, args.correspondence_cursor ? 200 : 100),
    stage_history: stages.slice(args.stage_history_cursor ? 100 : 0, args.stage_history_cursor ? 200 : 100),
    correspondence_coverage: 'captured_entries_only',
    correspondence_page: { total: 101, has_more: !args.correspondence_cursor, next_cursor: args.correspondence_cursor ? null : { occurred_at: rows[99].occurred_at, id: rows[99].id } },
    stage_history_page: { total: 101, has_more: !args.stage_history_cursor, next_cursor: args.stage_history_cursor ? null : '2' },
  }) });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard .lead-open').first().click();
  await page.getByRole('heading', { name: 'Captured correspondence', exact: true }).waitFor();
  assert.match(await page.locator('#detailBody').textContent(), /Showing 100 of 101 captured entries/);
  assert.match(await page.locator('#detailBody').textContent(), /Other communication may not have been captured/);
  await page.getByRole('button', { name: 'Load older correspondence', exact: true }).click();
  await settles(async () => assert.equal(await page.locator('.correspondence > li').count(), 101));
  await page.getByRole('button', { name: 'Load older stage changes', exact: true }).click();
  await settles(async () => assert.equal(await page.locator('.history > li').count(), 101));
  assert.match(await page.locator('#detailBody').textContent(), /Showing 101 of 101 captured entries/);
  assert.match(await page.locator('.correspondence > li').last().textContent(), /Synthetic captured entry 101/);
  assert.match(await page.locator('.history > li').last().textContent(), /Synthetic stage change 101/);
  await page.getByRole('heading', { name: 'Captured correspondence', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'f7-history-complete', { correspondence: 101, stage_history: 101 });
  assert.deepEqual(writes, []);
});

test('Quiet leads, Owner and Market narrow the same board and count', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.clock.setFixedTime(new Date('2026-10-01T16:00:00Z'));
  const board = { ...workspace(), leads: [lead(1, { registry_ref: null }), lead(2, { owner: 'dell', stage: 'engaged', city: 'Mobile', state: 'AL' }), lead(3)] };
  const quiet = (n, days) => ({
    subject_type: 'lead', subject_id: id(n), ref: `L-${n}`, name: `Dr. Example ${n}`,
    basis: 'created_at', anchor_on: '2026-08-01', due_on: '2026-09-15', days_overdue: days,
  });
  await routeLeads(page, {
    getBoard: () => board,
    getDetail: row => ({ ...detail(row), notes: 'Interested in a second location.' }),
    getQuiet: () => ({ ...emptyQuietFollowUps(), proposals: [
      { ...quiet(1, 16), ref: null }, { ...quiet(2, 0), subject_id: id(202), basis: 'last_contact' }, { ...quiet(3, 16), subject_type: 'vendor' },
    ] }),
  });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  assert.equal(await page.getByLabel('Contact evidence').isVisible(), false);
  assert.equal(await page.locator('#leadCount').innerText(), '3 leads');
  const filter = page.getByRole('button', { name: 'Quiet leads', exact: true });
  assert.equal(await filter.count(), 1);
  await filter.click();
  assert.equal(await page.locator('#leadCount').innerText(), '2 leads');
  assert.equal(await page.locator('.lead-card .work-card-status').count(), 1);
  await page.getByRole('button', { name: 'Dr. Example 2', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.getByText('Last contact Aug 1. Follow-up due Sep 15.', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Interested in a second location.', { exact: true }).count(), 1);
  await page.locator('#closeDetail').click();
  await page.getByRole('button', { name: 'Dr. Example 1', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.getByText('No contact recorded. Added Aug 1. Follow-up due Sep 15.', { exact: true }).count(), 1);
  await page.locator('#closeDetail').click();
  await page.locator('#ownerFilter').selectOption('unclaimed');
  assert.equal(await page.locator('#leadCount').innerText(), '1 lead');
  await page.locator('#marketFilter').selectOption('Mobile, AL');
  assert.equal(await page.locator('#leadCount').innerText(), '0 leads');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  assert.equal(await filter.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#leadCount').innerText(), '3 leads');
  assert.equal(await page.locator('#mapLeadMembers, #quietFollowUps').count(), 0);
});

const evidence = `test-artifacts/lead-drawer-words-${randomUUID()}`;
const added = '2020-08-01T12:00:00Z';
const timing = { contract: 'lead-opportunity-timing.v1', status: 'unknown', events: [], record_added_at: added };
const notes = '[Web sweep 7/25 · finder conf LOW · verify: UNVERIFIED (present anyway, flag)] Planning a dental relocation.\n\nNeeds two treatment rooms.';
const research = { state: 'needs_research', next_step: 'Check the practice website, professional registry and public filings. Save what you find.', evidence: [], coverage: 'recorded_findings_only', external_search_performed: false };
const due = (n, basis) => ({
  subject_type: 'lead', subject_id: id(n), ref: null, name: `Dr. Example ${n}`,
  basis, anchor_on: '2020-08-01', due_on: '2020-09-15', days_overdue: 25,
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`lead details and quiet results at ${width} in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.clock.setFixedTime(new Date('2026-10-01T16:00:00Z'));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);

    const name = 'Dr. Example 1';
    const unclaimed = lead(1, { possible_clients: [{ client_id: id(901), name }], created_at: added, opportunity_timing: timing });
    const claimed = lead(2, { owner: 'dell', owner_label: 'Example Partner', created_at: added });
    const archived = lead(3, { stage: 'archived', owner: 'dell' });
    const filler = Array.from({ length: 221 }, (_, i) => lead(i + 1000));
    const reads = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/mcp') reads.push(request.postDataJSON()?.params.name);
    });
    await routeLeads(page, {
      getBoard: () => ({ ...workspace(), leads: [unclaimed, claimed, archived, ...filler] }),
      getQuiet: () => ({ ...emptyQuietFollowUps(), proposals: [
        { ...due(1, 'created_at'), last_contact_on: null },
        { ...due(2, 'created_at'), last_contact_on: '2020-07-31' },
      ] }),
      getDetail: row => ({
        ...detail(row), research, phone: '+18505550100 x123', notes,
        plans: 'Planning a dental relocation.\n\nNeeds two treatment rooms.',
        est_lease_event: '2028-12-01', handling_advice: null,
        strategy: { basis: 'stage_based_guidance', hold: row === archived ? { reason: 'contact_ineligible' } : null },
        correspondence: row === unclaimed ? [] : [{ id: id(600), kind: 'call', occurred_at: '2020-07-31T12:00:00Z', summary: 'Discussed a relocation.' }],
        correspondence_page: { total: row === unclaimed ? 0 : 1, has_more: false, next_cursor: null },
        stage_history: row === archived ? [
          { event_id: id(500), prior_stage: 'engaged', stage: 'archived', occurred_at: added, reason: 'became a deal in the old system' },
        ] : [],
        stage_history_page: { total: row === archived ? 1 : 0, has_more: false, next_cursor: null },
      }),
    });
    await page.goto('http://localhost/leads');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await page.getByRole('button', { name: 'Show all 223 New leads', exact: true }).click();
    assert.equal(await page.locator('.lead-card').count(), 223);
    const filter = page.getByRole('button', { name: 'Quiet leads', exact: true });
    const before = reads.length;
    const elapsed = await filter.evaluate(button => {
      const started = performance.now();
      button.click();
      return performance.now() - started;
    });
    t.diagnostic(`Quiet filter with 223 expanded cards in local Chromium took ${elapsed.toFixed(1)} ms in the click handler`);
    assert.equal(reads.length, before);
    assert.doesNotMatch(await page.locator('#leadCount').innerText(), /Loading leads/);
    assert.equal(await page.locator('.lead-card').count(), 2);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/quiet-${width}-${theme}.png` });
    const quietStatus = await page.locator('#quietStatus').innerText();

    const drawer = page.locator('#leadDetail');
    await page.getByRole('button', { name, exact: true }).click();
    await drawer.getByRole('heading', { name: 'Sourced research' }).waitFor();
    const unclaimedText = await drawer.innerText();
    const link = drawer.locator('[data-link]');
    const details = drawer.getByText('More about these plans', { exact: true });
    await details.click();
    assert.ok(await details.evaluate(el => el.getBoundingClientRect().height >= 44));
    const detailsText = await drawer.innerText();
    const phone = drawer.getByRole('link', { name: /555/ });
    assert.deepEqual({
      quietStatus,
      claim: await drawer.getByRole('button', { name: 'Claim', exact: true }).count(),
      owner: /Owner\s+Unclaimed/.test(unclaimedText),
      link: await link.innerText(),
      phone: await phone.innerText(),
      dialing: await phone.getAttribute('href'),
      lease: /Estimated lease date\s+Dec 1, 2028/.test(unclaimedText),
      contradictsLease: unclaimedText.includes('Opportunity timing unknown'),
      boilerplate: unclaimedText.includes('Handling advice'),
      sourceGuidance: unclaimedText.includes(research.next_step),
      rawTag: detailsText.includes('Web sweep'),
      details: detailsText.includes('Needs two treatment rooms.'),
      anchor: /No contact recorded\. Added Aug 1, 2020\. Follow-up due Sep 15, 2020\./.test(unclaimedText),
    }, {
      quietStatus: 'Showing 2 quiet leads', claim: 1, owner: true, link: `Link to client ${name}`,
      phone: '(850) 555-0100 x123', dialing: 'tel:+18505550100 x123', lease: true,
      contradictsLease: false, boilerplate: false, sourceGuidance: true, rawTag: false, details: true, anchor: true,
    });
    assert.equal(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await drawer.screenshot({ path: `${evidence}/drawer-${width}-${theme}.png` });
    await page.locator('#closeDetail').click();
    await page.getByRole('button', { name: 'Dr. Example 2', exact: true }).click();
    await drawer.getByRole('heading', { name: 'Sourced research' }).waitFor();
    assert.match(await drawer.innerText(), /Owner\s+Example Partner/);
    assert.match(await drawer.innerText(), /Last contact Jul 31, 2020\. Follow-up due Sep 15, 2020\./);
    assert.match(await drawer.locator('.correspondence time').innerText(), /2020/);
    assert.equal(await drawer.getByRole('button', { name: 'Claim', exact: true }).count(), 0);
    await page.locator('#closeDetail').click();

    await filter.click();
    assert.equal(await page.locator('#quietStatus').isVisible(), false);
    await page.locator('#stageFilter').selectOption('archived');
    await page.getByRole('button', { name: 'Dr. Example 3', exact: true }).click();
    await drawer.getByRole('heading', { name: 'Sourced research' }).waitFor();
    assert.equal(await drawer.getByText('Became a deal.', { exact: true }).count(), 1);
    assert.doesNotMatch(await drawer.innerText(), /Contact restriction/);
    assert.equal(await drawer.getByRole('button', { name: 'Claim', exact: true }).count(), 0);
    assert.match(await drawer.locator('.history time').innerText(), /2020/);
    await drawer.screenshot({ path: `${evidence}/archived-${width}-${theme}.png` });
  });
}

test('Opening a lead shows its exact source and clears the badge for both partners', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const joe = await browser.newPage();
  const dell = await browser.newPage();
  const emailLead = lead(1, { new_from_email: true });
  const ordinaryLead = lead(2);
  const source = { id: id(800), kind: 'email', occurred_at: '2026-10-01T10:00:00Z', summary: 'Original request for dental space', detail: 'Please help me find a new clinic.' };
  const writes = [];
  const opening = Promise.withResolvers();
  t.after(() => opening.resolve());
  await routeLeads(joe, {
    actor: 'joe',
    getBoard: () => ({ ...workspace(), leads: [emailLead, ordinaryLead] }),
    getDetail: async row => {
      if (row.id === emailLead.id) await opening.promise;
      return { ...detail(row), source_email: row.id === emailLead.id ? source : null };
    },
    saveLead: (lead_id, args) => {
      writes.push({ lead_id, ...args });
      emailLead.new_from_email = false;
      return Response.json({ ok: true, lead_id });
    },
  });
  await routeLeads(dell, {
    actor: 'dell',
    getBoard: () => ({ ...workspace(), leads: [emailLead, ordinaryLead] }),
    saveLead: () => assert.fail('Reading a lead with a cleared badge must not write'),
  });
  await Promise.all([joe.goto('http://localhost/leads'), dell.goto('http://localhost/leads')]);
  const badge = page => page.locator('#leadBoard').getByText('New from email', { exact: true });
  await Promise.all([badge(joe).waitFor({ timeout: 4000 }), badge(dell).waitFor({ timeout: 4000 })]);

  await joe.getByRole('button', { name: 'Dr. Example 1', exact: true }).click();
  await joe.locator('#detailBody').getByText('Updating…', { exact: true }).waitFor();
  assert.deepEqual(writes, []);
  opening.resolve();
  const drawer = joe.locator('#leadDetail');
  await drawer.getByRole('heading', { name: 'Source email', exact: true }).waitFor();
  assert.equal(await drawer.getByText('Please help me find a new clinic.', { exact: true }).isVisible(), true);
  await badge(joe).waitFor({ state: 'hidden' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, 'acknowledge_email');
  assert.equal(writes[0].lead_id, emailLead.id);
  assert.equal(writes[0].expected_actor, 'joe');

  await dell.locator('#refreshBoard').click();
  await badge(dell).waitFor({ state: 'hidden' });
  await joe.locator('#closeDetail').click();
  for (const page of [joe, dell]) {
    await page.locator('#ownerFilter').selectOption('unclaimed');
    assert.equal(await page.locator('#leadCount').innerText(), '2 leads');
  }
  await joe.getByRole('button', { name: 'Dr. Example 2', exact: true }).click();
  await drawer.getByRole('heading', { name: 'Captured correspondence', exact: true }).waitFor();
  assert.equal(await drawer.getByRole('heading', { name: 'Source email', exact: true }).count(), 0);
  await joe.locator('#closeDetail').click();
  await dell.getByRole('button', { name: 'Dr. Example 1', exact: true }).click();
  await dell.locator('#detailStage').waitFor();
  assert.equal(await dell.getByRole('heading', { name: 'Source email', exact: true }).count(), 0);
  assert.equal(writes.length, 1);
});

test('Malformed source email leaves the drawer and Claim available', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const row = lead(1);
  const writes = [];
  await routeLeads(page, {
    actor: 'joe',
    getBoard: () => ({ ...workspace(), leads: [row] }),
    getDetail: row => ({
      ...detail(row),
      source_email: { id: id(800), kind: 'email', occurred_at: '2026-10-01T10:00:00Z', summary: 'Original request', detail: 17 },
    }),
    saveLead: (lead_id, { action, expected_actor }) => {
      writes.push({ lead_id, action, expected_actor });
      row.owner = expected_actor;
      return Response.json({ ok: true, lead_id });
    },
  });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Dr. Example 1', exact: true }).click();
  const drawer = page.locator('#leadDetail');
  const contact = drawer.getByRole('heading', { name: 'Contact', exact: true });
  const refusal = drawer.getByText('Lead details were refused.', { exact: true });
  await contact.or(refusal).waitFor();
  assert.equal(await refusal.isVisible(), false, 'A malformed source email refused the drawer');
  assert.equal(await drawer.getByRole('heading', { name: 'Source email', exact: true }).count(), 0);
  await drawer.getByRole('button', { name: 'Claim', exact: true }).click();
  await page.getByText('Lead claimed', { exact: true }).waitFor();
  assert.deepEqual(writes, [{ lead_id: row.id, action: 'claim', expected_actor: 'joe' }]);
});

test('A failed drawer read does not acknowledge and a 503 retries only on reopening', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const emailLead = lead(1, { new_from_email: true });
  let detailReads = 0;
  let acknowledgements = 0;
  await routeLeads(page, {
    getBoard: () => ({ ...workspace(), leads: [emailLead] }),
    getDetail: row => {
      detailReads += 1;
      return {
        ...detail(row),
        ...(detailReads === 1 ? { stage: null } : {}),
        notes: `Synthetic drawer read ${detailReads}`,
      };
    },
    saveLead: lead_id => {
      if (++acknowledgements === 1) return Response.json({ error: 'database_unavailable' }, { status: 503 });
      emailLead.new_from_email = false;
      return Response.json({ ok: true, lead_id });
    },
  });
  await page.goto('http://localhost/leads');
  const open = page.getByRole('button', { name: 'Dr. Example 1', exact: true });
  const badge = page.locator('#leadBoard').getByText('New from email', { exact: true });
  await open.click();
  await page.getByText('Lead details were refused.', { exact: true }).waitFor();
  assert.equal(acknowledgements, 0);
  await page.locator('#closeDetail').click();

  const response = page.waitForResponse(res => res.status() === 503 && res.request().postDataJSON()?.params?.name === 'acknowledge-lead-email', { timeout: 4000 });
  await open.click();
  await response;
  assert.equal(await badge.count(), 1);
  assert.equal(await page.locator('#leadDetail [role="alert"]:visible, #leadBoardError:visible').count(), 0);
  await page.locator('#refreshBoard').evaluate(button => button.click());
  await page.getByText('Synthetic drawer read 3', { exact: true }).waitFor();
  assert.equal(await badge.count(), 1);
  assert.equal(acknowledgements, 1);
  await page.locator('#closeDetail').click();
  await open.click();
  await badge.waitFor({ state: 'hidden' });
  assert.equal(acknowledgements, 2);
});

test('Claim removes the email badge before the refreshed board arrives', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const emailLead = lead(1, { new_from_email: true });
  const refresh = Promise.withResolvers();
  t.after(() => refresh.resolve());
  let claimed = false;
  await routeLeads(page, {
    actor: 'joe',
    getBoard: async () => {
      if (claimed) await refresh.promise;
      return { ...workspace(), leads: [claimed ? { ...emailLead, new_from_email: false, owner: 'joe' } : emailLead] };
    },
    saveLead: (lead_id, { action }) => {
      assert.equal(action, 'claim');
      claimed = true;
      return Response.json({ ok: true, lead_id });
    },
  });
  await page.goto('http://localhost/leads');
  const board = page.locator('#leadBoard');
  const badge = board.getByText('New from email', { exact: true });
  await badge.waitFor({ timeout: 4000 });
  await page.locator('#ownerFilter').selectOption('unclaimed');
  await board.getByRole('button', { name: 'Claim', exact: true }).click();
  await badge.waitFor({ state: 'hidden', timeout: 4000 });
  assert.equal(claimed, true);
  refresh.resolve();
  await settles(async () => assert.equal(await page.locator('#leadCount').innerText(), '0 leads'));
});
