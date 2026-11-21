import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { mkdir, rm } from 'node:fs/promises';
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
      path: `/relationships?node=party:${partyId}` },
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

  await page.route('**/api/engine/home/inbox?view=dashboard', route => route.fulfill({ status: 404 }));
  if (enabled) await page.route(/\/\?mode=live$/, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('<html ', '<html data-home-today-from-engine ');
    await route.fulfill({ response, body: html });
  });
  await page.clock.install({ time: NOW });
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
  assert.equal(await first.textContent(), `${tasks[0].title} (${reader})`);
  if (enabled) {
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await inbox.getByRole('navigation', { name: 'Review workflows' }).count(), 0);
  }
  if (enabled) await inbox.getByRole('region', { name: 'Reminders', exact: true }).getByRole('button', { name: 'See all 4', exact: true }).click();
  if (enabled) {
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
  for (const task of tasks) {
    const title = `${task.title} (${reader})`;
    const link = inbox.getByRole('link', { name: title, exact: true });
    assert.equal(await link.count(), 1);
    const card = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: title, exact: true }) });
    assert.deepEqual(await card.getByRole('button').allTextContents(), enabled
      ? ['Open', 'Mark done', 'Snooze', 'Drop']
      : ['Open', 'Mark done', 'Snooze']);
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
  const today = inbox.getByRole('region', { name: 'Reminders', exact: true });
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
    const snoozed = waiting.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /^Read the sample lease/ }) });
    await snoozed.getByText(/^Snoozed until .* Central$/).waitFor();
    assert.deepEqual(await snoozed.getByRole('button').allTextContents(), ['Wake']);
    assert.equal(await snoozed.getByRole('checkbox').isDisabled(), true);
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
  const update = inbox.getByRole('region', { name: 'Reminders', exact: true }).locator('[data-inbox-row]')
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
  await undo.click();
  await revised.waitFor();
  assert.match(writes.at(-1)[0], /\/reopen$/);
  assert.equal(writes.at(-1)[1].base_version, 2147483649);

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
  await page.clock.fastForward(60_000);
  const cardFor = name => inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name }) });
  const seeAll = today.getByRole('button', { name: /^See all/ });
  if (await seeAll.isVisible()) await seeAll.click();
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
    await today.locator(`[data-inbox-row="${id}"]`).waitFor({ state: 'detached' });
    assert.equal(writes.at(-1)[1].item_id, id);
    assert.equal(writes.at(-1)[1].base_version, base_version);
    if (id === log) {
      await row.getByRole('link', { name: /^Call suggestions/ }).click();
      await row.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
      assert.equal(await row.getByRole('button', { name: /^(Accept|Drop)$/ }).count(), 0);
      await row.getByRole('button', { name: 'Close review' }).click();
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
  const email = inbox.locator(`[data-inbox-row="suggestion:${leading}"]`);
  const sameSubject = inbox.locator(`[data-inbox-row="suggestion:${otherEmail}"]`);
  const subjectLinks = inbox.getByRole('link', { name: /Sample Sender · Floor plan/ });
  assert.equal(await subjectLinks.count(), 2);
  await sameSubject.getByText(/Nov 2, 2026, 9:30 PM/).waitFor();
  await email.getByText(/Nov 1, 2026, 10:00 AM/).waitFor();
  assert.equal(await subjectLinks.first().locator('xpath=ancestor::article').getAttribute('data-inbox-row'), `suggestion:${otherEmail}`);
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  await email.getByRole('link', { name: /Sample Sender · Floor plan/ }).press('Enter');
  assert.equal(await reply.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  await email.getByText('Suggestion', { exact: true }).waitFor();
  assert.equal(await email.getByText(/days late/).count(), 0);
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
  assert.equal(await reply.getByText(/days late/).count(), 0);
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
  await page.clock.fastForward(60_000);
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
  await page.clock.fastForward(60_000);
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
  await page.clock.fastForward(60_000);
  await fallback.getByText(/Sending stopped before delivery/).waitFor();
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  await fallback.getByRole('button', { name: 'Open', exact: true }).waitFor();
  assert.equal(writes.at(-1)[1].version, 4);
  details.set(decline, { ...details.get(draft), draft_id: decline, version: 1, status: 'pending' });
  state.items.push({ ...notice, title: 'Another sample draft', item_id: `reply_draft:${decline}`, source_id: decline,
    source_type: 'email_proposal', deal_id: null, kind_label: 'Reply draft', source_version: '1', reply_draft_id: decline, reply_draft_status: 'pending' });
  await page.clock.fastForward(60_000);
  const declined = cardFor(/Another sample draft/);
  await declined.getByRole('button', { name: 'Open', exact: true }).click();
  const declinedMessage = declined.getByRole('textbox', { name: 'Message', exact: true });
  assert.equal(await declinedMessage.inputValue(), 'Final edited reply.');
  await declinedMessage.fill('Unsaved text to drop.');
  await declined.getByRole('region', { name: /Details for Another sample draft/ }).getByRole('button', { name: 'Drop', exact: true }).click();
  await confirmDrop('Already answered.');
  await declined.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 1, reason: 'Already answered.' });
  const lease = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /Read the revised sample lease/ }) });
  await lease.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
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

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`engine card copy and actions ${width} ${theme}`, async t => {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));

  await page.route(url => url.pathname === '/deals' && !url.searchParams.has('mode'), route => {
    const url = new URL(route.request().url());
    url.searchParams.set('mode', 'live');
    return route.fulfill({ status: 302, headers: { location: url.href } });
  });

  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const deal = id(1), step = id(2), checklist = id(3), otherStep = id(4), reviewStep = id(5), property = id(14);
  await page.route('**/api/tours/property-evidence/v1?*', route => {
    const selected = new URL(route.request().url()).searchParams.get('property_id');
    return route.fulfill({ json: { data: { schema: 'tour-property-evidence.v1', property_id: selected,
      facts: { site_address: { status: 'reviewed', value: selected === property ? '100 Cedar Suite' : '200 Other Suite' } },
    } } });
  });
  const dealUrl = `/deals?deal=${deal}`;
  const stepUrl = id => `${dealUrl}&focus=next-step&step=${id}`;
  const row = (number, source_type, title, why, primary_action, fields = {}) => ({
    item_id: `${source_type}:${id(number)}`, source_type, source_id: id(number), source_version: '1',
    source_state: 'needs_attention', base_version: '1:0:inbox', title, why, primary_action,
    activity_at: NOW.toISOString(), completed_at: null, due_on: null, hold_until: null, snoozed_until: null,
    disposition: 'inbox', section: 'inbox', unseen: false, context_label: 'Example Dental', open_url: dealUrl,
    kind_label: 'Task', action_id: null, action_version: null, deal_id: deal, merged_source_ids: [id(number)],
    waiting_version: 0, waiting_on: null, ...fields,
  });
  const completed = { source_state: 'done', section: 'done', completed_at: NOW.toISOString() };
  const task = row(2, 'next_action', 'Follow-up due for Example Dental — send the lease', 'Pat requested the lease at the tour.', 'Mark done',
    { action_id: step, action_version: 1, open_url: stepUrl(step), due_on: '2026-11-02' });
  const followUp = row(19, 'capture_post_call_action', 'Call with Pat Example left a follow-up — call Pat back',
    'Pat asked for a callback.', 'Mark done', { kind_label: 'Call follow-up', action_id: id(19), action_version: 1,
      open_url: `/calls?session=${id(12)}`, source_activity: { kind: 'call', happened_at: NOW.toISOString(), contact: 'Pat Example' } });
  const completion = row(5, 'notification', 'A call may confirm a step for Example Dental — check whether the plan was sent',
    'The call mentions that the plan was sent.', 'Review completion',
    { open_url: stepUrl(reviewStep), completion_review: { proposal_id: id(8), next_step_id: reviewStep, can_resolve: true } });
  const activity = { kind: 'meeting', id: id(9), happened_at: '2026-11-03T02:00:00Z', summary: 'The practice asked for a floor plan.' };
  const meeting = row(6, 'notification', 'Meeting about Example Dental left a decision — review suggestions', 'The practice asked for a floor plan.',
    'Review suggestions', { item_id: `suggestion:${id(6)}`, kind_label: 'Suggestion', deal_id: null, suggestions: [{ id: id(10) }], source_activity: activity });
  const call = row(11, 'capture_session', 'Call with Pat Example left a decision — review suggestions', 'Pat asked for a callback.',
    'Review suggestions', { item_id: `suggestion:${id(11)}`, kind_label: 'Call', deal_id: null, open_url: `/calls?session=${id(12)}`,
      suggestions: [{ id: id(13) }], source_activity: { ...activity, kind: 'call', id: id(12) } });
  const reminder = row(3, 'notification', 'Checklist item due for Example Dental — review lease clauses', 'The lease checklist is due today.',
    'Open checklist item', { kind_label: 'Update', checklist_item_ref: `deal-item:${checklist}` });
  const requirement = row(18, 'notification', 'Checklist item due for Example Dental — read attorney comments',
    'The attorney comments are ready.', 'Open checklist item', { kind_label: 'Update', checklist_item_ref: 'attorney_comments' });
  const feedback = row(7, 'notification', 'Tour feedback on Cedar Suite — review feedback', 'The exam rooms are bright. Recorded Nov 3, 2026.',
    'Review feedback', { kind: 'tour_feedback', kind_label: 'Tour feedback', open_url: `${dealUrl}&property=${property}` });
  const ownDone = row(15, 'next_action', 'Follow-up completed for Example Dental — send the brochure', 'Pat had asked for a brochure.', 'Open',
    { ...completed, action_id: id(15), action_version: 1, undo_completion: true, open_url: stepUrl(id(15)) });
  const otherDone = row(4, 'next_action', 'Follow-up completed for Example Dental — send the brochure cover', undefined, 'Open',
    { ...completed, action_id: otherStep, action_version: 1, undo_completion: false, open_url: `${dealUrl}&focus=next-step` });
  const legacy = row(16, 'email_proposal', 'Pat Example · Sample lease', undefined, undefined,
    { item_id: `suggestion:${id(16)}`, kind_label: 'Suggestion', deal_id: null, suggestions: [{ id: id(17) }] });
  let items = [task, followUp, reminder, requirement, completion, meeting, call, feedback, legacy, ownDone, otherDone];
  let savedStepDescription = 'Send the signed lease';
  const writes = [];
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let result = { ok: true, items: [], deals: [] };
    if (name === 'read-home-inbox-v5') result = { ...result, schema_version: 'home-inbox.v5', engine_marks: true, home_mark_drop: true,
      home_proposal_drop: true, truncated: false, limit: 1000, working_collapsed: true, items };
    if (name === 'get-deal-room') result = { deal_id: args.deal, name: 'Example Dental', email_follow_ups: [],
      next_actions: [{ id: step, description: savedStepDescription, owner: 'joe', status: 'done',
        ...(width === 1440 && { title: 'Signed lease' }) }],
      items: [{ id: checklist, title: 'Review lease clauses', status: 'open', bullets: [] }],
      checklist: { schema_version: 'deal-checklist.v1', template_state: 'current', due_items: [], phases: [
        { label: 'Legal', items: [{ id: 'attorney_comments', label: 'Read attorney comments', status: 'due',
          evidence_ref: 'Example attorney memo', source: { record_verb: 'add-deal-note' } }] },
      ] } };
    if (name === 'read-engine-home-proposal') result = { proposal_id: args.id,
      kind: args.id === id(8) ? 'next_step_done' : 'next_step', what: 'Send the floor plan', evidence: 'Discussed the plan.', source_activity: { ...activity, kind: args.id === id(13) ? 'call' : 'meeting' } };
    if (name === 'decide-engine-home-proposal') {
      writes.push([name, args.id, args.decision]);
      items = items.filter(item => item.completion_review?.proposal_id !== args.id && !item.suggestions?.some(entry => entry.id === args.id));
      result = { proposal_id: args.id, status: 'accepted' };
    }
    if (name === 'end-engine-home-step') {
      writes.push([name, args.id, args.resolution]);
      items = items.map(item => item === task ? { ...item, ...completed, primary_action: 'Open', action_version: 2, undo_completion: true } : item);
      result = { next_step_id: args.id, status: 'done', change_id: 2 };
    }
    if (name === 'reopen-engine-home-step') {
      writes.push([name, args.id]);
      items = items.map(item => item === ownDone ? { ...item, source_state: 'needs_attention', section: 'inbox', completed_at: null, primary_action: 'Mark done', undo_completion: false } : item);
      result = { next_step_id: args.id, status: 'open' };
    }
    if (name === 'save-engine-home-mark') {
      writes.push([name, args.item_id, args.action]);
      items = items.filter(item => item.item_id !== args.item_id);
      result = { ok: true, item_id: args.item_id, base_version: '1:1:inbox', previous: { disposition: null, snoozed_until: null } };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await open('/?mode=live');
  const card = item => page.locator(`[data-inbox-row="${item.item_id}"]`);
  const section = name => page.getByRole('region', { name, exact: true });
  const button = (item, name = item.primary_action) => card(item).getByRole('button', { name, exact: true });
  await card(task).waitFor();
  await section('Reminders').getByRole('button', { name: 'See all 9', exact: true }).click();
  if (process.env.HOME_CARD_SCREENSHOTS) {
    await mkdir(process.env.HOME_CARD_SCREENSHOTS, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(process.env.HOME_CARD_SCREENSHOTS, `home-${width}-${theme}.png`), fullPage: true });
  }

  for (const item of [task, followUp, reminder, requirement, completion, meeting, call, feedback]) {
    const title = card(item).getByRole('heading', { name: item.title, exact: true });
    assert.equal(await title.evaluate(heading => heading.nextElementSibling?.textContent), item.why);
    const box = await button(item).boundingBox();
    assert.ok(box?.width >= 44 && box?.height >= 44, `${item.primary_action} touch target`);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (width === 390) {
    await page.addScriptTag({ content: axe.source });
    const violations = await section('Inbox cards').evaluate(async root =>
      (await window.axe.run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations);
    assert.deepEqual(violations, []);
  }
  for (const item of [task, followUp, reminder, requirement, completion, meeting, call, feedback]) {
    assert.deepEqual(await card(item).getByRole('button').allTextContents(), [item.primary_action, 'Snooze', 'Drop']);
  }
  await card(task).getByText('1 day late', { exact: false }).waitFor();
  assert.equal(await card(ownDone).count(), 0);
  assert.equal(await card(otherDone).count(), 0);
  assert.deepEqual(await card(legacy).getByRole('button').allTextContents(), ['Open', 'Review suggestions', 'Snooze', 'Drop']);

  await button(meeting).click();
  await card(meeting).getByText(/From this meeting.*Nov 2/).waitFor();
  await button(call).click();
  await card(call).getByText(/From your call.*Nov 2/).waitFor();
  assert.equal(await card(meeting).getByRole('region', { name: /Details for/ }).count(), 0);
  await card(call).getByRole('button', { name: 'Accept', exact: true }).click();
  await card(call).waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1), ['decide-engine-home-proposal', id(13), 'accept']);
  await button(completion).click();
  const detail = card(completion).getByRole('region', { name: /Details for/ });
  await detail.getByText('Discussed the plan.', { exact: true }).waitFor();
  assert.equal(await detail.getByRole('link', { name: 'Example Dental', exact: true }).getAttribute('href'), stepUrl(reviewStep));
  await detail.getByRole('button', { name: 'Yes, it’s done', exact: true }).click();
  await card(completion).waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1), ['decide-engine-home-proposal', id(8), 'accept']);
  await button(feedback).click();
  const feedbackReview = card(feedback).getByRole('region', { name: /Details for/ });
  await feedbackReview.getByText(feedback.why, { exact: true }).waitFor();
  await feedbackReview.getByRole('link', { name: 'Open property', exact: true }).click();
  const propertyView = page.getByRole('region', { name: 'Property from tour feedback' });
  await propertyView.getByText('100 Cedar Suite', { exact: true }).waitFor();
  assert.equal(await propertyView.getByText('200 Other Suite', { exact: true }).count(), 0);
  await open('/?mode=live');
  await section('Reminders').getByRole('button', { name: /^See all/ }).click();
  await button(feedback).click();
  await feedbackReview.getByRole('button', { name: 'Done', exact: true }).click();
  await card(feedback).waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1), ['save-engine-home-mark', feedback.item_id, 'done']);
  await button(task).click();
  await card(task).waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1), ['end-engine-home-step', step, 'done']);
  await button(reminder).click();
  await page.getByRole('dialog', { name: 'Review lease clauses', exact: true }).waitFor();
  await open('/?mode=live');
  await section('Reminders').getByRole('button', { name: /^See all/ }).click();
  await button(requirement).click();
  await page.getByText('Example attorney memo', { exact: true }).waitFor();
  await open(`${stepUrl(step)}&mode=live`);
  const completedStep = page.getByRole('region', { name: 'Completed step', exact: true });
  await completedStep.getByText('Send the signed lease', { exact: true }).waitFor();
  await page.waitForFunction(id => document.activeElement?.getAttribute('data-detail-focus') === `next-step-${id}`, step);
  savedStepDescription = 'Send the updated signed lease';
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await completedStep.getByText(savedStepDescription, { exact: true }).waitFor();
});

for (const width of [390, 1440]) test(`Follow-up destinations retain exact steps and their origin at ${width}px`, async t => {
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
    const link = page.getByRole('link', { name: title, exact: true });
    if (isProspect) {
      await page.getByRole('region', { name: 'Reminders', exact: true }).waitFor();
      assert.equal(await link.count(), 0);
      await open(tasks.find(([stepId]) => stepId === id)[2]);
    } else await link.click();
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


const now = NOW;
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const step = (number, title, fields = {}) => ({
  item_id: `next_action:${id(number)}`, source_type: 'next_action', source_id: id(number),
  source_version: '1', base_version: '1:0:inbox', source_state: 'needs_attention', title,
  activity_at: now.toISOString(), completed_at: null, due_on: null, hold_until: null, snoozed_until: null,
  disposition: 'inbox', section: 'inbox', unseen: false, context_label: 'Example Dental',
  open_url: `/deals?deal=${id(99)}&focus=next-step&step=${id(number)}`, deal_id: id(99),
  kind_label: 'Task', action_id: id(number), action_version: 1, merged_source_ids: [id(number)],
  waiting_version: 0, waiting_on: null, ...fields,
});
const dashboardAnswer = (reminders, waiting) => {
  const group = items => ({ count: items.length, items });
  return {
    ok: true, schema_version: 'home-inbox.v5', home_mark_drop: true, home_proposal_drop: true,
    reminders: group(reminders), waiting: group(waiting),
  };
};
const snapshot = items => ({
  ok: true, schema_version: 'home-inbox.v5', engine_marks: true, truncated: false,
  limit: 1000, working_collapsed: true, items,
});
async function dashboard(t, width, theme, timezone) {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now, timezone, page: { viewport: { width, height: 760 } } });
  page.setDefaultTimeout(4000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',
    JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route(url => url.pathname === '/' && url.searchParams.get('mode') === 'live', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<html ', '<html data-home-today-from-engine ') });
  });

  const state = {
    items: [
      step(1, 'Send the signed lease', { due_on: '2026-10-31' }),
      step(2, 'Call the practice manager', { due_on: '2026-11-03' }),
      step(3, 'Ask the surveyor for pricing'),
      step(4, 'Send the sample floor plan'),
      step(5, 'Call the new prospect', { deal_id: null, open_url: `/leads?lead=${id(55)}`, due_on: '2026-10-31' }),
      step(6, 'Follow up next week', { due_on: '2026-11-09' }),
      step(7, 'Check the lease comments', { section: 'snoozed', disposition: 'snoozed', snoozed_until: '2026-11-04T16:00:00Z' }),
      step(8, 'Send the earlier note', { section: 'done', source_state: 'done', completed_at: now.toISOString() }),
      step(9, 'Call the snoozed prospect', { deal_id: null, open_url: `/deals?prospect=${id(55)}&focus=follow-up`, section: 'snoozed', disposition: 'snoozed' }),
    ],
    dashboard: false,
    oldEngine: false,
    dashboardReads: 0,
    draft: { draft_id: id(20), version: 1, status: 'pending', subject: 'Sample reply', body: 'First draft.' },
    unavailable: false,
  };
  await page.route('**/api/engine/home/inbox?view=dashboard', route => {
    state.dashboardReads++;
    if (state.unavailable) return route.fulfill({ status: 400, json: { error: 'unregistered_operation_fields', fields: ['other'] } });
    if (state.oldEngine) return route.fulfill({ status: 400, json: { error: 'unregistered_operation_fields', fields: ['view'] } });
    if (!state.dashboard) return route.fulfill(width === 390
      ? { status: 404 }
      : { json: snapshot(state.items) });
    const cards = state.items.filter(item => item.section !== 'done').map(item => ({
      why: 'The practice requested an update.', primary_action: item.section === 'inbox' ? 'Mark done' : null,
      source_activity: null, undo_completion: false, returns_at: item.snoozed_until,
      waiting_reason: item.section === 'snoozed' ? 'Snoozed' : null, days_late: null, late_label: null, ...item,
    }));
    return route.fulfill({ json: dashboardAnswer(
      cards.filter(item => item.section === 'inbox'), cards.filter(item => item.section === 'snoozed'),
    ) });
  });
  await page.route('**/mcp', route => {
    const request = route.request().postDataJSON();
    const { name, arguments: args } = request.params;
    let result = { ok: true, items: [], deals: [] };
    if (name === 'read-home-inbox-v5') result = snapshot(state.items.map(({ card_id, ...item }) => item));
    if (name === 'read-engine-home-draft') result = {
      ...state.draft,
      to: 'sender@example.test', cc: 'partner@example.test', attachments: [], source_activity: { sender: 'sender@example.test', subject: 'Sample email',
        body: 'Can you share the floor plan?', happened_at: now.toISOString() },
    };
    if (name === 'edit-engine-home-draft') {
      assert.equal(args.id, state.draft.draft_id);
      assert.equal(args.version, state.draft.version);
      state.draft = { ...state.draft, version: args.version + 1, body: args.body, subject: args.subject };
      state.items = state.items.map(item => item.reply_draft_id === args.id
        ? { ...item, source_version: String(state.draft.version) } : item);
      result = state.draft;
    }
    if (name === 'save-engine-home-mark') {
      assert.equal(args.action, 'snooze');
      state.items = state.items.map(item => item.item_id === args.item_id
        ? { ...item, base_version: '1:1:snoozed', section: 'snoozed', disposition: 'snoozed', snoozed_until: args.until }
        : item);
      result = { ok: true, item_id: args.item_id, base_version: '1:1:snoozed', previous: { disposition: null, snoozed_until: null } };
    }
    if (name === 'end-engine-home-step') {
      state.items = state.items.map(item => item.action_id === args.id
        ? { ...item, section: 'done', source_state: 'done', completed_at: now.toISOString(), action_version: 2 }
        : item);
      result = { next_step_id: args.id, status: 'done', change_id: 2 };
    }
    return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  return { page, open, state };
}

test('Home uses the flat inbox when the older engine refuses the dashboard view', async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.oldEngine = true;
  await open('/?mode=live');
  await page.getByRole('region', { name: 'Reminders', exact: true }).getByRole('link', { name: 'Send the signed lease' }).waitFor();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home dashboard at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  await page.clock.install({ time: now });
  await open('/?mode=live');
  const heading = page.getByRole('heading', { name: 'Home', level: 1, exact: true });
  assert.equal(await heading.count(), 1);
  assert.deepEqual(await heading.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.position, style.width, style.height, style.overflow];
  }), ['absolute', '1px', '1px', 'hidden']);
  const tile = name => page.getByRole('region', { name, exact: true });
  const reminders = tile('Reminders'), waiting = tile('In motion and waiting');
  await reminders.getByRole('heading', { name: 'Reminders 4' }).waitFor();
  await waiting.getByRole('heading', { name: 'In motion and waiting 1' }).waitFor();
  for (const name of ['Today', 'Needs your attention', 'Done today', 'Earlier and undated completions', 'Mail priorities']) {
    assert.equal(await tile(name).count(), 0, name);
  }
  for (const forbidden of ['Welcome home.', 'Refresh inbox', 'Search inbox', 'Today sidebar']) {
    assert.equal(await page.getByText(forbidden, { exact: true }).count(), 0, forbidden);
  }
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal(await page.getByRole('button', { name: 'Today sidebar' }).isVisible(), false);
  assert.equal(await page.locator('#appToday').isVisible(), false);
  assert.equal(await page.locator('.app-shell-search').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Search and quick switcher' }).isVisible(), true);
  assert.equal(await page.locator('.app-layout-status').count(), 0);
  const [first, second] = await Promise.all([reminders.boundingBox(), waiting.boundingBox()]);
  if (width === 390) {
    assert.equal(first.x, second.x);
    assert.ok(second.y >= first.y + first.height);
  } else {
    assert.equal(first.y, second.y);
    assert.ok(second.x >= first.x + first.width);
  }
  await reminders.getByRole('heading', { name: 'Late', exact: true }).waitFor();
  await reminders.getByText(/3 days late/).waitFor();
  assert.equal(await page.getByText(/Call the (new|snoozed) prospect|Follow up next week|Send the earlier note/).count(), 0);
  const wake = waiting.getByRole('button', { name: 'Wake', exact: true });
  await wake.waitFor();
  await waiting.getByText(/Snoozed until/).waitFor();
  const lease = reminders.getByRole('link', { name: 'Send the signed lease' });
  assert.match(await lease.getAttribute('href'), /focus=next-step&step=/);
  await reminders.getByRole('button', { name: /^See all/ }).click();
  await reminders.getByRole('link', { name: 'Send the sample floor plan' }).waitFor();
  await reminders.getByRole('button', { name: 'Show less' }).click();
  if (process.env.HOME_GRID_SCREENSHOTS) {
    await mkdir(process.env.HOME_GRID_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.HOME_GRID_SCREENSHOTS, `home-${width}-${theme}.png`), fullPage: true });
  }
  await reminders.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: 'Send the signed lease' }) }).getByRole('button', { name: 'Mark done' }).click();
  await lease.waitFor({ state: 'detached' });
  await reminders.getByRole('heading', { name: 'Late', exact: true }).waitFor({ state: 'detached' });
  await reminders.getByRole('heading', { name: 'Reminders 3' }).waitFor();
  state.unavailable = true;
  await page.clock.fastForward(60_000);
  await page.getByText('Reminders and waiting items unavailable.', { exact: true }).waitFor();
  assert.equal(await reminders.getByRole('heading', { name: 'Reminders 3' }).count(), 1);
  state.unavailable = false;
  state.items = [];
  await page.clock.fastForward(60_000);
  await reminders.waitFor({ state: 'detached' });
  await waiting.waitFor({ state: 'detached' });
});

const draftCard = () => ({
  ...step(20, 'Reply to the practice manager'), item_id: `reply_draft:${id(20)}`,
  source_type: 'email_proposal', reply_draft_id: id(20), reply_draft_status: 'pending', kind_label: 'Reply draft',
  action_id: null, action_version: null, due_on: null, open_url: null, deal_id: null, card_id: 'conversation:1',
  primary_action: null,
});

for (const save of ['single', 'bulk', 'review']) test(`Home keeps grouped cards after a ${save} save`, async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const done = step(1, 'Send the signed lease', { card_id: 'lease:1' });
  const next = step(2, 'Call the practice manager', { card_id: 'lease:2' });
  const untouched = step(3, 'Confirm the site visit', { card_id: 'lease:3', due_on: '2026-11-09' });
  state.dashboard = true;
  state.items = [untouched, draft, done, next];
  await page.clock.install({ time: now });
  await open('/?mode=live');
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const unchanged = reminders.getByRole('link', { name: untouched.title });
  await unchanged.waitFor();
  const original = await unchanged.elementHandle();
  const reads = state.dashboardReads;

  if (save === 'single') {
    await reminders.locator('[data-inbox-row]').filter({ hasText: done.title }).getByRole('button', { name: 'Mark done' }).click();
    await page.getByText(/Marked done: Send the signed lease/).waitFor();
    assert.equal(await reminders.getByRole('link', { name: done.title }).count(), 0);
  }
  if (save === 'bulk') {
    await reminders.getByRole('button', { name: 'See all 4' }).click();
    for (const task of [done, next])
      await reminders.locator('[data-inbox-row]').filter({ hasText: task.title }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Snooze selected' }).click();
    await page.getByRole('button', { name: /^Not now · Tomorrow/ }).click();
    await page.locator('[data-batch-state="results"]').waitFor();
    await page.getByRole('region', { name: 'In motion and waiting', exact: true })
      .getByRole('heading', { name: 'In motion and waiting 2' }).waitFor();
  }
  if (save === 'review') {
    await reminders.getByRole('link', { name: draft.title }).click();
    const review = reminders.getByRole('region', { name: `Details for ${draft.title}` });
    await review.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited sample draft.');
    await review.getByRole('button', { name: 'Save draft', exact: true }).click();
    await review.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  }

  assert.equal(state.dashboardReads, reads + 1);
  assert.equal(await original.evaluate(node => node.isConnected), true);
  await unchanged.waitFor();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home polls in place at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  const draft = draftCard();
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    ...step(21 + index, `Call about sample suite ${index + 1}`), card_id: `suite:${index}`,
  }));
  state.dashboard = true;
  state.items = [...tasks.slice(0, 5), draft, ...tasks.slice(5)];
  await page.clock.install({ time: now });
  await open('/?mode=live');
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  await reminders.getByRole('button', { name: 'See all 11' }).click();
  const draftTitle = reminders.getByRole('link', { name: draft.title });
  await draftTitle.click();
  const review = reminders.getByRole('region', { name: `Details for ${draft.title}` });
  const message = review.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Unsaved edit for the floor plan.');
  await message.scrollIntoViewIfNeeded();
  const before = await message.evaluate(node => ({ y: scrollY, top: node.getBoundingClientRect().top }));
  assert.ok(before.y > 0 && before.top >= 0 && before.top < 760);
  const reads = state.dashboardReads;
  const added = { ...step(32, 'Confirm the site visit'), card_id: 'suite:new' };
  state.items = [added, ...state.items.filter(item => item !== tasks[0]).reverse()];
  await page.clock.fastForward(60_000);
  await reminders.getByRole('link', { name: added.title }).waitFor();
  await reminders.getByRole('link', { name: tasks[0].title, exact: true }).waitFor({ state: 'detached' });
  assert.equal(state.dashboardReads, reads + 1);
  assert.equal(await message.inputValue(), 'Unsaved edit for the floor plan.');
  assert.equal(await message.evaluate(node => node === document.activeElement), true);
  const after = await message.evaluate(node => ({ y: scrollY, top: node.getBoundingClientRect().top }));
  assert.ok(Math.abs(after.top - before.top) <= 2, JSON.stringify({ before, after }));
  assert.deepEqual(await reminders.locator('article > .inbox-copy h3 a').allTextContents(),
    [...tasks.slice(1, 5), draft, ...tasks.slice(5), added].map(item => item.title));

  state.items = state.items.filter(item => item !== draft);
  await page.clock.fastForward(60_000);
  await review.getByText('This card was finished elsewhere.').waitFor();
  assert.equal(await message.inputValue(), 'Unsaved edit for the floor plan.');
  await review.getByRole('button', { name: 'Close review' }).click();
  await draftTitle.waitFor({ state: 'detached' });
  assert.equal(await reminders.getByRole('link', { name: tasks[5].title }).evaluate(node => node === document.activeElement), true);
  const readCount = state.dashboardReads;
  for (const property of ['hidden', 'offline']) {
    await page.evaluate(property => {
      if (property === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        window.dispatchEvent(new Event('offline'));
      }
    }, property);
    await page.clock.fastForward(120_000);
    assert.equal(state.dashboardReads, readCount);
  }
});


const scheduledMeeting = {
  title: 'Tour Cedar Suite', start: '2026-11-03T13:30:00Z', end: '2026-11-03T14:30:00Z',
};
const meetingOutcome = { ...scheduledMeeting, key: 'aaaaaaaaaaaaaaaa', state: 'needs_review' };
const meetingDeal = { id: id(99), name: 'Example Dental', owner: 'joe' };

async function meetingDashboard(t, calendar, time = NOW) {
  const { page, open, state } = await dashboard(t, 1440, 'light', 'UTC');
  state.items = [];
  await page.clock.install({ time });
  await page.route(request => request.pathname === '/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    if (params.name !== 'deal-room-board') return route.fallback();
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text',
      text: JSON.stringify({ actor: 'joe', deals: [meetingDeal] }),
    }] } } });
  });
  await page.route('**/api/engine/home/today', route => calendar.unavailable
    ? route.fulfill({ status: 503 })
    : route.fulfill({ json: {
      ok: true, schema_version: 'home-today.v1', today: '2026-11-03', viewer: 'joe',
      meetings: { state: 'ready', observed_at: '2026-11-03T14:00:00Z', items: [], follow_up_reviews: [], ...calendar },
    } }));
  await open('/?mode=live');
  return { page, meetings: page.getByRole('region', { name: "Today's meetings", exact: true }) };
}

test('Home meetings rolls over at Central midnight even when the refresh fails', async t => {
  const calendar = { items: [scheduledMeeting] };
  const { page, meetings } = await meetingDashboard(t, calendar, new Date('2026-11-04T05:59:50Z'));
  await meetings.getByText(scheduledMeeting.title, { exact: true }).waitFor();
  calendar.unavailable = true;
  await page.clock.fastForward(20_000);
  await meetings.waitFor({ state: 'detached' });
  await page.getByText('Last synced Nov 3, 8:00 AM Central').waitFor();
  await page.clock.fastForward(60_000);
  await page.getByText('Meetings unavailable.', { exact: true }).waitFor();
  await page.getByText('Last synced Nov 3, 8:00 AM Central').waitFor();
});

test('Home keeps a review-only meeting after its outcome is saved and refreshed', async t => {
  const calendar = { follow_up_reviews: [meetingOutcome] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  await page.route('**/api/engine/activities', route => {
    calendar.follow_up_reviews = [];
    return route.fulfill({ status: 201, json: { activity_id: id(91), existing: false } });
  });
  await meetings.locator('summary').filter({ hasText: scheduledMeeting.title }).press('Enter');
  await meetings.getByRole('combobox', { name: 'Deal', exact: true }).selectOption(meetingDeal.id);
  await meetings.getByRole('button', { name: 'It happened', exact: true }).click();
  await page.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  const title = meetings.getByText(scheduledMeeting.title, { exact: true });
  await title.waitFor();
  await meetings.getByRole('button', { name: 'It happened', exact: true }).waitFor({ state: 'detached' });
  calendar.state = 'partial';
  calendar.observed_at = '2026-11-03T14:01:00Z';
  await page.clock.fastForward(60_000);
  await meetings.getByText('Last synced Nov 3, 8:01 AM Central').waitFor();
  await title.waitFor();
});

test('Home keeps previously read attendees and deal links when Outlook moves the event to outcomes', async t => {
  const open_url = `/deals?deal=${meetingDeal.id}`;
  const calendar = { items: [{ ...scheduledMeeting, open_url, attendees: [{ name: 'Pat Example' }] }] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  const summary = meetings.locator('summary').filter({ hasText: scheduledMeeting.title });
  await summary.press('Enter');
  await meetings.getByText('Pat Example', { exact: true }).waitFor();
  calendar.items = [];
  calendar.follow_up_reviews = [meetingOutcome];
  await page.clock.fastForward(60_000);
  await meetings.getByRole('button', { name: 'It happened', exact: true }).waitFor();
  await meetings.getByText('Pat Example', { exact: true }).waitFor();
  assert.equal(await meetings.getByRole('link', { name: 'Open deal' }).getAttribute('href'), open_url);
});

test('Home puts an overnight outcome on its meeting', async t => {
  const overnight = { ...scheduledMeeting, start: '2026-11-03T05:30:00Z', end: '2026-11-03T06:30:00Z' };
  const { page, meetings } = await meetingDashboard(t, {
    items: [overnight], follow_up_reviews: [{ ...meetingOutcome, ...overnight }],
  });
  await meetings.locator('summary').filter({ hasText: overnight.title }).press('Enter');
  await meetings.getByRole('button', { name: 'It happened', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: `Confirm ${overnight.title}` }).count(), 0);
});

test('Home keeps separate invites with the same title and times', async t => {
  const pat = { ...scheduledMeeting, attendees: [{ name: 'Pat Example' }] };
  const lee = { ...scheduledMeeting, key: meetingOutcome.key, attendees: [{ name: 'Lee Example' }] };
  const { meetings } = await meetingDashboard(t, {
    items: [pat, pat, lee], follow_up_reviews: [meetingOutcome],
  });
  await meetings.getByRole('heading', { name: "Today's meetings 3" }).waitFor();
  for (const summary of await meetings.locator('summary').all()) await summary.press('Enter');
  const matches = meetings.locator('details').filter({ hasText: 'Pat Example' });
  assert.equal(await matches.count(), 2);
  assert.equal(await matches.getByRole('button', { name: 'It happened', exact: true }).count(), 0);
  await meetings.locator('details').filter({ hasText: 'Lee Example' })
    .getByRole('button', { name: 'It happened', exact: true }).waitFor();
});

test('Home keeps the open meeting outcome and its focus when earlier meetings arrive', async t => {
  const calendar = { items: [scheduledMeeting], follow_up_reviews: [meetingOutcome] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  await meetings.locator('summary').filter({ hasText: scheduledMeeting.title }).press('Enter');
  const choice = meetings.getByRole('combobox', { name: 'Deal', exact: true });
  await choice.selectOption(meetingDeal.id);
  await choice.focus();
  const earlier = Array.from({ length: 3 }, (_, index) => ({
    title: `Earlier sample meeting ${index + 1}`, start: '2026-11-03T12:00:00Z', end: '2026-11-03T13:00:00Z',
  }));
  calendar.items = [...earlier, scheduledMeeting];
  await page.clock.fastForward(60_000);
  await meetings.getByRole('heading', { name: "Today's meetings 4" }).waitFor();
  assert.equal(await choice.inputValue(), meetingDeal.id);
  assert.equal(await choice.evaluate(node => node === document.activeElement), true);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home meeting tile at ${width}px in ${theme}`, async t => {
  const { page, open } = await dashboard(t, width, theme);
  const deal = { id: id(99), name: 'Example Dental', owner: 'joe' };
  const current = { key: 'aaaaaaaaaaaaaaaa', title: 'Tour Cedar Suite', start: '2026-11-03T13:30:00Z', end: '2026-11-03T14:30:00Z',
    context_label: deal.name, attendees: [{ name: 'Pat Example' }], open_url: `/deals?deal=${deal.id}` };
  const later = ['Review sample terms', 'Visit Elm Suite', 'Tour Pine Suite'].map((title, index) => ({
    title, start: `2026-11-03T${18 + index}:00:00Z`, end: `2026-11-03T${19 + index}:00:00Z`,
  }));
  const laterDay = { ...current, title: 'Tour tomorrow', start: '2026-11-04T18:00:00Z', end: '2026-11-04T19:00:00Z' };
  const completed = { ...current, key: 'aaaaaaaaaaaaaaaa', state: 'needs_review' };
  const earlier = { ...completed, key: 'bbbbbbbbbbbbbbbb', title: 'Yesterday’s site visit',
    start: '2026-11-02T19:00:00Z', end: '2026-11-02T20:00:00Z' };
  let items = [current, current, ...later, laterDay];
  let reviews = [completed, earlier, earlier];
  let meetingError = false;
  const writes = [];
  await page.route(request => request.pathname === '/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    if (params.name !== 'deal-room-board') return route.fallback();
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({
      actor: 'joe', deals: [deal],
    }) }] } } });
  });
  await page.route('**/api/engine/home/today', route => meetingError ? route.fulfill({ status: 503 }) : route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', today: '2026-11-03', viewer: 'joe',
    meetings: { state: items.length ? 'partial' : 'empty', observed_at: '2026-11-03T14:00:00Z', items, follow_up_reviews: reviews },
  } }));
  await page.route('**/api/engine/activities', route => {
    writes.push(route.request().postDataJSON());
    reviews = reviews.filter(review => review.key !== completed.key);
    return route.fulfill({ status: 201, json: { activity_id: id(91), existing: false } });
  });
  await page.route('**/api/engine/calendar/reviews/*/dismissal', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-2);
    reviews = reviews.filter(review => review.key !== key);
    return route.fulfill({ json: { key, dismissed_at: NOW.toISOString() } });
  });

  await page.clock.install({ time: NOW });
  await open('/?mode=live');
  const meetings = page.getByRole('region', { name: "Today's meetings", exact: true });
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  await meetings.getByRole('heading', { name: "Today's meetings 4" }).waitFor();
  await reminders.getByRole('heading', { name: 'Reminders 5' }).waitFor();
  await meetings.getByText('Last synced Nov 3, 8:00 AM Central').waitFor();
  assert.equal(await meetings.getByText(current.title, { exact: true }).count(), 1);
  assert.equal(await meetings.getByText(laterDay.title, { exact: true }).count(), 0);
  assert.equal(await meetings.locator('summary').count(), 3);
  assert.equal(await meetings.getByText('7:30 AM', { exact: true }).count(), 1);
  await meetings.getByRole('button', { name: 'See all 4' }).click();
  await meetings.getByText(later[2].title, { exact: true }).waitFor();
  await meetings.getByRole('button', { name: 'Show less' }).click();
  assert.equal(await meetings.getByText(earlier.title, { exact: true }).count(), 0);
  assert.equal(await page.locator('#appToday').isVisible(), false);
  assert.equal(await page.locator('.app-shell-search').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Search and quick switcher' }).isVisible(), true);
  assert.equal(await page.locator('.app-layout-status').count(), 0);
  const homeTitle = page.getByRole('heading', { name: 'Home', exact: true });
  assert.equal(await homeTitle.evaluate(node => getComputedStyle(node).clip), 'rect(0px, 0px, 0px, 0px)');
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  if (process.env.HOME_MEETING_SCREENSHOTS) {
    await mkdir(process.env.HOME_MEETING_SCREENSHOTS, { recursive: true });
    if (width === 390) await page.setViewportSize({ width, height: 1400 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: join(process.env.HOME_MEETING_SCREENSHOTS, `home-meetings-${width}-${theme}.png`), fullPage: true });
    if (width === 390) await page.setViewportSize({ width, height: 760 });
  }
  await meetings.locator('summary').filter({ hasText: current.title }).press('Enter');
  await meetings.getByText('Pat Example', { exact: true }).waitFor();
  assert.equal(await meetings.getByRole('link', { name: 'Open deal' }).getAttribute('href'), current.open_url);
  const choose = meetings.getByRole('combobox', { name: 'Deal', exact: true });
  await choose.selectOption(deal.id);
  await choose.focus();
  meetingError = true;
  await page.clock.fastForward(60_000);
  await page.getByText('Meetings unavailable.', { exact: true }).waitFor();
  assert.equal(await choose.inputValue(), deal.id);
  assert.equal(await choose.evaluate(node => node === document.activeElement), true);
  assert.equal(await reminders.getByRole('heading', { name: 'Reminders 5' }).count(), 1);
  await meetings.getByRole('button', { name: 'It happened', exact: true }).click();
  await page.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].calendar_review_key, completed.key);
  assert.deepEqual(writes[0].about, [{ deal_id: deal.id }]);

  await reminders.getByRole('button', { name: 'See all 5' }).click();
  const earlierReview = reminders.locator(`[data-review="${earlier.key}"]`);
  await earlierReview.getByRole('heading', { name: /Yesterday’s site visit/ }).waitFor();
  await earlierReview.getByRole('button', { name: /Confirm Yesterday’s site visit/ }).press('Enter');
  await earlierReview.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await earlierReview.waitFor({ state: 'detached' });
  meetingError = false;
  items = [laterDay];
  await page.clock.fastForward(60_000);
  await page.getByText('Meetings unavailable.', { exact: true }).waitFor({ state: 'detached' });
  await meetings.getByRole('heading', { name: "Today's meetings 1" }).waitFor();
  await meetings.getByText(current.title, { exact: true }).waitFor();
  assert.equal(await meetings.getByText(laterDay.title, { exact: true }).count(), 0);
  assert.equal(await reminders.getByRole('heading', { name: 'Reminders 4' }).count(), 1);
});

});
