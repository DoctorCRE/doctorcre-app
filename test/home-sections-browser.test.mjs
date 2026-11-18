import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { context as buildContext } from 'esbuild';
import { scenario } from './browser-scenario.mjs';
import worker from '../src/worker.js';

describe('test/home-sections-browser.test.mjs', () => {
const NOW = new Date('2026-11-03T10:00:00-06:00');
let outDir;
before(async () => { outDir = temporaryDirectory('home-sections-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });

for (const enabled of [false, true]) test(`Home opens inbox cards with the engine switch ${enabled ? 'on' : 'off'}`, async t => {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));

  const dealId = '00000000-0000-0000-0000-000000000001';
  const callId = '00000000-0000-0000-0000-000000000002';
  const partyId = '00000000-0000-0000-0000-000000000003';
  const tasks = [
    { title: 'Read the sample lease', label: 'Example Dental', path: `/deals?deal=${dealId}&focus=next-step`, dealId },
    { title: 'Send the sample floor plan', label: 'Call summary', path: `/calls?session=${callId}`, dealId, call: true },
    { title: 'Check in about the sample site', label: 'Example Contact', path: `/relationships?node=party:${partyId}` },
  ];
  const snapshot = reader => ({
    ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true,
    items: tasks.map((task, index) => {
      const id = `00000000-0000-0000-0000-00000000001${index}`;
      const source = task.call ? 'capture_post_call_action' : 'next_action';
      return {
        item_id: `${source}:${id}`, source_type: source, source_id: id, source_version: '7',
        source_state: 'needs_attention', base_version: '7:0:inbox', title: `${task.title} (${reader})`,
        activity_at: '2026-11-02T12:00:00.000Z', completed_at: null, due_on: '2026-11-03',
        hold_until: null, snoozed_until: null, disposition: 'inbox', section: 'inbox', unseen: false,
        explicit_unsettle: false, auto_settled: false, context_label: task.call ? 'Example Dental' : task.label,
        open_url: task.path, kind_label: task.call ? 'Call follow-up' : 'Task', action_id: id, action_version: 7,
        deal_id: task.dealId ?? null, merged_source_ids: [id], waiting_version: 0, waiting_on: null,
        source_activity: task.call ? { kind: 'call', id: callId, happened_at: '2026-11-02T11:00:00.000Z',
          contact: 'Example Contact', summary: 'Discussed the floor plan.', quote: 'Please send the floor plan.' } : null,
      };
    }),
  });
  const reads = [];
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'home-from-engine' && enabled ? 'on' : null },
    ENGINE: { fetch: async request => {
      reads.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json(snapshot('new inbox'));
    } },
    CARR: { fetch: async request => {
      const { id, params: { name } } = await request.json();
      if (name === 'read-home-inbox-v5') reads.push(name);
      const payload = name === 'read-home-inbox-v5' ? snapshot('current inbox') : { ok: true, items: [], deals: [] };
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request();
    const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  await open('/?mode=live');
  const reader = enabled ? 'new inbox' : 'current inbox';
  const inbox = page.getByRole('region', { name: 'Inbox cards', exact: true });
  const first = inbox.getByRole('link', { name: new RegExp(`^${tasks[0].title}`) });
  await first.waitFor();
  assert.equal(await first.textContent(), `${tasks[0].title} (${reader})`);
  await inbox.getByRole('region', { name: 'Today', exact: true }).getByRole('button', { name: 'See all 3', exact: true }).click();
  assert.equal(await inbox.locator('[data-inbox-row]').count(), tasks.length);
  for (const task of tasks) {
    const title = `${task.title} (${reader})`;
    const link = inbox.getByRole('link', { name: title, exact: true });
    assert.equal(await link.count(), 1);
    const card = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: title, exact: true }) });
    assert.deepEqual(await card.getByRole('button').allTextContents(), ['Open', 'Mark done', 'Hide from inbox', 'Snooze']);
    assert.match(await card.locator('time').textContent(), /Nov 3/);
    await link.click();
    const details = card.getByRole('region', { name: `Details for ${title}` });
    assert.equal(await details.getByRole('link', { name: task.label, exact: true }).getAttribute('href'), task.path);
    await details.getByRole('button', { name: 'Close', exact: true }).click();
  }
  assert.deepEqual(reads, [enabled ? 'GET /api/engine/home/inbox' : 'read-home-inbox-v5']);
});

for (const width of [390, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) test(`sectioned Home and shared panels ${width} ${theme}`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 }, timezoneId: 'America/Chicago' } });
  const { page } = run;
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await run.open('/');
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  for (const name of ['Needs your attention', 'Today', 'In motion and waiting', 'Done today', 'Earlier and undated completions']) {
    const heading = page.locator('main').getByRole('heading', { name: new RegExp(`^${name}`) });
    await heading.waitFor();
    assert.equal(await heading.count(), 1);
  }
  await page.getByText('Nothing here right now.', { exact: true }).first().waitFor();
  const more = page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('button', { name: /See all|Show less/ });
  await more.click(); assert.equal(await more.getAttribute('aria-expanded'), 'true');
  await more.click(); assert.equal(await more.getAttribute('aria-expanded'), 'false');

  const calendar = page.locator('#appSidebarToggle'); const today = page.locator('#appTodayToggle');
  if (width === 390) { assert.equal(await today.getAttribute('aria-expanded'), 'false'); await calendar.click(); }
  await page.locator('#appSidebar').getByRole('heading', { name: 'Your calendar' }).waitFor();
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  await page.locator('#appSidebar').getByText('Demo practice planning', { exact: true }).waitFor();
  if (width === 390) await page.screenshot({ path: `${run.outputDir}/calendar-drawer-${width}-${theme}.png`, fullPage: true });
  assert.equal(await page.locator('#appSidebar').getByRole('link', { name: 'Review call follow-ups ↗', exact: true }).isVisible(), false);
  if (width === 390) { await page.keyboard.press('Escape'); assert.equal(await calendar.evaluate(n => n === document.activeElement), true); await today.click(); }
  assert.equal(await today.getAttribute('aria-expanded'), 'true');
  await page.getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor();
  await page.locator('#appToday').getByText('Demo practice planning', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  if (width === 390) await page.screenshot({ path: `${run.outputDir}/today-drawer-${width}-${theme}.png`, fullPage: true });
  await page.locator('[data-layout-close="today"]').click(); assert.equal(await today.getAttribute('aria-expanded'), 'false');
  await today.click(); assert.equal(await today.getAttribute('aria-expanded'), 'true');
  if (width === 390) await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${run.outputDir}/home-${width}-${theme}.png`, fullPage: true });
  await run.open(`/calendar`);
  await page.locator('#appToday').getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await today.getAttribute('aria-expanded'), width === 390 ? 'false' : 'true');
  assert.equal(await page.locator('#appSidebar .app-layout-working').count(), 0);
  assert.equal(await page.locator('#appSidebar [data-layout-slot=sidebar]').count(), 0);
  await page.screenshot({ path: `${run.outputDir}/calendar-${width}-${theme}.png`, fullPage: true });
});

for (const now of ['2026-11-03T23:00:00-06:00', '2026-11-03T23:30:00-06:00', '2026-11-03T23:59:59-06:00']) test(`at ${now} tomorrow meetings stay upcoming and out of Today`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: new Date(now), page: { viewport: { width: 1440, height: 900 }, timezoneId: 'America/Chicago' } });
  const { page } = run;
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await run.open('/');
  const meeting = page.locator('#appSidebar .calendar-panel-meeting').filter({ hasText: 'Demo practice planning' });
  await meeting.waitFor();
  assert.equal(await meeting.locator('time').getAttribute('datetime'), new Date(run.now.getTime() + 3600000).toISOString());
  await page.locator('#appScheduleSlot').getByText('No meetings returned for today.', { exact: true }).waitFor();
  assert.equal(await page.locator('#appToday').getByText('Demo practice planning', { exact: true }).count(), 0);
});

for (const state of ['empty', 'unavailable', 'partial']) test(`Home and schedule keep truthful ${state} states`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width: 1280, height: 900 } } });
  const { page } = run;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    const payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [], working_collapsed: true, auto_settle_enabled: true }
      : name === 'calendar-meeting-prep' ? { state, items: [] }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] }
      : { items: [], events: [], cursor: 'end' };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await run.open(`/?mode=live`);
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await page.locator('main').getByText('Nothing here right now.', { exact: true }).first().waitFor();
  assert.equal(await page.locator('main').getByText('Nothing here right now.', { exact: true }).count(), 6);
  await page.locator('#appScheduleSlot').getByText(state === 'unavailable' ? 'Schedule unavailable. Retry Today to try again.' : state === 'partial' ? 'No meetings returned for today.' : 'No meetings scheduled today.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});

for (const fragment of ['homeCallTasks', 'homeEmailFollowups', 'homeOverdueReviews', 'homeBrief', 'homeReplyOutcomes']) test(`legacy Home bookmark ${fragment}`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  await run.open(`/?review=2#${fragment}`);
  await page.waitForURL(`**/review-workflows?review=2#${fragment}`, { timeout: 5000 });
  await page.locator(`#${fragment}`).waitFor({ state: 'attached' });
});

test('Calendar rail leaves page tools in the center at narrow desktop sizes', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    await run.open(`/calendar`);
    await page.locator('#appCalendarSlot a').first().waitFor();
    assert.equal(await page.locator('#appSidebar .app-layout-working, #appSidebar [data-layout-slot=sidebar], #appSidebar .calendar-panel-followup').count(), 0);
    assert.equal(await page.locator('#appMainSlot .app-layout-page-tools').count(), 1);
    assert.ok(await page.locator('#appSidebar').evaluate(node => node.scrollHeight <= node.clientHeight));
  }
});

for (const outcome of ['empty', 'unavailable']) test(`Home reserves its frame and defers panels until the ${outcome} inbox paints`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width: 1280, height: 900 } } });
  const { page } = run;
  const panelReads = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    if (name !== 'read-home-inbox-v3') panelReads.push(name);
    const value = name === 'read-home-inbox-v3' ? outcome === 'empty'
      ? { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [], working_collapsed: true, auto_settle_enabled: true }
      : { ok: false, error: 'synthetic_unavailable' }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  const gate = await run.hold(request => new URL(request.url()).pathname === '/mcp' && request.postDataJSON()?.params?.name === 'read-home-inbox-v3');
  await run.open(`/?mode=live`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Loading your inbox…', { exact: true }).waitFor();
  await page.locator('#appSidebarToggle').waitFor();
  assert.deepEqual(panelReads, []);
  await gate.requested;
  gate.release();
  await page.locator('#appScheduleSlot').getByText('No meetings scheduled today.', { exact: true }).waitFor();
  assert.ok(panelReads.includes('calendar-meeting-prep'));
  await page.getByText(outcome === 'empty' ? 'Nothing here right now.' : 'Inbox unavailable', { exact: true }).first().waitFor();
});

test('a session ending during the assistant download prevents a late mount', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  await page.route('**/js/doc-presence.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__assistantModuleReady = true;` });
  });
  const gate = await run.hold('**/js/doc-presence.js');
  await run.open('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.home-slice [data-inbox-row]').first().waitFor();
  await page.locator('#appSidebarToggle').waitFor();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  await gate.requested;
  gate.release();
  await page.waitForFunction(() => window.__assistantModuleReady);
  assert.equal(await page.locator('#docPresence').count(), 0);
});

test('late automatic Home walkthrough preserves an open account menu', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => route.fulfill({ json: { result: { content: [{ type: 'text', text: '{}' }] } } }));
  await page.route('**/js/doc-presence.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__assistantModuleReady = true;` });
  });
  const gate = await run.hold('**/js/doc-presence.js');
  await run.open(`/?mode=live`, { waitUntil: 'domcontentloaded' });
  const account = page.getByRole('button', { name: 'Joe: account and settings', exact: true });
  await account.click();
  assert.equal(await page.locator('#accountMenu').isVisible(), true);
  await gate.requested;
  gate.release();
  await page.waitForFunction(() => window.__assistantModuleReady && document.getElementById('docOpen'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#accountMenu').isVisible(), true);
  assert.equal(await page.locator('[data-walkthrough]').count(), 0);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Done today evidence ${width} ${theme}`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), page: { viewport: { width, height: 900 }, timezoneId: 'America/Chicago' } });
  const { page } = run;
  await page.clock.install({ time: new Date('2026-11-04T16:00:17Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const item = (item_id, completed_at, fields = {}) => ({ item_id, completed_at, source_type: 'next_action', source_id: item_id, source_version: 'v1', source_state: 'done', title: item_id, activity_at: '2026-11-04T16:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'done', base_version: 'v1', context_label: 'Demo practice', due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000001', action_version: 7, deal_id: null, auto_settled: false, ...fields });
  const items = [item('Finished after midnight', '2026-11-04T06:10:00Z', { section: 'settled', disposition: 'settled', auto_settled: true }), item('Yesterday with a new notification', '2026-11-04T05:30:00Z'), item('Legacy completed task', null), item('Manually hidden task', null, { source_state: 'needs_attention', disposition: 'settled', section: 'settled' })];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const value = name === 'read-home-inbox-v5' ? { error: 'unknown_tool' } : name === 'read-home-inbox-v4' ? { ok: true, schema_version: 'home-inbox.v4', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: true } : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await run.open('/?mode=live');
  const today = page.getByRole('region', { name: 'Done today', exact: true });
  await today.getByText('Finished after midnight', { exact: true }).waitFor();
  assert.equal(await today.locator('[data-inbox-row]').count(), 1);
  assert.equal(await today.getByText('Yesterday with a new notification', { exact: true }).count(), 0);
  await today.getByText('Done Nov 4, 2026, 12:10 AM CST', { exact: true }).waitFor();
  const earlier = page.getByRole('region', { name: 'Earlier and undated completions', exact: true });
  await earlier.getByRole('button', { name: 'See all 2' }).click();
  await earlier.getByText('Done, time not recorded', { exact: true }).waitFor();
  const hidden = page.getByRole('region', { name: 'Hidden from inbox', exact: true });
  await hidden.getByText('Manually hidden task', { exact: true }).waitFor();
  await hidden.getByText('Hidden from inbox by you', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${run.outputDir}/done-today-${width}-${theme}.png`, fullPage: true });
  await new Promise(resolve => setTimeout(resolve, 2200));
  await page.clock.pauseAt(new Date('2026-11-05T05:59:59Z'));
  assert.equal(await today.locator('[data-inbox-row]').count(), 1);
  await page.clock.fastForward(1000);
  await today.locator('[data-inbox-row]').waitFor({ state: 'detached' });
  assert.equal(await today.locator('[data-inbox-row]').count(), 0);
});

async function workingScenario(t, { count = 3, current, width = 1440, theme = 'light' } = {}) {
  const compiler = await buildContext({ stdin: { contents: "export {fixtureInboxRpc} from './src/ui/home/fixture'; export {parseSnapshot} from './src/ui/home/inbox';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
  let compiled;
  try { compiled = await compiler.rebuild(); } finally { await compiler.dispose(); }
  const { fixtureInboxRpc, parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const original = parseSnapshot(await fixtureInboxRpc()('read-home-inbox-v5', {}));
  const template = original.items.find(item => item.item_id === 'demo-working');
  let snapshot = parseSnapshot({ ...original, items: [...original.items.filter(item => !['working', 'held', 'snoozed'].includes(item.section)), ...Array.from({ length: count }, (_, i) => ({ ...template, item_id: `working-${i}`, title: `Working card ${i}`, section: ['working', 'held', 'snoozed'][i % 3] }))] });
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  const { page } = run;
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    calls.push(name);
    const payload = name === 'read-home-inbox-v5' ? parseSnapshot(snapshot) : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await run.open(`/?mode=live${current ? `&card=${current}` : ''}`);
  await page.getByRole('searchbox').waitFor();
  const region = page.getByRole('region', { name: 'In motion and waiting', exact: true });
  await region.getByRole('heading', { level: 2 }).waitFor();
  return { ...run, region, calls, update: change => { snapshot = parseSnapshot(change(snapshot)); } };
}

for (const count of [0, 1, 3]) test(`working section closed with ${count} cards`, async t => {
  const { region } = await workingScenario(t, { count });
  assert.equal(await region.getByRole('heading', { level: 2 }).textContent(), `In motion and waiting ${count}`);
  assert.equal(await region.locator('[data-inbox-row]').count(), 0);
  assert.equal(await region.getByRole('button').count(), count ? 1 : 0);
  if (!count) await region.getByText('Nothing here right now.', { exact: true }).waitFor();
});

test('single working card exposes a disclosure', async t => {
  const { region } = await workingScenario(t, { count: 1 });
  assert.equal(await region.getByRole('button', { name: 'See all 1', exact: true }).count(), 1);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`working disclosure keyboard search refresh remount ${width} ${theme}`, async t => {
  const { page, region, calls, update } = await workingScenario(t, { width, theme });
  const disclosure = region.getByRole('button', { name: /See all|Show less/ });
  const ids = () => region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow));
  assert.deepEqual(await ids(), []);
  await disclosure.focus();
  const reads = () => calls.filter(name => /home-inbox|one-action|home-waiting/.test(name));
  const before = [...reads()];
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await ids(), ['working-0', 'working-1', 'working-2']);
  assert.equal(await disclosure.evaluate(node => node === document.activeElement), true);
  await page.screenshot({ path: `/tmp/WR617.S1.J60-open-${width}-${theme}.png`, fullPage: true });
  await page.keyboard.press('Space');
  assert.deepEqual(await ids(), []);
  assert.equal(await disclosure.evaluate(node => node === document.activeElement), true);
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(reads(), before);
  await page.screenshot({ path: `/tmp/WR617.S1.J60-closed-${width}-${theme}.png`, fullPage: true });
  const search = page.getByRole('searchbox');
  await search.fill('Working card 1');
  assert.equal(await region.getByRole('heading', { level: 2 }).textContent(), 'In motion and waiting 1');
  assert.deepEqual(await ids(), []);
  await disclosure.click();
  assert.deepEqual(await ids(), ['working-1']);
  await page.getByRole('search').getByRole('button', { name: 'Clear', exact: true }).click();
  assert.deepEqual(await ids(), ['working-0', 'working-1', 'working-2']);
  await search.fill('Working card 1');
  await disclosure.click();
  await page.getByRole('search').getByRole('button', { name: 'Clear', exact: true }).click();
  assert.deepEqual(await ids(), []);
  await disclosure.click();
  update(snapshot => ({ ...snapshot, items: snapshot.items.filter(item => item.item_id !== 'working-2') }));
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await region.getByRole('heading', { name: 'In motion and waiting 2', exact: true }).waitFor();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await ids(), ['working-0', 'working-1']);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload();
  await disclosure.waitFor();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  await disclosure.click();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  assert.equal(await disclosure.count(), 0);
});

test('closed working section preserves selected card without first preview', async t => {
  const { page, region } = await workingScenario(t, { current: 'working-1' });
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), ['working-1']);
  await page.getByRole('searchbox').fill('unmatched');
  await region.getByText('Pinned outside search', { exact: true }).waitFor();
  assert.equal(await region.locator('[data-inbox-row]').count(), 1);
  await region.getByRole('button', { name: 'See all 1', exact: true }).click();
  await region.getByRole('button', { name: 'Show less', exact: true }).click();
  assert.equal(await region.locator('[data-inbox-row="working-1"]').count(), 1);
});

for (const opened of [false, true]) test(`working refresh moves attention and resolved cards ${opened ? 'open' : 'closed'}`, async t => {
  const { page, region, update } = await workingScenario(t);
  if (opened) await region.getByRole('button', { name: /^See all/ }).click();
  update(snapshot => ({ ...snapshot, items: snapshot.items.map(item => item.item_id === 'working-0' ? { ...item, section: 'inbox', source_state: 'needs_attention', due_on: null } : item.item_id === 'working-1' ? { ...item, section: 'settled', disposition: 'settled', source_state: 'done', auto_settled: true } : item) }));
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('button', { name: /^See all/ }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row="working-0"]').waitFor();
  await page.getByRole('region', { name: 'Earlier and undated completions', exact: true }).getByRole('button', { name: /^See all/ }).click();
  await page.getByRole('region', { name: 'Earlier and undated completions', exact: true }).locator('[data-inbox-row="working-1"]').waitFor();
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), opened ? ['working-2'] : []);
  assert.equal(await region.getByRole('button', { name: /See all|Show less/ }).getAttribute('aria-expanded'), String(opened));
});

for (const state of ['Empty', 'Hidden', 'Visible', 'Filtered', 'FilteredOpen', 'Selected', 'Attention', 'Done']) for (const event of ['remount', 'invalidate']) test(`working ${state} ${event} transition`, async t => {
  const { page, region, update } = await workingScenario(t, { count: state === 'Empty' ? 0 : 3, current: state === 'Selected' ? 'working-1' : undefined });
  const ids = () => region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow));
  const disclosure = region.getByRole('button', { name: /See all|Show less/ });
  if (['Visible', 'FilteredOpen'].includes(state)) await disclosure.click();
  if (['Filtered', 'FilteredOpen'].includes(state)) await page.getByRole('searchbox').fill('Working card 1');
  if (['Attention', 'Done'].includes(state)) {
    update(snapshot => ({ ...snapshot, items: snapshot.items.map(item => item.item_id.startsWith('working-') ? { ...item, section: state === 'Attention' ? 'inbox' : 'settled', source_state: state === 'Attention' ? 'needs_attention' : 'done', disposition: state === 'Attention' ? 'inbox' : 'settled', auto_settled: state === 'Done', due_on: null } : item) }));
    await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
    await region.getByRole('heading', { name: 'In motion and waiting 0', exact: true }).waitFor();
    const destination = page.getByRole('region', { name: state === 'Attention' ? 'Needs your attention' : 'Earlier and undated completions', exact: true });
    await destination.getByRole('button', { name: /^See all/ }).click();
    await destination.locator('[data-inbox-row="working-0"]').waitFor();
  }
  assert.deepEqual(await ids(), state === 'Selected' ? ['working-1'] : state === 'Visible' ? ['working-0', 'working-1', 'working-2'] : state === 'FilteredOpen' ? ['working-1'] : []);
  if (event === 'invalidate') {
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await page.locator('[data-inbox-row]').count(), 0);
    assert.equal(await disclosure.count(), 0);
    return;
  }
  await page.reload();
  await region.getByRole('heading', { level: 2 }).waitFor();
  assert.equal(await page.getByRole('searchbox').inputValue(), '');
  assert.deepEqual(await ids(), state === 'Selected' ? ['working-1'] : []);
  if (['Empty', 'Attention', 'Done'].includes(state)) assert.equal(await disclosure.count(), 0);
  else assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  if (['Attention', 'Done'].includes(state)) {
    const destination = page.getByRole('region', { name: state === 'Attention' ? 'Needs your attention' : 'Earlier and undated completions', exact: true });
    await destination.getByRole('button', { name: /^See all/ }).click();
    for (const id of ['working-0', 'working-1', 'working-2']) await destination.locator(`[data-inbox-row="${id}"]`).waitFor();
  }
});

for (const opened of [false, true]) test(`working selected refresh retains disclosure ${opened ? 'open' : 'closed'}`, async t => {
  const { page, region, update } = await workingScenario(t, { current: 'working-1' });
  const disclosure = region.getByRole('button', { name: /See all|Show less/ });
  if (opened) await disclosure.click();
  update(snapshot => ({ ...snapshot, items: snapshot.items.filter(item => item.item_id !== 'working-2') }));
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await region.getByRole('heading', { name: 'In motion and waiting 2', exact: true }).waitFor();
  assert.equal(await disclosure.getAttribute('aria-expanded'), String(opened));
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), opened ? ['working-0', 'working-1'] : ['working-1']);
});

test('working empty refresh populates closed and hidden refresh stays closed', async t => {
  const { page, region, update } = await workingScenario(t);
  let saved;
  update(snapshot => { saved = snapshot; return { ...snapshot, items: [] }; });
  const refresh = page.getByRole('button', { name: 'Refresh inbox', exact: true });
  await refresh.click();
  await region.getByRole('heading', { name: 'In motion and waiting 0', exact: true }).waitFor();
  update(() => saved);
  await refresh.click();
  await region.getByRole('heading', { name: 'In motion and waiting 3', exact: true }).waitFor();
  for (let i = 0; i < 2; i++) {
    assert.equal(await region.locator('[data-inbox-row]').count(), 0);
    assert.equal(await region.getByRole('button').getAttribute('aria-expanded'), 'false');
    await refresh.click();
  }
});

for (const opened of [false, true]) test(`working select exact card from ${opened ? 'visible' : 'hidden'}`, async t => {
  const { page, region, open } = await workingScenario(t);
  if (opened) await region.getByRole('button', { name: /^See all/ }).click();
  assert.equal(await region.locator('[data-inbox-row]').count(), opened ? 3 : 0);
  await page.getByRole('searchbox').fill('Working card 1');
  await open('/?mode=live&card=working-1');
  assert.equal(await page.getByRole('searchbox').inputValue(), '');
  await region.locator('[data-inbox-row="working-1"]').waitFor();
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), ['working-1']);
});

test('working selected open remount closes and retains exact card', async t => {
  const { page, region } = await workingScenario(t, { current: 'working-1' });
  await region.getByRole('button', { name: /^See all/ }).click();
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), ['working-0', 'working-1', 'working-2']);
  await page.reload();
  await region.locator('[data-inbox-row="working-1"]').waitFor();
  assert.equal(await region.getByRole('button', { name: /^See all/ }).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await region.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow)), ['working-1']);
});

});
