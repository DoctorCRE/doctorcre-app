import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';

const root = new URL('../', import.meta.url);
const now = new Date('2026-10-01T15:00:00Z');

test('Home counts overdue agenda dates while board badges retain next-step attention', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  await page.clock.install({ time: now });
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.forEach((deal, i) => Object.assign(deal, { id: `synthetic-review-${i}`, phase: 'Research', owner: i % 2 ? 'dell' : 'joe', attention: false,
    operating_state: 'active', workspace_kind: 'team', account_client_id: null, outcome: null, invoiced_on: null,
    next_step: 'Confirm synthetic appointment', next_date: '2026-10-20', last_touch: null }));
  Object.assign(seed.deals[0], { next_date: '2026-09-30' });
  Object.assign(seed.deals[1], { next_date: '2026-09-29' });
  Object.assign(seed.deals[2], { next_date: '2026-10-01', attention: true });
  Object.assign(seed.deals[3], { next_date: null, next_step: '' });
  const optionNotice = { id: 'demo-overdue-option', kind: 'option_notice', due_on: '2026-09-01', status: 'open' };
  seed.critical_dates = { [seed.deals[3].id]: [optionNotice] };
  Object.assign(seed.deals[4], { next_date: null, attention: false, updated_at: '2026-10-01T14:00:00Z' });
  Object.assign(seed.deals[5], { next_date: '2026-09-01', operating_state: 'parked' });
  Object.assign(seed.deals[6], { next_date: '2026-09-01', phase: 'Closed' });
  seed.deals.unshift(...Array.from({ length: 5 }, (_, i) => ({ ...seed.deals[8], id: `synthetic-national-${i}`, name: `Demo National ${i}`, next_date: i === 0 ? '2026-09-01' : '2026-10-20' })));
  seed.deals.forEach(deal => { deal.items = deal.next_step ? [{id:`demo-item-${deal.id}`,title:'Review sample item',status:'open',due_on:deal.next_date,bullets:[]}] : []; });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ json: seed });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = ['/', '/review-workflows'].includes(url.pathname) ? 'review-workflows.html' : url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/review-workflows');
  await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts')?.textContent || ''));
  const home = await page.locator('#dealFlags .home-flag').count();
  const homeOverdue = await page.locator('#dealFlags .home-flag .work-card-status').allTextContents();
  const homeCounts = await page.locator('#dealCounts').textContent();
  await page.getByRole('button', { name: 'Just me', exact: true }).click();
  const mine = await page.locator('#dealFlags .home-flag').count();
  await page.goto('http://localhost/deals');
  await page.locator('.kanban-card').first().waitFor();
  const badges = await page.locator('.kanban-column').getByRole('button', { name: /^Needs attention:/ }).count();
  await page.getByRole('button', { name: 'Joe', exact: true }).click();
  const myBadges = await page.locator('.kanban-column').getByRole('button', { name: /^Needs attention:/ }).count();
  assert.deepEqual({ home, badges, mine, myBadges }, { home: 3, badges: 3, mine: 1, myBadges: 2 });
  assert.match(homeCounts, /Overdue deals: 3/);
  assert.equal(await page.getByRole('button', { name: 'Needs attention: Step 1 day late', exact: true }).count(), 1);
  assert.deepEqual(homeOverdue, ['30 days overdue', '2 days overdue', '1 day overdue']);
  seed.deals.forEach(deal => { deal.next_date = '2026-10-20'; deal.items.forEach(item => {item.due_on = '2026-10-20';}); });
  optionNotice.due_on = '2026-10-20';
  await page.goto('http://localhost/review-workflows');
  await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts')?.textContent || ''));
  assert.equal(await page.locator('#dealFlags .home-flag').count(), 0);
  assert.match(await page.locator('#dealFlags').textContent(), /No overdue next steps/);
  assert.deepEqual(errors, []);
});

test('Home opens the Deals list at deals with no next step and the board at a phase', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  await page.clock.install({ time: now });
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.forEach((deal, i) => Object.assign(deal, { id: `synthetic-plan-${i}`, name: `Demo Plan ${i}`, phase: i % 2 ? 'Legal' : 'Research',
    owner: 'joe', attention: false, operating_state: 'active', workspace_kind: 'team', account_client_id: null, outcome: null,
    invoiced_on: null, next_step_required: i === 5 || i === 6 }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ json: seed });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals?view=list&filter=no-next-step');
  await page.locator('.deal-row').first().waitFor();
  assert.deepEqual((await page.locator('.deal-row h4').allTextContents()).sort(), ['Demo Plan 5', 'Demo Plan 6']);
  await page.goto('http://localhost/deals?column=legal');
  await page.locator('.kanban-card').first().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.kanban-column')?.dataset.column), 'legal');
});

test('Deals with no next step hide the Prospects lane and its count', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } });
    if (url.pathname === '/mcp') {
      const { id, params } = route.request().postDataJSON();
      const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [], board_from_engine: true, engine_prospects: true, next_deal_saves: true };
      const value = params.name === 'deal-room-board' ? board : { items: [] };
      return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
    }
    if (url.pathname === '/api/engine/deals') return route.fulfill({ json: { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [], board_from_engine: true, engine_prospects: true, next_deal_saves: true } });
    if (url.pathname === '/api/engine/prospects') return route.fulfill({ json: { count: 0, prospects: [] } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals?mode=live');
  await page.locator('#prospectsLane').waitFor({ state: 'attached' });
  await page.waitForFunction(() => /0 prospects/.test(document.querySelector('#boardLive')?.textContent || ''));
  assert.equal(await page.locator('#prospectsLane').isVisible(), true);
  await page.goto('http://localhost/deals?view=list&filter=no-next-step&mode=live');
  await page.locator('#prospectsLane').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('#boardLive')?.textContent);
  assert.equal(await page.locator('#prospectsLane').isHidden(), true);
  assert.doesNotMatch(await page.locator('#boardLive').textContent(), /prospect/i);
});
