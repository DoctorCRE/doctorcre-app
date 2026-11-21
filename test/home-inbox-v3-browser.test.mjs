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
  await page.goto(`${server.origin}/inbox?mode=live`);
  if (refusal === 'unknown_tool') {
    await page.getByText('Automatic settlement unavailable. Showing the earlier inbox; completed items may still need review.', { exact: true }).waitFor();
    assert.ok(calls.includes('read-home-inbox-v2'));
  } else {
    await page.getByRole('heading', { name: 'Inbox unavailable', exact: true }).waitFor();
    assert.equal(calls.includes('read-home-inbox-v2'), false);
  }
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
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
  await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', viewer: 'joe', today: '2026-11-19',
    meetings: { state: 'empty', items: [] },
  } }));
  let capabilities = false, stepOpen = true, feedbackOpen = true;
  const attendeeSteps = [];
  const writes = [];
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let payload = { items: [] };
    if (name === 'read-home-inbox-v5') payload = { ok: true, schema_version: 'home-inbox.v5', engine_marks: true,
      home_mark_drop: capabilities, home_proposal_drop: capabilities, auto_settle_enabled: true, working_collapsed: true,
      truncated: false, limit: 1000, items: [...(stepOpen ? [step] : []), ...(feedbackOpen ? [feedback] : []), ...attendeeSteps] };
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
  await page.clock.install({ time: new Date('2026-11-19T16:00:00Z') });
  await page.goto(`${server.origin}/?mode=live`);
  const late = page.getByRole('region', { name: 'Reminders', exact: true });
  const lateStep = late.locator('[data-inbox-row]').filter({ hasText: step.title });
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
  await page.clock.fastForward(60_000);
  await tour.getByRole('button', { name: 'Drop', exact: true }).waitFor();
  await tour.getByRole('button', { name: 'Done', exact: true }).click();
  await tour.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await tour.waitFor();
  assert.deepEqual(writes.map(({ args }) => args.action), ['done', 'undo_done']);
  assert.equal(writes[1].args.base_version, '2:0:done');

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

  const names = ['Dana Example', 'Lee Example', 'Morgan Example', 'Taylor Example'];
  attendeeSteps.push(...names.map((name, index) => {
    const id = `00000000-0000-4000-8000-00000000001${index}`;
    return { ...step, item_id: `next_action:${id}`, source_id: id, action_id: id, merged_source_ids: [id],
      title: 'Review the site plan', context_label: name, section: 'inbox', disposition: 'inbox',
      open_url: `/relationships?node=party:${id}` };
  }));
  await page.clock.fastForward(60_000);
  await late.getByRole('button', { name: /^See all/ }).click();
  for (const name of names) {
    const card = late.locator('[data-inbox-row]').filter({ hasText: name });
    await card.getByRole('link', { name: 'Review the site plan', exact: true }).waitFor();
    await card.getByText(new RegExp(`^${name} · 3 days late$`)).waitFor();
  }
});

async function meetingAnswerFixture(t, { remindersUnavailable = false } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  const deal = { id: '00000000-0000-4000-8000-000000000001', name: 'Example Dental', owner: 'joe' };
  const reviews = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'].map((key, index) => ({
    key, title: `Example meeting ${index + 1}`, state: 'needs_review', prompt: 'Confirm whether this meeting happened.',
    start: '2026-11-19T13:00:00Z', end: '2026-11-19T14:00:00Z',
  }));
  const data = { board: { deals: [deal] }, loseLog: false };
  const receipts = new Map(), attempts = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/invoices?mode=live', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('<html ', '<html data-home-today-from-engine ');
    return route.fulfill({ response, body });
  });
  await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', viewer: 'joe', today: '2026-11-19',
    meetings: { state: 'empty', reason: null, observed_at: '2026-11-19T15:00:00Z', notes: [], items: [], follow_up_reviews: reviews },
    reminders: remindersUnavailable
      ? { state: 'unavailable', reason: "Today's reminders could not be loaded.", late: [], upcoming: [] }
      : { state: 'empty', reason: null, late: [], upcoming: [] },
  } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const body = name === 'deal-room-board' ? data.board : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(body) }] } } });
  });
  // The rolled-over agenda has neither review even while the stale Today view has both.
  await page.route('**/api/engine/calendar/agenda', route => route.fulfill({ json: { confirmed: [], dismissed: [] } }));
  async function save(route, action, key) {
    const args = route.request().postDataJSON();
    attempts.push({ action, key, args });
    const prior = receipts.get(args.idempotency_key);
    const status = action === 'log' ? 201 : 200;
    if (prior) return prior.action === action && JSON.stringify(prior.args) === JSON.stringify(args)
      ? route.fulfill({ status, json: { ...prior.receipt, replayed: true } })
      : route.fulfill({ status: 409, json: { error: 'key_reuse' } });
    const receipt = action === 'log'
      ? { activity_id: deal.id, existing: false, about: args.about }
      : { key, dismissed_at: '2026-11-19T15:00:00Z' };
    receipts.set(args.idempotency_key, { action, args, receipt });
    if (action === 'log' && data.loseLog) return route.abort();
    return route.fulfill({ status, json: receipt });
  }
  await page.route('**/api/engine/activities', route => save(route, 'log', route.request().postDataJSON().calendar_review_key));
  await page.route('**/api/engine/calendar/reviews/*/dismissal', route =>
    save(route, 'dismiss', new URL(route.request().url()).pathname.split('/').at(-2)));
  await page.goto(`${server.origin}/invoices?mode=live`);
  const today = page.getByRole('complementary', { name: 'Today', exact: true });
  const question = index => today.locator(`[data-review="${reviews[index].key}"]`);
  const openReview = async index => {
    const review = question(index).getByRole('button', { name: 'Review meeting', exact: true });
    if (await review.getAttribute('aria-expanded') !== 'true') await review.click();
  };
  const log = async index => {
    await openReview(index);
    await question(index).getByLabel('Deal').selectOption(deal.id);
    await question(index).getByRole('button', { name: 'It happened' }).click();
  };
  const dismiss = async index => {
    await openReview(index);
    await question(index).getByRole('button', { name: 'Dismiss', exact: true }).click();
  };
  return { page, data, reviews, receipts, attempts, today, question, log, dismiss,
    refresh: () => page.locator('#appSyncRefresh').evaluate(button => button.click()) };
}

test('stale meeting answers show the stored decision after the agenda rolls over', async t => {
  const { page, today, log, dismiss, receipts } = await meetingAnswerFixture(t, { remindersUnavailable: true });
  await log(0);
  await today.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  await today.getByText("Today's reminders could not be loaded.", { exact: true }).waitFor();
  await dismiss(1);
  await today.getByText('Meeting dismissed.', { exact: true }).waitFor();
  await page.reload();
  await dismiss(0);
  await today.getByText('Meeting already logged.', { exact: true }).waitFor();
  await log(1);
  await today.getByText('Meeting already dismissed.', { exact: true }).waitFor();
  assert.deepEqual([...receipts.values()].map(row => row.action), ['log', 'dismiss']);
});

test('an unconfirmed meeting log replays the original request after the title and deal list change', async t => {
  const { data, reviews, attempts, question, today, log, refresh } = await meetingAnswerFixture(t);
  data.loseLog = true;
  await log(0);
  const check = question(0).getByRole('button', { name: 'Check meeting log' });
  await check.waitFor();
  reviews[0].title = 'Rescheduled example meeting';
  data.board = { deals: [] };
  await refresh();
  await question(0).getByRole('heading', { name: `${reviews[0].title} was scheduled — confirm it happened` }).waitFor();
  assert.equal(await question(0).getByLabel('Deal').count(), 0);
  await check.click();
  await today.getByText('Meeting already logged.', { exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
});

test('malformed meeting deal results report a load failure and leave Retry Today available', async t => {
  const { data, question, today, refresh } = await meetingAnswerFixture(t);
  await question(0).getByRole('button', { name: 'Review meeting', exact: true }).click();
  await question(0).getByLabel('Deal').waitFor();
  data.board = { deals: null };
  await refresh();
  await question(0).getByText('Couldn’t load deals. Retry Today to choose a deal.', { exact: true }).waitFor();
  assert.equal(await question(0).getByText('No open deals', { exact: false }).count(), 0);
  const retry = today.getByRole('button', { name: 'Retry Today', exact: true });
  assert.equal(await retry.isVisible(), true);
  data.board = { deals: [] };
  await retry.click();
  await question(0).getByText('No open deals to log this meeting on.', { exact: true }).waitFor();
  assert.equal(await retry.isVisible(), false);
});
