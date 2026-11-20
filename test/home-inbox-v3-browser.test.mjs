import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import axe from 'axe-core';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
let outDir;
before(async () => { outDir = temporaryDirectory('inbox-v3-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('test-artifacts/inbox-v3', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) test(`automatic settlement reasons and lifecycle on Home ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const id = '00000000-0000-0000-0000-000000000001';
  const rows = ['next_action', 'email_proposal', 'fact_review', 'tour_feedback'].map((source_type, i) => ({ item_id: String(i), source_type, source_id: String(i), source_version: 's1', source_state: 'done', title: `Resolved ${source_type}`, activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'settled', snoozed_until: null, explicit_unsettle: false, section: 'settled', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: ['Task', 'Reply draft', 'Fact review', 'Tour feedback'][i], merged_source_ids: [], action_id: i === 0 ? id : null, action_version: i === 0 ? 7 : null, deal_id: null, auto_settled: true }));
  const calls = [];
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    calls.push({ name, args });
    let payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: rows }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    if (name.endsWith('-home-inbox')) {
      const item = rows.find(item => item.item_id === args.items[0].item_id);
      Object.assign(item, { auto_settled: false, disposition: name.startsWith('unsettle') ? 'inbox' : name.startsWith('snooze') ? 'snoozed' : 'settled', explicit_unsettle: name.startsWith('unsettle'), snoozed_until: args.until || null, base_version: item.base_version + 'x' }); item.section = item.disposition;
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: item.item_id, ok: true, item }] };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const done = page.getByRole('region', { name: 'Earlier and undated completions', exact: true });
  await done.getByRole('button', { name: 'See all 4', exact: true }).click();
  assert.equal(await done.getByText('Done, time not recorded', { exact: true }).count(), 4);
  assert.equal(await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).locator('[data-inbox-row]').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'In motion and waiting', exact: true }).locator('[data-inbox-row]').count(), 0);
  assert.doesNotMatch(await done.textContent(), /by you/);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/inbox-v3/home-${width}-${theme}.png`, fullPage: true });
  const card = page.locator('[data-inbox-row="0"]');
  await card.getByRole('button', { name: 'Show in inbox', exact: true }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  await card.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('region', { name: 'In motion and waiting', exact: true }).getByRole('button', { name: 'See all 1', exact: true }).click();
  await page.getByRole('region', { name: 'In motion and waiting', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  await card.getByRole('button', { name: 'Wake', exact: true }).click();
  await card.getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).getByText('Hidden from inbox by you', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  assert.ok(calls.some(call => call.name === 'read-home-inbox-v3'));
});

for (const refusal of ['unknown_tool', 'partner_required', 'malformed']) test(`Home reports v3 ${refusal} truthfully`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } }); calls.push(name);
    const payload = name === 'read-home-inbox-v3' ? { error: refusal }
      : name === 'read-home-inbox-v2' ? { ok: true, schema_version: 'home-inbox.v2', auto_settle_enabled: false, working_collapsed: true, truncated: false, limit: 1000, items: [] }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  if (refusal === 'unknown_tool') {
    await page.getByText('Automatic settlement unavailable. Showing the earlier inbox; completed items may still need review.', { exact: true }).waitFor();
    assert.ok(calls.includes('read-home-inbox-v2'));
  } else {
    await page.getByRole('heading', { name: 'Inbox unavailable', exact: true }).waitFor();
    assert.equal(calls.includes('read-home-inbox-v2'), false);
  }
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});

for (const [transition, before, after] of [
  ['Canonical work resolves', { source_state: 'needs_attention', section: 'inbox' }, { source_state: 'done', section: 'settled', disposition: 'settled', auto_settled: true }],
  ['Work needs review', { source_state: 'working', section: 'working' }, { source_state: 'needs_attention', section: 'inbox' }],
  ['Processing completes', { source_state: 'working', section: 'working' }, { source_state: 'done', section: 'done' }],
  ['Snooze expires after resolution', { source_state: 'done', section: 'snoozed', disposition: 'snoozed', snoozed_until: '2099-01-01T00:00:00Z' }, { source_state: 'done', section: 'settled', disposition: 'settled', auto_settled: true }],
  ['Canonical work reopens', { source_state: 'done', section: 'inbox', explicit_unsettle: true }, { source_state: 'needs_attention', section: 'inbox', explicit_unsettle: true }],
]) test(`Home refresh transition ${transition}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const id = '00000000-0000-0000-0000-000000000001';
  const item = { item_id: 'transition', source_id: id, source_type: transition === 'Processing completes' ? 'capture_session' : 'next_action', source_version: 's1', title: 'Synthetic transition', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: transition === 'Processing completes' ? 'Call' : 'Task', merged_source_ids: [], action_id: transition === 'Processing completes' ? null : id, action_version: transition === 'Processing completes' ? null : 7, deal_id: null, auto_settled: false, ...before };
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    let payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: [item] } : { items: [] };
    if (name === 'settle-home-inbox') {
      Object.assign(item, { section: 'settled', disposition: 'settled', base_version: 'opaque:2' });
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: args.items[0].item_id, ok: true, item }] };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  if (['working', 'snoozed'].includes(before.section)) await page.getByRole('region', { name: 'In motion and waiting', exact: true }).getByRole('button', { name: 'See all 1', exact: true }).click();
  await page.locator('[data-inbox-row="transition"]').waitFor();
  Object.assign(item, after);
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const section = after.section === 'settled' || after.section === 'done' ? 'Earlier and undated completions' : 'Needs your attention';
  await page.getByRole('region', { name: section, exact: true }).locator('[data-inbox-row="transition"]').waitFor();
  if (after.auto_settled) await page.getByText('Done, time not recorded', { exact: true }).waitFor();
  else await page.locator('[data-inbox-row="transition"] .inbox-badge').filter({ hasText: after.source_state.replaceAll('_', ' ') }).waitFor();
  if (transition === 'Processing completes') {
    await page.locator('[data-inbox-row="transition"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
    await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).getByText('Hidden from inbox by you', { exact: true }).waitFor();
  }
});

for (const width of [390, 1440]) test(`Engine Home shows late work, removes Hide, and drops work with a reason at ${width}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  page.setDefaultTimeout(7000);
  await page.clock.setFixedTime(new Date('2026-11-19T18:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/api/v1/intelligence/mail-needs-partner?*', route => route.fulfill({
    json: { ok: true, schema_version: 'home-mail-priorities.v1', items: [], more: false },
  }));
  const id = '00000000-0000-0000-0000-000000000001';
  const step = { item_id: `next_action:${id}`, source_type: 'next_action', source_id: id, source_version: '7',
    source_state: 'needs_attention', title: 'Send sample terms', activity_at: '2026-11-03T12:00:00Z', hold_until: null,
    due_on: '2026-11-16', unseen: false, disposition: 'settled', snoozed_until: null, explicit_unsettle: false,
    section: 'settled', base_version: '7:1:settled', context_label: 'Example Dental', open_url: null, kind_label: 'Task',
    merged_source_ids: [id], action_id: id, action_version: 7, deal_id: null, auto_settled: false,
    completed_at: null, waiting_version: 0, waiting_on: null };
  const feedback = { ...step, item_id: 'notification:00000000-0000-0000-0000-000000000002', source_type: 'notification',
    kind: 'tour_feedback', kind_label: 'Update', title: 'Example Dental commented on a tour', due_on: null, disposition: 'inbox',
    section: 'inbox', action_id: null, action_version: null, base_version: '1:0:inbox' };
  await page.addInitScript(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has('card')) return;
    url.searchParams.set('mode', 'live');
    history.replaceState(null, '', url);
  });
  const legacyTodayReads = [];
  let todayFailure = null;
  await page.route('**/?*', async route => {
    const url = new URL(route.request().url());
    if (!route.request().isNavigationRequest() || url.pathname !== '/') return route.fallback();
    const response = await route.fetch();
    const body = (await response.text()).replace('id="homeRoot"', 'id="homeRoot" data-home-today-from-engine');
    return route.fulfill({ response, body });
  });
  await page.route('**/api/engine/home/today', route => {
    if (todayFailure === 'both') return route.fulfill({ status: 503 });
    return route.fulfill({ json: {
      ok: true, schema_version: 'home-today.v1', viewer: 'joe', owner: 'all', today: '2026-11-19',
      partners: [{ slug: 'joe', name: 'Joe Example' }, { slug: 'dell', name: 'Dell Example' }],
      meetings: todayFailure === 'meetings'
        ? { state: 'unavailable', reason: "Today's meetings could not be loaded.", observed_at: null, items: [], follow_up_reviews: [] }
        : { state: 'partial', reason: null, observed_at: '2026-11-19T15:00:00Z', follow_up_reviews: [], items: [{
        title: 'Example walkthrough', start: '2026-11-19T16:00:00Z', end: '2026-11-19T17:00:00Z',
        context_label: 'Example Dental', attendees: [{ name: 'Demo Attendee', email: null }],
        open_url: '/deals?deal=demo', possible_deals: [{ name: 'Example Dental', open_url: '/deals?deal=demo' }],
      }] },
      reminders: todayFailure === 'reminders'
        ? { state: 'unavailable', reason: "Today's reminders could not be loaded.", late: [], upcoming: [] }
        : {
          state: 'ready', reason: null,
          late: [{ id, kind: 'step', home_item_id: step.item_id, owner: 'joe', title: step.title,
            context_label: 'Example Dental', due_on: step.due_on, days_late: 3, late_label: '3 days late', open_url: null }],
          upcoming: [{ id: 'follow-up', kind: 'call_follow_up', home_item_id: null, owner: 'dell', title: 'Send the sample invoice',
            context_label: 'Example Office', due_on: '2026-11-19', days_late: null, late_label: null, open_url: '/calls?session=example' }],
        },
    } });
  });
  let capabilities = false, stepOpen = true, feedbackOpen = true;
  const writes = [];
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let payload = { items: [] };
    if (name === 'read-home-inbox-v5') payload = { ok: true, schema_version: 'home-inbox.v5', engine_marks: true,
      home_mark_drop: capabilities, home_proposal_drop: capabilities, auto_settle_enabled: true, working_collapsed: true,
      truncated: false, limit: 1000, items: [...(stepOpen ? [step] : []), ...(feedbackOpen ? [feedback] : [])] };
    if (name === 'deal-room-board') payload = { actor: 'joe', deals: [] };
    if (['today-triage', 'calendar-meeting-prep'].includes(name)) legacyTodayReads.push(name);
    if (name === 'end-engine-home-step') {
      writes.push({ name, args });
      stepOpen = false;
      payload = { next_step_id: id, status: 'cancelled', change_id: 8 };
    }
    if (name === 'save-engine-home-mark') {
      writes.push({ name, args });
      feedbackOpen = args.action === 'undo_done';
      feedback.base_version = feedbackOpen ? '2:0:inbox' : '2:0:done';
      payload = { ok: true, item_id: feedback.item_id, base_version: feedback.base_version, previous: { disposition: null, snoozed_until: null } };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const late = page.getByRole('region', { name: 'Late', exact: true });
  const lateStep = late.locator('[data-inbox-row]');
  await lateStep.getByText('3 days late', { exact: false }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).count(), 0);
  assert.equal(await lateStep.getByRole('button', { name: 'Hide from inbox', exact: true }).count(), 0);
  await lateStep.getByRole('checkbox').check();
  assert.equal(await page.getByRole('button', { name: 'Settle selected', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  const tour = page.locator('[data-inbox-row]').filter({ hasText: feedback.title });
  assert.equal(await tour.getByRole('button', { name: 'Drop', exact: true }).count(), 0);
  assert.equal(await tour.getByRole('button', { name: 'Done', exact: true }).count(), 0);
  capabilities = true;
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await tour.getByRole('button', { name: 'Drop', exact: true }).waitFor();
  await tour.getByRole('button', { name: 'Done', exact: true }).click();
  await tour.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await tour.waitFor();
  assert.deepEqual(writes.map(({ args }) => args.action), ['done', 'undo_done']);
  assert.equal(writes[1].args.base_version, '2:0:done');

  assert.equal(await page.getByText('Your working week', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Upcoming meetings', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Your schedule', { exact: true }).count(), 0);
  const today = page.getByRole('complementary', { name: 'Today', exact: true });
  if (!(await today.isVisible())) await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await today.getByText('Example walkthrough', { exact: true }).waitFor();
  assert.equal(await page.getByText('Example walkthrough', { exact: true }).count(), 1);
  assert.equal(await today.getByText('Deal pulse', { exact: true }).count(), 0);
  await today.getByRole('heading', { name: 'Due today', exact: true }).waitFor();
  if (width === 1440) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `test-artifacts/inbox-v3/engine-today-${width}.png`, animations: 'disabled' });
  await today.getByText('Example walkthrough', { exact: true }).click();
  await today.getByText('Attendees: Demo Attendee', { exact: true }).waitFor();
  assert.equal(await today.getByRole('link', { name: 'Open deal' }).getAttribute('href'), '/deals?deal=demo');
  const reminder = today.getByRole('link', { name: /Send sample terms/ });
  assert.equal(await reminder.getAttribute('href'), '/?card=' + encodeURIComponent(step.item_id));
  assert.match(await reminder.textContent(), /3 days late/);
  const owners = today.getByLabel('Reminders for');
  await owners.selectOption('dell');
  assert.equal(await reminder.count(), 0);
  await today.getByRole('link', { name: /Send the sample invoice/ }).waitFor();
  assert.equal(await today.getByText('Example walkthrough', { exact: true }).count(), 1);
  assert.doesNotMatch(await today.textContent(), /2026-11-19|Checking…/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await owners.selectOption('joe');
  await reminder.click();
  await page.locator('[data-current="true"][data-inbox-row]').getByText(step.title, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('card'), step.item_id);

  if (!(await today.isVisible())) await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await today.getByText('Example walkthrough', { exact: true }).waitFor();
  todayFailure = 'meetings';
  await page.locator('#appSyncRefresh').evaluate(button => button.click());
  await today.getByRole('region', { name: 'Meetings', exact: true }).getByText("Today's meetings could not be loaded.", { exact: true }).waitFor();
  await reminder.waitFor();
  todayFailure = 'reminders';
  await today.getByRole('button', { name: 'Retry Today' }).click();
  await today.getByRole('region', { name: 'Dated reminders', exact: true }).getByText("Today's reminders could not be loaded.", { exact: true }).waitFor();
  assert.equal(await reminder.count(), 0);
  await today.getByText('Example walkthrough', { exact: true }).waitFor();
  todayFailure = 'both';
  await today.getByRole('button', { name: 'Retry Today' }).click();
  await today.getByText("Couldn't load meetings.").waitFor();
  await today.getByText("Couldn't load dated reminders.").waitFor();
  assert.deepEqual(legacyTodayReads, []);
  if (width === 390) await today.getByRole('button', { name: 'Close Today' }).click();

  await lateStep.getByRole('button', { name: 'Drop', exact: true }).click();
  const reason = page.getByRole('dialog', { name: 'Drop with a reason' });
  assert.equal(await reason.getByRole('button', { name: 'Drop', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await reason.waitFor({ state: 'detached' });
  assert.equal(await lateStep.getByRole('button', { name: 'Drop', exact: true }).evaluate(button => button === document.activeElement), true);
  assert.equal(writes.length, 2);
  await lateStep.getByRole('button', { name: 'Drop', exact: true }).click();
  await reason.getByLabel('Reason for dropping').fill('  Work moved to a different site.  ');
  await page.screenshot({ path: `test-artifacts/inbox-v3/engine-drop-${width}.png` });
  await reason.getByRole('button', { name: 'Drop', exact: true }).click();
  await lateStep.waitFor({ state: 'detached' });
  assert.equal(writes[2].args.resolution, 'cancelled');
  assert.equal(writes[2].args.reason, 'Work moved to a different site.');
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
});
