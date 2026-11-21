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

for (const [enabled, width] of [[false, 1440], [true, 1440], [true, 390]]) test(`Home opens inbox cards with plain wording and source excerpts when the engine switch is ${enabled ? 'on' : 'off'} at ${width}px`, async t => {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));

  const dealId = '00000000-0000-0000-0000-000000000001';
  const callId = '00000000-0000-0000-0000-000000000002';
  const partyId = '00000000-0000-0000-0000-000000000003';
  const tasks = [
    { title: 'Read the sample lease', label: 'Example Dental', path: `/deals?deal=${dealId}&focus=next-step${enabled ? '&step=00000000-0000-0000-0000-000000000010' : ''}`, dealId },
    { title: 'Send the sample floor plan', label: 'Call summary', path: `/calls?session=${callId}`, dealId, call: true },
    { title: 'Check in about the sample site', label: 'Example Contact',
      path: enabled ? `/deals?prospect=${partyId}&focus=follow-up` : `/relationships?node=party:${partyId}` },
  ];
  const records = () => ({
    ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true,
    ...(enabled ? { home_proposal_drop: true, home_mark_drop: true } : { auto_settle_enabled: true }),
    items: tasks.map((task, index) => {
      const id = `00000000-0000-0000-0000-00000000001${index}`;
      const source = task.call ? 'capture_post_call_action' : 'next_action';
      return {
        item_id: `${source}:${id}`, source_type: source, source_id: id, source_version: enabled ? '2147483648' : '7',
        source_state: 'needs_attention', base_version: enabled ? '2147483648:0:inbox' : 'legacy:7', title: index === 0 ? `**${task.title}**` : task.title,
        activity_at: '2026-11-02T12:00:00.000Z', completed_at: null, due_on: '2026-11-03',
        hold_until: null, snoozed_until: null, disposition: 'inbox', section: 'inbox', unseen: false,
        ...(!enabled && { explicit_unsettle: false, auto_settled: false }), context_label: task.call ? 'Example Dental' : task.label,
        open_url: task.path, kind_label: task.call ? 'Call follow-up' : 'Task', action_id: id, action_version: enabled ? 2147483648 : 7,
        deal_id: task.dealId ?? null, merged_source_ids: [id], waiting_version: 0, waiting_on: null,
        source_activity: task.call ? { kind: 'call', id: callId, happened_at: '2026-11-03T02:00:00.000Z',
          contact: 'Example Contact', summary: 'Discussed plans &amp; schedules.', quote: 'Send the plan <today> to R&D.' } : null,
      };
    }),
  });
  const state = records();
  if (enabled) state.items.push({
    ...state.items[0], item_id: `notification:${partyId}`, source_type: 'notification', source_id: partyId,
    action_id: null, action_version: null, due_on: null, kind_label: 'Update', title: 'The sample deal moved ahead',
  });
  if (enabled) {
    const id = '00000000-0000-0000-0000-000000000013';
    state.items.push({
      ...state.items[0], item_id: `next_action:${id}`, source_id: id, action_id: id, merged_source_ids: [id],
      title: 'Wait for sample terms', section: 'held', hold_until: '2026-11-05T06:00:00Z', due_on: null,
    });
  }
  const details = new Map();
  let mailRows = [], moreMail = false;
  const proposalRefusals = new Map();
  const snapshot = reader => ({ ...state, items: state.items.map(item => ({
    ...item, title: `${item.title} (${reader})`,
    ...(item.completion_review && item.disposition === 'inbox' && { title: 'Did this happen? Review the sample site', source_type: 'notification', action_id: null }),
  })) });
  const reads = [];
  const writes = [];
  let conflict = false;
  function mark({ item_id, action, until }, reader) {
    const item = state.items.find(item => item.item_id === item_id);
    const previous = { disposition: item.disposition === 'inbox' ? null : item.disposition, snoozed_until: item.snoozed_until };
    const disposition = action === 'snooze' ? 'snoozed' : action === 'settle' ? 'settled' : 'inbox';
    const base_version = `2147483648:${writes.length}:${disposition}`;
    Object.assign(item, { disposition, section: disposition, base_version, snoozed_until: until ?? null });
    return { ok: true, item_id, base_version, previous, item: snapshot(reader).items.find(item => item.item_id === item_id) };
  }
  const env = {
    ENGINE_ROUTING: { get: async key => key === 'home-from-engine' && enabled ? 'on' : null },
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/home/inbox') {
        reads.push('GET /api/engine/home/inbox');
        return Response.json(snapshot('new inbox'));
      }
      if (path === '/api/engine/home/mail-priorities') {
        assert.equal(new URL(request.url).search, '');
        return Response.json({ ok: true, schema_version: 'home-mail-priorities.v1', items: mailRows, more: moreMail });
      }
      const [, , , collection, id, action] = path.split('/');
      if (request.method === 'GET') return Response.json(details.get(id));
      if (collection !== 'home') {
        const args = await request.json();
        writes.push([path, args]);
        const item = state.items.find(row => [row.action_id, row.reply_draft_id, row.fallback_reply_draft?.id, row.completion_review?.proposal_id].includes(id) ||
          row.suggestions?.some(suggestion => suggestion.id === id));
        assert.ok(item);
        if (collection === 'next-steps') {
          assert.equal(args.base_version, item.action_version);
          const done = action === 'end';
          if (done) assert.equal(args.resolution, 'done');
          const change_id = ++item.action_version;
          Object.assign(item, { source_state: done ? 'done' : 'needs_attention', completed_at: done ? NOW.toISOString() : null,
            ...(item === state.items[0] && { undo_completion: done }), section: done ? 'done' : 'inbox', disposition: done ? 'settled' : 'inbox', base_version: `${change_id}:0:${done ? 'settled' : 'inbox'}` });
          return Response.json({ next_step_id: id, status: done ? 'done' : 'open', ...(done && { change_id }) });
        }
        if (collection === 'proposals') {
          if (args.decision === 'accept' && proposalRefusals.has(id)) {
            const [error, status] = proposalRefusals.get(id);
            proposalRefusals.delete(id);
            return Response.json({ error }, { status });
          }
          mailRows = mailRows.filter(row => row.proposal_id !== id);
          if (item.completion_review) delete item.completion_review;
          else {
            item.suggestions = item.suggestions.filter(row => row.id !== id);
            if (item.reply_draft_id) item.due_on = item.suggestions.map(row => details.get(row.id)?.due_on).filter(Boolean).sort()[0] ?? null;
            if (!item.suggestions.length && !item.reply_draft_id) state.items.splice(state.items.indexOf(item), 1);
          }
          return Response.json({ proposal_id: id, status: args.decision === 'accept' ? 'accepted' : 'dismissed' });
        }
        const draft = details.get(id);
        assert.equal(args.version, draft.version);
        draft.version++;
        draft.subject = args.subject ?? draft.subject;
        draft.body = args.body ?? draft.body;
        draft.status = action === 'submission' ? 'approved' : action === 'dismissal' ? 'dismissed' : 'pending';
        const receipt = { draft_id: id, version: draft.version, status: draft.status };
        if (item.fallback_reply_draft) {
          item.fallback_reply_draft = { id, version: String(draft.version), status: draft.status, failure_reason: null };
          return Response.json(receipt);
        }
        if (draft.status !== 'pending' && item.suggestions?.length) {
          const [first] = item.suggestions;
          const { reply_draft_id, reply_draft_status, ...remaining } = item;
          state.items.splice(state.items.indexOf(item), 1, { ...remaining, item_id: `suggestion:${first.id}`, source_id: first.id,
            kind_label: 'Suggestion', title: 'Remaining email suggestion', source_version: '43',
            ...(draft.status === 'approved' && { fallback_reply_draft: { id, version: String(draft.version), status: 'approved', failure_reason: null } }) });
          mailRows = mailRows.filter(row => row.reply_draft_id !== id);
          return Response.json(receipt);
        }
        if (draft.status === 'dismissed') state.items.splice(state.items.indexOf(item), 1);
        Object.assign(item, { source_version: String(draft.version), reply_draft_status: draft.status, source_state: action === 'submission' ? 'working' : 'needs_attention',
          section: action === 'submission' ? 'working' : 'inbox' });
        return Response.json(receipt);
      }
      assert.equal(path, '/api/engine/home/marks');
      const args = await request.json();
      writes.push([path, args]);
      assert.equal(args.base_version, state.items.find(item => item.item_id === args.item_id)?.base_version);
      if (args.action === 'drop') {
        assert.ok(args.reason.trim());
        state.items.splice(state.items.findIndex(item => item.item_id === args.item_id), 1);
        return Response.json({ ok: true, item_id: args.item_id });
      }
      if (conflict) {
        conflict = false;
        const item = state.items.find(item => item.item_id === args.item_id);
        item.title = 'Read the revised sample lease';
        item.base_version = '2147483649:0:inbox';
        return Response.json({ error: 'version_conflict', current_version: item.base_version }, { status: 409 });
      }
      return Response.json(mark(args, 'new inbox'));
    } },
    CARR: { fetch: async request => {
      if (request.method === 'GET') return Response.json({ error: 'not_found' }, { status: 404 });
      const { id, params: { name, arguments: args } } = await request.json();
      if (name === 'read-home-inbox-v5') reads.push(name);
      let payload = name === 'read-home-inbox-v5' ? snapshot('current inbox') : { ok: true, items: [], deals: [] };
      if (['snooze-home-inbox', 'settle-home-inbox', 'unsettle-home-inbox'].includes(name)) {
        writes.push([name, args]);
        payload = { ok: true, schema_version: 'home-inbox-command.v1',
          results: args.items.map(item => mark({ ...item, action: name.split('-')[0], until: args.until }, 'current inbox')) };
      }
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    } },
  };
  const routeWorker = async route => {
    const request = route.request();
    const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  };
  await page.route('**/mcp', routeWorker);
  await page.route('**/api/v1/intelligence/mail-needs-partner?*', routeWorker);

  if (enabled) await page.route(/\/\?mode=live$/, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('<html ', '<html data-home-today-from-engine ');
    await route.fulfill({ response, body: html });
  });
  await open(enabled ? '/?mode=live#homeEmailFollowups' : '/?mode=live');
  const reader = enabled ? 'new inbox' : 'current inbox';
  const inbox = page.getByRole('region', { name: 'Inbox cards', exact: true });
  const waiting = inbox.getByRole('region', { name: 'In motion and waiting', exact: true });
  const confirmDrop = async (reason) => {
    const dialog = page.getByRole('dialog', { name: 'Drop with a reason' });
    await dialog.getByRole('textbox', { name: 'Reason for dropping' }).fill(reason);
    await dialog.getByRole('button', { name: 'Drop', exact: true }).click();
  };
  const first = inbox.getByRole('link', { name: new RegExp(`^${tasks[0].title}`) });
  await first.waitFor();
  assert.equal(await inbox.getByText('Partner inbox', { exact: true }).count(), 0);
  assert.equal(await inbox.getByText(/Completed today in Chicago/).count(), 0);
  assert.equal(await page.locator('#appWorkingList').count(), 0);
  assert.match(await inbox.locator('footer').textContent(), enabled ? /swipe right to wake a snoozed card/ : /swipe right to hide or wake/);
  assert.equal(await first.textContent(), `${tasks[0].title} (${reader})`);
  if (enabled) {
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await inbox.getByRole('navigation', { name: 'Review workflows' }).count(), 0);
  }
  await inbox.getByRole('region', { name: 'Today', exact: true }).getByRole('button', { name: 'See all 3', exact: true }).click();
  if (enabled) {
    await waiting.getByRole('button', { name: 'See all 1', exact: true }).click();
    const held = waiting.locator('[data-inbox-row]');
    await held.getByText(/On hold until Nov 5, 2026/).waitFor();
    assert.doesNotMatch(await held.innerText(), /needs attention|Ready for your attention/i);
    assert.equal(await held.getByRole('button').count(), 0);
    assert.equal(await held.getByRole('link', { name: /^Wait for sample terms/ }).getAttribute('href'), tasks[0].path);
  }
  assert.equal(await inbox.locator('[data-inbox-row]').count(), state.items.length);
  for (const copy of ['needs attention', 'Ready for your attention']) {
    assert.equal(await inbox.getByText(copy, { exact: true }).count(), enabled ? 0 : tasks.length);
  }
  if (enabled) await waiting.getByRole('button', { name: 'Show less', exact: true }).click();
  for (const task of tasks) {
    const title = `${task.title} (${reader})`;
    const link = inbox.getByRole('link', { name: title, exact: true });
    assert.equal(await link.count(), 1);
    const card = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: title, exact: true }) });
    assert.deepEqual(await card.getByRole('button').allTextContents(), enabled
      ? ['Open', 'Mark done', 'Snooze', 'Drop']
      : ['Open', 'Mark done', 'Hide from inbox', 'Snooze']);
    assert.match(await card.locator('.inbox-context time').textContent(), /Nov 3/);
    if (enabled && !task.call) {
      assert.equal(await link.getAttribute('href'), task.path);
      continue;
    }
    if (enabled && task.call) await card.getByText('From your call with Example Contact on Mon, Nov 2').waitFor();
    await link.click();
    const details = card.getByRole('region', { name: `Details for ${title}` });
    assert.equal(await details.getByRole('link', { name: task.label, exact: true }).getAttribute('href'), task.path);
    if (enabled && task.call) {
      assert.equal(await details.getByText(/Discussed plans/).textContent(), 'Discussed plans & schedules.');
      assert.equal(await details.locator('blockquote').textContent(), 'Send the plan <today> to R&D.');
    }
    await details.getByRole('button', { name: 'Close', exact: true }).click();
  }
  assert.deepEqual(reads, [enabled ? 'GET /api/engine/home/inbox' : 'read-home-inbox-v5']);
  const today = inbox.getByRole('region', { name: 'Today', exact: true });
  const card = today.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /^Read the sample lease/ }) });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const clickSnooze = async () => {
    await card.getByRole('button', { name: 'Snooze', exact: true }).click();
    await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  };
  const original = state.items[0].base_version;
  const id = state.items[0].item_id;
  await clickSnooze();
  await card.waitFor({ state: 'detached' });
  assert.equal(writes.length, 1);
  const [door, applied] = writes[0];
  if (enabled) assert.deepEqual(applied, { item_id: id, base_version: original, action: 'snooze', until: applied.until, idempotency_key: applied.idempotency_key });
  else assert.deepEqual(applied.items, [{ item_id: id, base_version: original }]);
  assert.equal(door, enabled ? '/api/engine/home/marks' : 'snooze-home-inbox');
  if (enabled) {
    await waiting.getByRole('button', { name: 'See all 2', exact: true }).click();
    const snoozed = waiting.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /^Read the sample lease/ }) });
    await snoozed.getByText(/^Snoozed until .* Central$/).waitFor();
    assert.deepEqual(await snoozed.getByRole('button').allTextContents(), ['Wake']);
    assert.equal(await snoozed.getByRole('checkbox').isDisabled(), true);
    await waiting.getByRole('button', { name: 'Show less', exact: true }).click();
  }
  const snoozedVersion = state.items[0].base_version;
  await undo.click();
  await card.waitFor();
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1][1].idempotency_key, applied.idempotency_key);
  if (!enabled) {
    assert.equal(writes[1][0], 'unsettle-home-inbox');
    assert.deepEqual(writes[1][1].items, [{ item_id: id, base_version: snoozedVersion }]);
    return;
  }
  assert.deepEqual(writes[1][1], { item_id: id, base_version: snoozedVersion, action: 'unsnooze', idempotency_key: writes[1][1].idempotency_key });
  for (const task of tasks.slice(0, 2)) await inbox.getByRole('checkbox', { name: `Select ${task.title} (${reader})` }).check();
  const before = reads.length;
  assert.equal(await page.getByRole('button', { name: 'Settle selected', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Snooze selected', exact: true }).click();
  await page.getByRole('button', { name: /^Not now · Tomorrow/ }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.equal(reads.length, before + 1);
  assert.equal(writes.length, 4);
  assert.deepEqual(new Set(writes.slice(2).map(([, args]) => args.item_id)), new Set(state.items.slice(0, 2).map(item => item.item_id)));
  assert.equal(new Set(writes.slice(2).map(([, args]) => args.idempotency_key)).size, 2);
  await card.waitFor({ state: 'detached' });
  const batchVersions = new Map(state.items.slice(0, 2).map(item => [item.item_id, item.base_version]));
  await page.getByRole('button', { name: 'Undo whole batch' }).click();
  await page.locator('[data-batch-state="undone"]').waitFor();
  await card.waitFor();
  assert.equal(writes.length, 6);
  for (const [, args] of writes.slice(4)) {
    assert.equal(args.base_version, batchVersions.get(args.item_id));
    assert.equal(args.action, 'unsnooze');
    assert.equal('until' in args, false);
  }
  assert.equal(new Set(writes.slice(2).map(([, args]) => args.idempotency_key)).size, 4);
  await page.getByRole('button', { name: 'Finish reviewing batch' }).click();
  conflict = true;
  await clickSnooze();
  await page.getByText('This card changed. Refreshing your inbox. Your change was not saved.', { exact: true }).waitFor();
  await today.getByRole('link', { name: /Read the revised sample lease/ }).waitFor();
  assert.equal(writes.length, 7);
  const notice = { ...state.items[3] };
  const update = inbox.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row]')
    .filter({ has: page.getByRole('link', { name: /The sample deal moved ahead/ }) });
  await update.getByRole('button', { name: 'Drop', exact: true }).click();
  await confirmDrop('Already reviewed.');
  await update.waitFor({ state: 'detached' });
  assert.equal(writes[7][1].action, 'drop');
  assert.equal(writes[7][1].item_id, `notification:${partyId}`);
  assert.equal(writes[7][1].reason, 'Already reviewed.');
  assert.equal(await undo.count(), 0);

  const revised = today.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /Read the revised sample lease/ }) });
  await revised.getByRole('button', { name: 'Mark done', exact: true }).click();
  await revised.waitFor({ state: 'detached' });
  const completed = writes.at(-1);
  assert.match(completed[0], /\/next-steps\/.+\/end$/);
  assert.equal(completed[1].base_version, 2147483648);
  await page.reload();
  const completedCard = inbox.getByRole('region', { name: 'Done today', exact: true }).locator('[data-inbox-row]')
    .filter({ hasText: 'Read the revised sample lease' });
  await completedCard.getByRole('button', { name: 'Undo', exact: true }).click();
  await revised.waitFor();
  assert.match(writes.at(-1)[0], /\/reopen$/);
  assert.equal(writes.at(-1)[1].base_version, 2147483649);

  await today.getByRole('button', { name: 'See all 3', exact: true }).click();
  const prospect = today.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /Check in about the sample site/ }) });
  await prospect.getByRole('button', { name: 'Mark done', exact: true }).click();
  await prospect.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[0], '/api/engine/next-steps/00000000-0000-0000-0000-000000000012/end');
  await undo.click();
  await prospect.waitFor();

  const proposal = '00000000-0000-0000-0000-000000000020';
  const log = '00000000-0000-0000-0000-000000000021';
  const draft = '00000000-0000-0000-0000-000000000022';
  const next = '00000000-0000-0000-0000-000000000023';
  const decline = '00000000-0000-0000-0000-000000000024';
  const leading = '00000000-0000-0000-0000-000000000025';
  const phase = '00000000-0000-0000-0000-000000000026';
  const nested = '00000000-0000-0000-0000-000000000027';
  const remaining = '00000000-0000-0000-0000-000000000028';
  const dismissNested = '00000000-0000-0000-0000-000000000029';
  const otherEmail = '00000000-0000-0000-0000-000000000031';
  const evidence = { evidence: 'Discussed next steps.', source_activity: { kind: 'call', summary: 'The sample call summary.', happened_at: NOW.toISOString() } };
  state.items[2].completion_review = { proposal_id: proposal, can_resolve: false };
  details.set(proposal, { ...evidence, proposal_id: proposal, kind: 'next_step_done' });
  state.items.push(
    { ...notice, title: 'Call suggestions', item_id: `suggestion:${log}`, source_id: log, source_type: 'capture_session',
      deal_id: null, kind_label: 'Call', suggestions: [{ id: log }, { id: phase }] },
    { ...notice, title: 'Sample Sender · Floor plan', item_id: `suggestion:${otherEmail}`, source_id: otherEmail, source_type: 'email_proposal',
      deal_id: null, kind_label: 'Suggestion', suggestions: [{ id: otherEmail }],
      source_activity: { kind: 'email', id: otherEmail, happened_at: '2026-11-03T03:30:00Z' } },
    { ...notice, title: 'Sample Sender · Floor plan', item_id: `suggestion:${leading}`, source_id: leading, source_type: 'email_proposal',
      deal_id: null, kind_label: 'Suggestion', due_on: '2026-11-01', suggestions: [{ id: leading }, { id: next }],
      source_activity: { kind: 'email', id: log, happened_at: '2026-11-01T16:00:00Z' } },
    { ...notice, title: 'Reply to the sample email', item_id: `reply_draft:${draft}`, source_id: draft, source_type: 'email_proposal',
      deal_id: null, due_on: '2026-11-01', kind_label: 'Reply draft', source_version: '1', reply_draft_id: draft, reply_draft_status: 'pending',
      suggestions: [{ id: nested }, { id: dismissNested }, { id: remaining }] },
  );
  details.set(log, { ...evidence, proposal_id: log, kind: 'log_call', target_name: 'Example Dental', what: 'Log the sample call' });
  details.set(next, { ...evidence, proposal_id: next, kind: 'next_step', what: 'Share the plan', due_on: '2026-11-04' });
  details.set(phase, { ...evidence, proposal_id: phase, kind: 'phase_move', to_phase: 'legal' });
  details.set(leading, { ...evidence, proposal_id: leading, kind: 'possible_new_deal', source_activity: {
    kind: 'email', body: '&amp;lt; is a literal reference. Our R&D team said &lt;strong&gt;Ready&#33;&lt;/strong&gt;',
  } });
  details.set(nested, { ...evidence, proposal_id: nested, kind: 'next_step', what: 'Share the sample plan', due_on: '2026-11-04' });
  details.set(remaining, { ...evidence, proposal_id: remaining, kind: 'possible_new_deal' });
  details.set(dismissNested, { ...evidence, proposal_id: dismissNested, kind: 'file_to_deal' });
  details.set(draft, { draft_id: draft, version: 1, status: 'pending', subject: 'Sample reply', body: 'First draft.',
    to: 'sender@example.test', cc: 'partner@example.test', attachments: [{ document_id: dealId, name: 'Sample plan' }],
    source_activity: { sender: 'sender@example.test', subject: 'Sample email',
      body: '&#65279;Tom &amp; Pat&#39;s &lt;sample&gt;&nbsp;plan.', happened_at: NOW.toISOString() } });
  const lead = '00000000-0000-0000-0000-000000000030';
  state.items.push({ ...notice, title: 'New Example · Possible lead', item_id: `suggestion:${lead}`, source_id: lead,
    source_type: 'email_proposal', deal_id: null, open_url: null, source_activity: null,
    suggestions: [{ id: lead, kind: 'email_lead', candidate_id: partyId, activity_id: null }] });
  details.set(lead, { proposal_id: lead, kind: 'email_lead', target_name: 'New Example',
    evidence: 'Asked about leasing a suite.', evidence_quote: 'I am looking to lease a suite.',
    source_activity: { kind: 'email', id: null, sender: 'new@example.test', sender_name: 'New Example',
      happened_at: '2026-01-08T12:00:00Z', subject: null, body: null, summary: null } });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const cardFor = name => inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name }) });
  await inbox.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('button', { name: /^See all/ }).click();
  const leadCard = inbox.locator(`[data-inbox-row="suggestion:${lead}"]`);
  await leadCard.getByRole('button', { name: 'Open', exact: true }).click();
  await leadCard.getByRole('heading', { name: 'Possible lead · New Example' }).waitFor();
  await leadCard.getByText('Asked about leasing a suite.', { exact: true }).waitFor();
  await leadCard.getByText('I am looking to lease a suite.', { exact: true }).waitFor();
  await leadCard.getByText(/new@example.test/).waitFor();
  await leadCard.getByText(/Jan 8, 2026/).waitFor();
  const leadReview = leadCard.getByRole('region', { name: /Details for New Example/ });
  assert.equal(await leadReview.getByRole('button', { name: 'Accept', exact: true }).count(), 1);
  assert.equal(await leadReview.getByRole('button', { name: 'Drop', exact: true }).count(), 1);
  await leadReview.getByRole('button', { name: 'Accept', exact: true }).click();
  await leadCard.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[1].decision, 'accept');
  const review = cardFor(/Did this happen\? Review the sample site/);
  await review.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  await review.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[1].item_id, state.items[2].item_id);
  await undo.click();
  await review.getByRole('button', { name: 'Open', exact: true }).click();
  await review.getByText('Discussed next steps.', { exact: true }).waitFor();
  await review.getByText(/From your call on/).waitFor();
  await review.getByText('Words that prompted this suggestion', { exact: true }).waitFor();
  await review.getByText(/This step changed after the suggestion/).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Yes, it’s done' }).isDisabled(), true);
  await review.getByRole('button', { name: 'Not yet', exact: true }).click();
  await review.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[1].decision, 'dismiss');
  const suggestions = cardFor(/Call suggestions/);
  const reply = cardFor(/Reply to the sample email/);
  for (const [row, id] of [[suggestions, `suggestion:${log}`], [reply, `reply_draft:${draft}`]]) {
    const base_version = state.items.find(card => card.item_id === id).base_version;
    await row.getByRole('button', { name: 'Snooze', exact: true }).click();
    await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
    await row.waitFor({ state: 'detached' });
    assert.equal(writes.at(-1)[1].item_id, id);
    assert.equal(writes.at(-1)[1].base_version, base_version);
    if (id === log) {
      await waiting.getByRole('button', { name: 'See all 2', exact: true }).click();
      await row.getByRole('link', { name: /^Call suggestions/ }).click();
      await row.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
      assert.equal(await row.getByRole('button', { name: /^(Accept|Drop)$/ }).count(), 0);
      await row.getByRole('button', { name: 'Close review' }).click();
      await waiting.getByRole('button', { name: 'Show less', exact: true }).click();
    }
    await undo.click();
    await row.waitFor();
  }
  const writesBeforeReview = writes.length;
  await suggestions.getByRole('button', { name: 'Review suggestions', exact: true }).click();
  await suggestions.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  await reply.getByRole('region', { name: 'Their email', exact: true }).waitFor();
  assert.equal(await suggestions.getByRole('region', { name: /Details for Call suggestions/ }).count(), 0);
  await reply.getByRole('textbox', { name: 'Subject', exact: true }).fill('Revised sample reply');
  await reply.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited reply.');
  await suggestions.getByRole('button', { name: 'Open', exact: true }).click();
  await suggestions.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await reply.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), 'Revised sample reply');
  assert.equal(await reply.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Edited reply.');
  assert.equal(writes.length, writesBeforeReview);
  await suggestions.getByRole('button', { name: 'Open', exact: true }).click();
  await suggestions.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
  await suggestions.getByRole('button', { name: 'Accept', exact: true }).first().click();
  await suggestions.getByRole('button', { name: 'Open', exact: true }).click();
  assert.equal(writes.at(-1)[1].decision, 'accept');
  proposalRefusals.set(phase, ['version_conflict', 409]);
  await suggestions.getByRole('button', { name: 'Accept', exact: true }).click();
  await suggestions.getByRole('alert').filter({ hasText: /This deal has moved since the suggestion/ }).waitFor();
  assert.equal(await suggestions.getByRole('button', { name: 'Review updated card' }).count(), 0);
  await suggestions.getByRole('region', { name: /Details for Call suggestions/ }).getByRole('button', { name: 'Drop', exact: true }).click();
  await confirmDrop('The deal already moved.');
  await suggestions.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[1].decision, 'dismiss');
  const priority = { item_id: `suggestion:${leading}`, base_version: notice.base_version, conversation_id: 'sample-conversation',
    kind: 'next_step', proposal_id: next, reply_draft_id: null, sender: 'Sample Sender', subject: 'No subject', suggestion: 'Share the plan (no subject)',
    due_on: '2026-11-04', source_activity: { kind: 'email', id: log, happened_at: NOW.toISOString() } };
  const mail = page.getByRole('region', { name: 'Mail priorities', exact: true });
  mailRows = [{ ...priority, kind: 'reply_draft', item_id: `reply_draft:${draft}` }];
  await mail.getByRole('button', { name: 'Refresh mail priorities', exact: true }).click();
  await mail.getByText('Mail priorities unavailable.', { exact: true }).waitFor();
  const email = inbox.locator(`[data-inbox-row="suggestion:${leading}"]`);
  const sameSubject = inbox.locator(`[data-inbox-row="suggestion:${otherEmail}"]`);
  const subjectLinks = inbox.getByRole('link', { name: /Sample Sender · Floor plan/ });
  assert.equal(await subjectLinks.count(), 2);
  await sameSubject.getByText(/Nov 2, 2026, 9:30 PM/).waitFor();
  await email.getByText(/Nov 1, 2026, 10:00 AM/).waitFor();
  assert.equal(await subjectLinks.first().locator('xpath=ancestor::article').getAttribute('data-inbox-row'), `suggestion:${otherEmail}`);
  const refreshMail = mail.getByRole('button', { name: 'Refresh mail priorities', exact: true });
  mailRows = [{ ...priority, subject: 'Floor plan', base_version: 'stale' }];
  await refreshMail.click();
  await mail.getByText('No mail priorities right now.', { exact: true }).waitFor();
  assert.equal(await subjectLinks.first().locator('xpath=ancestor::article').getAttribute('data-inbox-row'), `suggestion:${otherEmail}`);
  mailRows = [{ ...priority, subject: 'Floor plan' }];
  moreMail = true;
  await refreshMail.click();
  await mail.getByText('More conversations are in your inbox.', { exact: true }).waitFor();
  assert.equal(await mail.getByText(/Sample Sender|Floor plan|Share the plan/).count(), 0);
  assert.equal(await subjectLinks.first().locator('xpath=ancestor::article').getAttribute('data-inbox-row'), `suggestion:${leading}`);
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  await email.getByRole('link', { name: /Sample Sender · Floor plan/ }).press('Enter');
  assert.equal(await reply.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  await email.getByText('Suggestion', { exact: true }).waitFor();
  await email.getByText(/2 days late/).waitFor();
  assert.equal(await email.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
  const possibleDeal = email.getByRole('region', { name: 'Possible new deal', exact: true });
  await possibleDeal.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  const suggestionExcerpt = possibleDeal.locator('blockquote').filter({ hasText: 'is a literal reference' });
  assert.equal(await suggestionExcerpt.textContent(), '&lt; is a literal reference. Our R&D team said <strong>Ready!</strong>');
  assert.equal(await suggestionExcerpt.locator('strong').count(), 0);
  await possibleDeal.getByRole('button', { name: 'Drop', exact: true }).waitFor();
  const step = email.getByRole('region', { name: 'Next step', exact: true });
  for (const [error, status, message] of [
    ['open_step_exists', 409, /You already have an open step for this client or deal/],
    ['invalid_field_value', 422, /This suggestion could not be saved/],
  ]) {
    proposalRefusals.set(next, [error, status]);
    await step.getByRole('button', { name: 'Accept', exact: true }).click();
    await email.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(await email.getByRole('button', { name: 'Retry same review request' }).count(), 0);
    await page.keyboard.press('Escape');
    await email.getByRole('button', { name: 'Open', exact: true }).click();
  }
  await step.getByRole('textbox', { name: 'Next step', exact: true }).fill('Share the revised plan');
  await step.getByRole('button', { name: 'Accept', exact: true }).click();
  await email.getByRole('textbox', { name: 'Next step', exact: true }).waitFor({ state: 'detached' });
  assert.ok(writes.at(-1)[0].includes(next));
  assert.deepEqual(writes.at(-1)[1].edits, { what: 'Share the revised plan', due_on: '2026-11-04' });
  mailRows = [{ ...priority, conversation_id: 'sample-draft-conversation', item_id: `reply_draft:${draft}`,
    base_version: state.items.find(row => row.reply_draft_id === draft).base_version,
    kind: 'reply_draft', proposal_id: null, reply_draft_id: draft, subject: 'Sample draft message' }];
  await reply.getByText(/2 days late/).waitFor();
  await refreshMail.click();
  await mail.getByText('No mail priorities right now.', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await mail.getByText('Sample draft message', { exact: true }).count(), 0);
  await reply.getByRole('button', { name: 'Open', exact: true }).click();
  const replyExcerpt = reply.getByRole('region', { name: 'Their email', exact: true }).locator('blockquote');
  await replyExcerpt.waitFor();
  assert.equal(await replyExcerpt.textContent(), "Tom & Pat's <sample>\u00a0plan.");
  await reply.getByRole('link', { name: 'Sample plan', exact: true }).waitFor();
  assert.equal(await cardFor(/Remaining email suggestion/).count(), 0);
  await reply.getByRole('button', { name: 'Accept', exact: true }).first().click();
  await reply.getByText('Suggestion accepted.', { exact: true }).waitFor();
  assert.match(writes.at(-1)[0], new RegExp(`/proposals/${nested}/decision$`));
  await reply.getByRole('region', { name: 'File this email', exact: true }).getByRole('button', { name: 'Drop', exact: true }).click();
  await confirmDrop('Already filed.');
  await reply.getByText('Suggestion dismissed.', { exact: true }).waitFor();
  assert.match(writes.at(-1)[0], new RegExp(`/proposals/${dismissNested}/decision$`));
  assert.equal(writes.at(-1)[1].decision, 'dismiss');
  assert.equal(writes.at(-1)[1].reason, 'Already filed.');
  assert.equal(await reply.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Edited reply.');
  await reply.getByRole('button', { name: 'Save draft', exact: true }).click();
  await reply.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 1, subject: 'Revised sample reply', body: 'Edited reply.' });
  const draftCard = state.items.find(row => row.reply_draft_id === draft);
  const draftRecord = details.get(draft);
  await reply.getByRole('button', { name: 'Close review' }).click();
  Object.assign(draftRecord, { version: 3, body: 'Saved again from another tab.' });
  Object.assign(draftCard, { source_version: '3', title: 'Reply to the sample email (updated)' });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await reply.getByRole('link', { name: `Reply to the sample email (updated) (${reader})`, exact: true }).waitFor();
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  const message = reply.getByRole('textbox', { name: 'Message', exact: true });
  assert.equal(await message.inputValue(), 'Saved again from another tab.');
  await message.fill('Final edited reply.');
  await email.getByRole('button', { name: 'Open', exact: true }).click();
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  await reply.getByRole('button', { name: 'Send reply', exact: true }).click();
  const fallback = cardFor(/Remaining email suggestion/);
  await fallback.getByText('Sending', { exact: true }).waitFor();
  assert.equal(await reply.count(), 0);
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 3, subject: 'Revised sample reply',
    body: 'Final edited reply.', to: 'sender@example.test', cc: 'partner@example.test', document_ids: [dealId] });
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('status').filter({ hasText: 'Sending' }).waitFor();
  assert.equal(await fallback.getByRole('button', { name: 'Accept', exact: true }).isEnabled(), true);
  assert.equal(await fallback.getByRole('button', { name: 'Send reply', exact: true }).count(), 0);
  await fallback.getByRole('button', { name: 'Close review' }).click();
  const fallbackCard = state.items.find(row => row.item_id === `suggestion:${remaining}`);
  Object.assign(draftRecord, { status: 'failed', failure_reason: 'submission_recipients_invalid' });
  Object.assign(fallbackCard.fallback_reply_draft, { status: 'failed', failure_reason: draftRecord.failure_reason });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await fallback.getByText(/^Didn't send/).waitFor();
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('status').filter({ hasText: /^Didn't send/ }).waitFor();
  await fallback.getByRole('status').filter({ hasText: /Reply from Outlook/ }).waitFor();
  assert.equal(await fallback.getByText(/Check the recipients|Save draft keeps your edits/).count(), 0);
  assert.equal(await fallback.getByRole('textbox', { name: 'Reason for declining' }).count(), 0);
  assert.equal(await fallback.getByRole('button', { name: 'Send reply', exact: true }).count(), 0);
  await fallback.getByRole('button', { name: 'Close review' }).click();
  draftRecord.failure_reason = 'aborted_before_dispatch';
  fallbackCard.fallback_reply_draft.failure_reason = draftRecord.failure_reason;
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await fallback.getByText(/Sending stopped before delivery/).waitFor();
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  await fallback.getByRole('button', { name: 'Open', exact: true }).waitFor();
  assert.equal(writes.at(-1)[1].version, 4);
  details.set(decline, { ...details.get(draft), draft_id: decline, version: 1, status: 'pending' });
  state.items.push({ ...notice, title: 'Another sample draft', item_id: `reply_draft:${decline}`, source_id: decline,
    source_type: 'email_proposal', deal_id: null, kind_label: 'Reply draft', source_version: '1', reply_draft_id: decline, reply_draft_status: 'pending' });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const declined = cardFor(/Another sample draft/);
  await declined.getByRole('button', { name: 'Open', exact: true }).click();
  const declinedMessage = declined.getByRole('textbox', { name: 'Message', exact: true });
  assert.equal(await declinedMessage.inputValue(), 'Final edited reply.');
  await declinedMessage.fill('Unsaved text to drop.');
  await declined.getByRole('region', { name: /Details for Another sample draft/ }).getByRole('button', { name: 'Drop', exact: true }).click();
  await confirmDrop('Already answered.');
  await declined.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 1, reason: 'Already answered.' });
  delete fallbackCard.fallback_reply_draft;
  state.items.push({ ...draftCard, section: 'done', disposition: 'inbox', suggestions: [],
    source_state: 'done', source_version: String(draftRecord.version), reply_draft_status: 'sent', completed_at: NOW.toISOString() });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const sent = inbox.getByRole('region', { name: 'Done today', exact: true });
  await sent.getByText(/^Sent /).waitFor();
  assert.equal(await sent.getByRole('button', { name: /Snooze|Undo/ }).count(), 0);

  const lease = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /Read the revised sample lease/ }) });
  await lease.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  await waiting.getByRole('button', { name: /^See all/ }).click();
  const earlierUntil = writes.at(-1)[1].until;
  async function undoRestore(label, action, until, advanceClock = false) {
    await lease.getByRole('button', { name: label, exact: true }).click();
    await today.getByRole('link', { name: /Read the revised sample lease/ }).waitFor();
    const version = state.items[0].base_version;
    const key = writes.at(-1)[1].idempotency_key;
    if (advanceClock) await page.clock.setFixedTime(new Date(Date.parse(earlierUntil) + 60_000));
    await undo.click();
    await page.getByText(/1 confirmed\. Undone\./).waitFor();
    const restored = writes.at(-1)[1];
    assert.deepEqual(restored, { item_id: id, base_version: version, action, idempotency_key: restored.idempotency_key,
      ...(until && { until }) });
    assert.notEqual(restored.idempotency_key, key);
  }
  await undoRestore('Wake', 'snooze', earlierUntil);
  await undoRestore('Wake', 'unsnooze', undefined, true);
  assert.equal(await lease.getByRole('button', { name: 'Hide from inbox', exact: true }).count(), 0);
  await lease.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/deals' && url.searchParams.get('step') === state.items[0].action_id);
});


for (const width of [390, 1440]) test(`Home opens the exact prospect and Relationships steps with their origin at ${width}px`, async t => {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  page.setDefaultTimeout(5000);
  const prospect = '00000000-0000-4000-8000-000000000031';
  const person = '00000000-0000-4000-8000-000000000032';
  const prospectStep = '00000000-0000-4000-8000-000000000033';
  const relationshipStep = '00000000-0000-4000-8000-000000000034';
  const otherStep = '00000000-0000-4000-8000-000000000035';
  const completedStep = '00000000-0000-4000-8000-000000000036';
  const tasks = [
    [prospectStep, 'Ask about the site', `/deals?prospect=${prospect}&focus=follow-up&step=${prospectStep}&mode=live`],
    [relationshipStep, 'Send the floor plan', `/relationships?node=party:${person}&step=${relationshipStep}&mode=live`],
    [completedStep, 'Confirm the tour', `/deals?prospect=${prospect}&focus=follow-up&step=${completedStep}&mode=live`],
  ];
  const at = NOW.toISOString();
  const inbox = {
    ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, engine_marks: true,
    working_collapsed: true, home_mark_drop: true,
    items: tasks.map(([id, title, open_url]) => ({
      item_id: `next_action:${id}`, source_id: id, source_type: 'next_action', source_version: '3',
      source_state: id === completedStep ? 'done' : 'needs_attention', activity_at: at,
      completed_at: id === completedStep ? at : null, due_on: '2026-11-03',
      hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, section: id === completedStep ? 'done' : 'inbox',
      base_version: '3:0:inbox', waiting_version: 0, waiting_on: null, context_label: 'Example contact', title, open_url, kind_label: 'Task',
      merged_source_ids: [id], action_id: id, action_version: 3, deal_id: null,
    })),
  };
  const origin = { set_by: 'Example Partner', set_at: at };
  const prospectRow = { party_id: prospect, name: 'Example Practice', how_found: 'referral',
    owner: 'joe', needs_attention: false, latest_note: null, change_id: 1, notes: [],
    follow_ups: [
      { next_step_id: otherStep, owner: 'dell', what: 'Older step with no recorded origin',
        due_on: '2026-11-01', change_id: 2, set_at: at, set_by: null, set_from: null },
      { next_step_id: prospectStep, owner: 'joe', what: tasks[0][1],
        due_on: '2026-11-03', change_id: 3, ...origin, set_from: 'email' },
    ],
  };
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    const board = { schema_version: 'local-deals-board.v2', actor: 'joe', deals: [], board_from_engine: true, engine_prospects: true, next_deal_saves: true };
    const value = params.name === 'read-home-inbox-v5' ? inbox : params.name === 'deal-room-board' ? board : { items: [] };
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.route('**/api/engine/prospects**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith(prospect)) return route.fulfill({ json: { prospects: [prospectRow], count: 1 } });
    const completed = url.searchParams.get('step') === completedStep;
    return route.fulfill({ json: { ...prospectRow, ...(completed && { completed_follow_up: {
      next_step_id: completedStep, owner: 'joe', what: tasks[2][1],
      due_on: '2026-11-03', change_id: 4, ...origin, set_from: 'email',
    } }) } });
  });
  let olderEngine = false;
  await page.route('**/api/v1/business/relationships?*', route => {
    const step = new URL(route.request().url()).searchParams.get('step');
    if (olderEngine && step) return route.fulfill({ status: 400, json: { error: 'QUERY_INVALID' } });
    return route.fulfill({ json: { schema: 'carr-relationship-network.v1',
      observed_at: at, valid_until: new Date(NOW.getTime() + 120_000).toISOString(),
      nodes: [{ id: `party:${person}`, kind: 'contact', name: 'Example Contact', verticals: [] }],
      referrals: [], edges: [], suggestions: [],
      ...(step === relationshipStep && { focused_step: { id: step, party_id: person, what: tasks[1][1], status: 'open', ...origin, set_from: 'meeting' } }),
    } });
  });

  for (const [id, title] of tasks) {
    const isProspect = id !== relationshipStep;
    await open('/?mode=live');
    if (!isProspect) {
      const today = page.getByRole('region', { name: 'Today', exact: true });
      await today.getByRole('button', { name: 'See all 2' }).click();
    }
    await page.getByRole('link', { name: title, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: isProspect ? 'Example Practice' : 'Example Contact' });
    const step = dialog.locator(':focus');
    await step.getByText(/Set by Example Partner · Nov 3.*10:00 AM CST · From an? (email|meeting)/).waitFor();
    assert.match(await step.innerText(), new RegExp(title));
    assert.match(await step.innerText(), isProspect ? /From an email/ : /From a meeting/);
    if (id === completedStep) assert.match(await step.innerText(), /Done/);
    const box = await step.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 900);
    if (isProspect) {
      const unknown = dialog.getByRole('listitem').filter({ hasText: 'Older step with no recorded origin' });
      assert.doesNotMatch(await unknown.innerText(), /Set |From /);
    }
  }
  olderEngine = true;
  await open(tasks[1][2]);
  const contact = page.getByRole('dialog', { name: 'Example Contact' });
  await contact.waitFor();
  assert.equal(await contact.getByText(tasks[1][1], { exact: true }).count(), 0);
  assert.equal(await page.getByText('Connections temporarily unavailable').isVisible(), false);
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
