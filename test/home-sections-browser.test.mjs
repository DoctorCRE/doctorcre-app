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
  const { page, open, hold } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
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
    APP_ENV: enabled ? 'production' : 'fixture',
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
  if (enabled) {
    const held = waiting.locator('[data-inbox-row]');
    await held.getByText(/On hold until Nov 5, 2026/).waitFor();
    assert.doesNotMatch(await held.innerText(), /needs attention|Ready for your attention/i);
    assert.equal(await held.getByRole('button').count(), 0);
    assert.equal(await held.getByRole('link', { name: /^Wait for sample terms/ }).getAttribute('href'), tasks[0].path);
  }
  assert.equal(await inbox.locator('[data-inbox-row]').count(), state.items.length);
  assert.equal(await inbox.getByText('needs attention', { exact: true }).count(), 0);
  assert.equal(await inbox.getByText('Ready for your attention', { exact: true }).count(), enabled ? 0 : tasks.length);
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
    await snoozed.getByText(/^Snoozed until .* [AP]M$/).waitFor();
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
  details.set(leading, { ...evidence, proposal_id: leading, kind: 'possible_new_deal',
    source_activity: { kind: 'email' },
    thread: [{ activity_id: leading, happened_at: NOW.toISOString(), sender_name: null,
      body: '&amp;lt; is a literal reference. Our R&D team said &lt;strong&gt;Ready&#33;&lt;/strong&gt;' }] });
  details.set(nested, { ...evidence, proposal_id: nested, kind: 'next_step', what: 'Share the sample plan', due_on: '2026-11-04' });
  details.set(remaining, { ...evidence, proposal_id: remaining, kind: 'possible_new_deal' });
  details.set(dismissNested, { ...evidence, proposal_id: dismissNested, kind: 'file_to_deal', filing_choices: [{ kind: 'deal', label: 'Choose deal' }] });
  details.set(draft, { draft_id: draft, version: 1, status: 'pending', subject: 'Sample reply', body: 'First draft.',
    to: 'sender@example.test', cc: 'partner@example.test', attachments: [{ document_id: dealId, name: 'Sample plan' }],
    source_activity: { kind: 'email', subject: 'Sample email' },
    thread: [{ activity_id: draft, sender_name: 'Pat Example', happened_at: NOW.toISOString(),
      body: '&#65279;Tom &amp; Pat&#39;s &lt;sample&gt;&nbsp;plan.' }] });
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
  await today.getByRole('button', { name: 'See all 8', exact: true }).click();
  const leadCard = inbox.locator(`[data-inbox-row="suggestion:${lead}"]`);
  await leadCard.getByRole('button', { name: 'Open', exact: true }).click();
  await leadCard.getByRole('heading', { name: 'Possible lead · New Example' }).waitFor();
  await leadCard.getByText('Asked about leasing a suite.', { exact: true }).waitFor();
  assert.equal(await leadCard.getByText('I am looking to lease a suite.', { exact: true }).count(), 0);
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
  await reply.getByRole('region', { name: 'Email thread', exact: true }).waitFor();
  await reply.getByRole('button', { name: 'Edit', exact: true }).click();
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
  const callReview = suggestions.getByRole('region', { name: /Details for Call suggestions/ });
  const callDrop = callReview.getByRole('button', { name: 'Drop', exact: true });
  await callDrop.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Drop with a reason' }).waitFor({ state: 'detached' });
  assert.equal(await callReview.isVisible(), true);
  assert.equal(await callDrop.evaluate(node => node === document.activeElement), true);
  await callDrop.click();
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
  const draftRead = await hold(request => new URL(request.url()).pathname === '/mcp' &&
    request.postDataJSON()?.params?.name === 'read-engine-home-draft');
  await reply.getByRole('button', { name: 'Review reply', exact: true }).click();
  await draftRead.requested;
  const emailTitle = email.getByRole('link', { name: /Sample Sender · Floor plan/ });
  await emailTitle.focus();
  draftRead.release();
  await reply.getByRole('textbox', { name: 'Subject', exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await reply.getByRole('region', { name: /Details for Reply to the sample email/ }).waitFor({ state: 'detached' });
  assert.equal(await email.getByText('Suggestion', { exact: true }).count(), 0);
  assert.equal(await email.getByText(/days late/).count(), 0);
  assert.equal(await email.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
  const possibleDeal = email.getByRole('region', { name: 'Possible new deal', exact: true });
  await possibleDeal.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  const suggestionExcerpt = email.getByRole('region', { name: 'Email thread', exact: true })
    .getByText(/is a literal reference/);
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
  const replyExcerpt = reply.getByRole('region', { name: 'Email thread', exact: true }).getByText(/Tom & Pat/);
  await replyExcerpt.waitFor();
  assert.equal(await replyExcerpt.textContent(), "Tom & Pat's <sample>\u00a0plan.");
  await reply.getByRole('link', { name: 'Sample plan', exact: true }).waitFor();
  assert.equal(await cardFor(/Remaining email suggestion/).count(), 0);
  await reply.getByRole('button', { name: 'Accept', exact: true }).first().click();
  await reply.getByText('Suggestion accepted.', { exact: true }).waitFor();
  assert.match(writes.at(-1)[0], new RegExp(`/proposals/${nested}/decision$`));
  const filingRegion = reply.getByRole('region', { name: 'File this email', exact: true });
  assert.equal(await filingRegion.getByRole('button', { name: 'Dismiss' }).count(), 0);
  await filingRegion.getByRole('button', { name: 'Drop', exact: true }).click();
  const filingDialog = page.getByRole('dialog', { name: 'Drop with a reason' });
  await filingDialog.getByRole('heading', { name: 'Drop this filing suggestion?' }).waitFor();
  await page.keyboard.press('Escape');
  await filingDialog.waitFor({ state: 'detached' });
  const dropFiling = filingRegion.getByRole('button', { name: 'Drop', exact: true });
  assert.equal(await dropFiling.evaluate(node => node === document.activeElement), true);
  await dropFiling.click();
  await confirmDrop('Already filed.');
  await reply.getByText('Suggestion dropped.', { exact: true }).waitFor();
  assert.match(writes.at(-1)[0], new RegExp(`/proposals/${dismissNested}/decision$`));
  assert.equal(writes.at(-1)[1].decision, 'dismiss');
  assert.equal(writes.at(-1)[1].reason, 'Already filed.');
  assert.equal(await reply.getByRole('region', { name: /Details for Reply to the sample email/ }).evaluate(node => node === document.activeElement), true);
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
  await reply.getByText('Saved again from another tab.', { exact: true }).waitFor();
  await reply.getByRole('button', { name: 'Edit', exact: true }).click();
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
  await fallback.getByRole('status').filter({ hasText: /Correct them and send again/ }).waitFor();
  assert.equal(await fallback.getByRole('textbox', { name: 'Reason for declining' }).count(), 0);
  const to = fallback.getByRole('textbox', { name: 'To', exact: true });
  assert.equal(await to.inputValue(), 'sender@example.test');
  await to.fill('not an address');
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  assert.equal(writes.at(-1)[1].version, 3);
  await to.fill('sender@example.org');
  const cc = fallback.getByRole('textbox', { name: 'CC', exact: true });
  await cc.fill('');
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  assert.equal(writes.at(-1)[1].version, 3);
  await cc.fill('partner@example.org');
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  await fallback.getByText('Sending', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 4, subject: 'Revised sample reply',
    body: 'Final edited reply.', to: 'sender@example.org', cc: 'partner@example.org', document_ids: [dealId] });
  Object.assign(draftRecord, { status: 'failed', failure_reason: 'mailbox_rejected' });
  Object.assign(fallbackCard.fallback_reply_draft, { status: 'failed', failure_reason: draftRecord.failure_reason });
  await page.clock.fastForward(60_000);
  await fallback.getByText(/^Didn't send/).waitFor();
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('status').filter({ hasText: /Reply from Outlook/ }).waitFor();
  assert.equal(await fallback.getByRole('button', { name: 'Send reply', exact: true }).count(), 0);
  assert.equal(await fallback.getByRole('textbox', { name: /^(To|CC)$/ }).count(), 0);
  await fallback.getByRole('button', { name: 'Close review' }).click();
  Object.assign(draftRecord, { status: 'failed', failure_reason: 'aborted_before_dispatch' });
  Object.assign(fallbackCard.fallback_reply_draft, { status: 'failed', failure_reason: draftRecord.failure_reason });
  await page.clock.fastForward(60_000);
  await fallback.getByText(/Sending stopped before delivery/).waitFor();
  await fallback.getByRole('button', { name: 'Open', exact: true }).click();
  await fallback.getByRole('button', { name: 'Send reply', exact: true }).click();
  // Home pauses polling while the reply is saving.
  const fallbackReview = fallback.getByRole('region', { name: /Details for Remaining email suggestion/ });
  await fallbackReview.waitFor({ state: 'detached' });
  await fallback.getByText('Sending', { exact: true }).waitFor();
  assert.equal(writes.at(-1)[1].version, 5);
  details.set(decline, { ...details.get(draft), draft_id: decline, version: 1, status: 'pending' });
  state.items.push({ ...notice, title: 'Another sample draft', item_id: `reply_draft:${decline}`, source_id: decline,
    source_type: 'email_proposal', deal_id: null, kind_label: 'Reply draft', source_version: '1', reply_draft_id: decline, reply_draft_status: 'pending' });
  await page.clock.fastForward(60_000);
  const declined = cardFor(/Another sample draft/);
  await declined.getByRole('button', { name: 'Open', exact: true }).click();
  await declined.getByRole('button', { name: 'Edit', exact: true }).click();
  const declinedMessage = declined.getByRole('textbox', { name: 'Message', exact: true });
  assert.equal(await declinedMessage.inputValue(), 'Final edited reply.');
  await declinedMessage.fill('Unsaved text to drop.');
  const draftReview = declined.getByRole('region', { name: /Details for Another sample draft/ });
  const draftDrop = draftReview.getByRole('button', { name: 'Drop', exact: true });
  await draftDrop.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Drop with a reason' }).waitFor({ state: 'detached' });
  assert.equal(await draftReview.isVisible(), true);
  assert.equal(await draftDrop.evaluate(node => node === document.activeElement), true);
  await draftDrop.click();
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
    await page.locator('.toast').getByText('Undone.', { exact: true }).waitFor();
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

for (const [width, theme, planner] of [[390, 'light'], [390, 'dark'], [1440, 'light'], [1440, 'dark'], [390, 'dark', true]]) test(`engine card copy and actions ${width} ${theme}${planner ? ' with tour planning on' : ''}`, async t => {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));

  await page.route(url => url.pathname === '/deals' && !url.searchParams.has('mode'), route => {
    const url = new URL(route.request().url());
    url.searchParams.set('mode', 'live');
    return route.fulfill({ status: 302, headers: { location: url.href } });
  });

  if (planner) await page.route(url => url.pathname === '/deals' && url.searchParams.has('mode'), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<html', '<html data-deal-tours-from-engine') });
  });
  const tourRequests = [];
  await page.route('**/api/engine/deals/*/tours', route => {
    tourRequests.push(route.request().url());
    return route.fulfill({ json: { tours: [] } });
  });

  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const deal = id(1), step = id(2), checklist = id(3), otherStep = id(4), reviewStep = id(5), property = id(14);
  const carrPropertyRequests = [];
  await page.route('**/api/tours/property-evidence/v1?*', route => {
    const selected = new URL(route.request().url()).searchParams.get('property_id');
    carrPropertyRequests.push(selected);
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
    { action_id: step, action_version: 1, open_url: stepUrl(step), due_on: '2026-11-02', days_late: 1 });
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
    'Review feedback', { kind: 'tour_feedback', kind_label: 'Tour feedback', open_url: `${dealUrl}&property=${property}${planner ? '&mode=live' : ''}` });
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
  for (const item of [task, followUp, reminder, requirement, completion, meeting, call]) {
    assert.deepEqual(await card(item).getByRole('button').allTextContents(), [item.primary_action, 'Snooze', 'Drop']);
  }
  assert.deepEqual(await card(feedback).getByRole('button').allTextContents(), [feedback.primary_action, 'Snooze']);
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
  if (planner) await page.locator('html[data-deal-tours-from-engine]').waitFor({ state: 'attached' });
  const propertyView = page.getByRole('region', { name: 'Property from tour feedback' });
  await propertyView.getByText('100 Cedar Suite', { exact: true }).waitFor();
  assert.deepEqual(carrPropertyRequests, [property]);
  assert.equal(await propertyView.getByText('200 Other Suite', { exact: true }).count(), 0);
  assert.deepEqual(tourRequests, []);
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
    await step.getByText(/Set by Example Partner · Nov 3.*10:00 AM · From an? (email|meeting)/).waitFor();
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

test('Calendar rail stays empty with no Page tools at narrow desktop sizes', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    await run.open(`/calendar`);
    assert.equal(await page.locator('#appSidebar .app-layout-working, #appSidebar [data-layout-slot=sidebar], #appSidebar .calendar-panel-followup').count(), 0);
    assert.equal(await page.locator('.app-layout-page-tools').count(), 0);
    assert.ok(await page.locator('#appSidebar').evaluate(node => node.scrollHeight <= node.clientHeight));
  }
});

test('late automatic Home walkthrough preserves an open account menu', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: {} });
  const { page } = run;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => route.fulfill({ json: { result: { content: [{ type: 'text', text: '{}' }] } } }));
  const gate = await run.hold('**/js/app-walkthrough.js');
  await run.open(`/?mode=live`, { waitUntil: 'domcontentloaded' });
  const account = page.getByRole('button', { name: 'Joe: account and settings', exact: true });
  await account.click();
  assert.equal(await page.locator('#accountMenu').isVisible(), true);
  await gate.requested;
  gate.release();
  await page.evaluate(() => import('/js/app-walkthrough.js').then(() => true));
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
const snapshot = (items, legacy = false) => ({
  ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true,
  ...(legacy ? { auto_settle_enabled: true } : { engine_marks: true }),
  items: legacy ? items.map(item => ({ ...item, explicit_unsettle: false, auto_settled: false })) : items,
});
async function dashboard(t, width, theme, timezone) {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now, timezone, page: { viewport: { width, height: 760 } } });
  page.setDefaultTimeout(4000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',
    JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route(url => url.pathname === '/' && url.searchParams.get('mode') === 'live', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<html ', '<html data-home-today-from-engine ') });
  });

  const state = {
    items: [
      step(1, 'Send the signed lease', { due_on: '2026-10-31', days_late: 3 }),
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
    legacy: false,
    dashboardReads: 0,
    draft: { draft_id: id(20), version: 1, status: 'pending', subject: 'Sample reply', body: 'First draft.' },
    thread: mailThread,
    draftThread: undefined,
    proposalEvidence: undefined,
    draftWrites: [],
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
  await page.route('**/mcp', async route => {
    const request = route.request().postDataJSON();
    const { name, arguments: args } = request.params;
    let result = { ok: true, items: [], deals: [] };
    if (name === 'read-home-inbox-v5') result = snapshot(state.items.map(({ card_id, ...item }) => item), state.legacy);
    if (name === 'read-engine-home-card') result = { item_id: args.item_id, ...state.linkedDisposition };
    if (name === 'read-engine-home-proposal' && args.deal_id) {
      state.filingChecks.push(args);
      await state.waitForFilingCheck;
      result = {
        reason_required: Boolean(state.filingReasonHint) || (state.failFirstFilingCheck === true && state.filingChecks.length === 1),
        hint: state.filingReasonHint ?? null,
      };
    } else if (name === 'read-engine-home-proposal') result = {
      proposal_id: args.id, kind: args.id === id(41)
        ? (state.filingChoices ? 'possible_new_deal' : 'file_to_deal') : 'next_step',
      target_name: state.filingChoices && args.id === id(41) ? null : 'Example Dental',
      evidence: state.proposalEvidence ?? (args.id === id(41) ? 'The email names the suite.' : 'The manager needs the floor plan.'),
      reason: args.id === id(41) ? 'The email names the suite.' : 'The manager needs the floor plan.',
      what: args.id === id(42) ? state.proposalInstruction ?? 'Send the floor plan' : null,
      source_activity: mailSource, thread: state.thread,
      ...(args.id === id(41) && state.filingChoices && { filing_choices: state.filingChoices }),
    };
    if (name === 'deal-room-board') result = { deals: [{ id: id(61), name: 'Sample clinic' }] };
    if (name === 'decide-engine-home-proposal' && state.filingWrites) {
      state.filingWrites.push(args);
      if (state.filingReasonRequired && !args.reason) return route.fulfill({
        status: 422, json: { error: 'database_refused_the_statement', rule: 'proposal_filing_reason' },
      });
      state.items = state.items.filter(item => item.item_id !== mailCard.item_id);
      if (state.filingConflict) return route.fulfill({ status: 409, json: { error: 'already_decided' } });
      result = { proposal_id: args.id, status: args.decision === 'accept' ? 'accepted' : 'dismissed' };
    }
    if (name === 'read-engine-home-draft') result = {
      ...(args.id === state.otherDraft?.draft_id ? state.otherDraft : state.draft), to: 'sender@example.test', cc: 'partner@example.test', attachments: [],
      source_activity: state.draftSource ?? mailSource, thread: state.draftThread ?? state.thread,
    };
    if (name === 'edit-engine-home-draft') {
      state.draftWrites.push(args);
      assert.equal(args.id, state.draft.draft_id);
      if (args.version !== state.draft.version) result = { error: 'version_conflict', http_status: 409 };
      else {
        state.draft = { ...state.draft, version: args.version + 1, body: args.body, subject: args.subject };
        state.items = state.items.map(item => item.reply_draft_id === args.id
          ? { ...item, source_version: String(state.draft.version) } : item);
        result = state.draft;
      }
    }
    if (name === 'dismiss-engine-home-draft') {
      assert.equal(args.id, state.draft.draft_id);
      state.items = state.items.filter(item => item.reply_draft_id !== args.id);
      state.draft = { ...state.draft, version: args.version + 1, status: 'dismissed' };
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
    if (name === 'reopen-engine-home-step') {
      state.items = state.items.map(item => item.action_id === args.id
        ? { ...item, section: 'inbox', source_state: 'needs_attention', completed_at: null, action_version: 2 }
        : item);
      result = { next_step_id: args.id, status: 'open', change_id: 3 };
    }
    return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  return { page, open, state };
}

const mailSource = { kind: 'email', sender: 'sender@example.test', subject: 'Sample email',
  body: 'Quoted text outside the returned thread.', happened_at: '2026-11-03T02:00:00Z' };
const mailThread = [
  { activity_id: id(40), sender_name: 'Maya Example', happened_at: mailSource.happened_at, body: 'Can you send the plan?' },
  { activity_id: id(41), sender_name: 'Pat Example', happened_at: '2026-11-03T16:00:00Z', body: 'The east suite also works.' },
];
const mailSuggestions = [{ id: id(41) }, { id: id(42) }];
const mailCard = { ...step(40, 'Review the floor plan request'), item_id: `suggestion:${id(40)}`,
  source_type: 'email_proposal', kind_label: 'Suggestion', suggestions: mailSuggestions, card_id: 'conversation:2',
  action_id: null, action_version: null, open_url: null, deal_id: null, primary_action: null };

for (const grouped of [true, false]) test(`Home uses reported lateness on the ${grouped ? 'grouped' : 'fallback'} read`, async t => {
  const { page, open, state } = await dashboard(t, 390, 'light', 'UTC');
  state.dashboard = grouped;
  await page.clock.setSystemTime(new Date('2026-11-04T02:00:00Z'));
  state.items = [
    step(1, 'Send the signed lease', { card_id: 'lease', due_on: '2026-10-31', days_late: 3 }),
    step(3, 'Check in with the surveyor', { card_id: 'vendor', due_on: '2026-11-01', days_late: 2,
      deal_id: null, open_url: `/relationships?node=party:${id(90)}&step=${id(3)}` }),
    step(4, 'Review the completed site visit', { card_id: 'completion', due_on: '2026-11-02', days_late: 1,
      source_type: 'notification', source_id: id(44), merged_source_ids: [id(44)], action_id: null,
      why: 'A meeting note says the visit happened.', primary_action: 'Review completion',
      completion_review: { proposal_id: id(44), next_step_id: id(4), can_resolve: true } }),
    { ...mailCard, title: 'Review where to file the email', primary_action: 'Choose vendor', filing_choices: [vendorChoice] },
    step(2, 'Ask the surveyor for pricing', { card_id: 'pricing', due_on: '2026-11-02' }),
  ];
  await open('/?mode=live');
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const filing = reminders.getByRole('link', { name: 'Review where to file the email' });
  await filing.waitFor();
  assert.ok(await filing.evaluate(node => node.getBoundingClientRect().top >
    node.closest('.home-slice').querySelector('section[aria-label="Late"]').getBoundingClientRect().bottom), 'Late leads the tile');
  const late = reminders.getByRole('region', { name: 'Late', exact: true });
  assert.deepEqual(await late.locator('article h3').allTextContents(), [
    'Send the signed lease', 'Check in with the surveyor', 'Review the completed site visit',
  ]);
  for (const label of ['3 days late', '2 days late', '1 day late']) {
    assert.ok(await late.getByText(new RegExp(`${label}$`)).isVisible(), await reminders.innerText());
  }
});

for (const width of [390, 1440]) test(`Home review shows the whole next-step instruction at ${width}px`, async t => {
  const { page, open, state } = await dashboard(t, width, 'light');
  state.dashboard = true;
  state.items = [mailCard];
  state.proposalInstruction = 'Check the dimensions and send the revised floor plan to the practice manager. '.repeat(8).trim();
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();
  const field = page.getByRole('textbox', { name: 'Next step', exact: true });
  await field.waitFor();
  assert.equal(await field.inputValue(), state.proposalInstruction);
  assert.deepEqual(await field.evaluate(node => [
    node.scrollWidth <= node.clientWidth, node.scrollHeight <= node.clientHeight,
    node.clientHeight > 44,
  ]), [true, true, true]);
});

test('Home suggestion instructions submit on Enter and add a line on Shift+Enter', async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.dashboard = true;
  state.items = [mailCard];
  state.filingWrites = [];
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();
  const field = page.getByRole('textbox', { name: 'Next step', exact: true });
  await field.fill('Check the floor plan');
  await field.press('Shift+Enter');
  assert.equal(await field.inputValue(), 'Check the floor plan\n');
  assert.deepEqual(state.filingWrites, []);
  await field.press('S');
  await field.press('Enter');
  await field.waitFor({ state: 'hidden' });
  assert.deepEqual(state.filingWrites.map(({ decision, edits }) => ({ decision, edits })), [
    { decision: 'accept', edits: { what: 'Check the floor plan\nS', due_on: null } },
  ]);
});

for (const available of [true, false]) test(`Home email suggestions ${available ? 'share one thread' : 'hide a missing mailbox source'}`, async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.dashboard = true;
  state.items = [mailCard];
  if (!available) state.thread = [];
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();
  const review = page.getByRole('region', { name: `Details for ${mailCard.title}` });
  if (available) {
    const thread = review.getByRole('region', { name: 'Email thread' });
    await thread.waitFor();
    assert.deepEqual(await thread.locator('time').allTextContents(), ['Nov 2', 'Nov 3']);
    assert.match(await thread.innerText(), /From Maya · Nov 2[\s\S]+From Pat · Nov 3/);
    await thread.getByText(mailSource.subject, { exact: true }).waitFor();
    for (const message of mailThread) assert.equal(await review.getByText(message.body, { exact: true }).count(), 1);
  } else {
    await review.getByText('The original email is unavailable.', { exact: true }).waitFor();
    assert.equal(await review.getByText(mailSource.subject, { exact: true }).count(), 0);
  }
  await review.getByText('The email names the suite.', { exact: true }).waitFor();
  await review.getByText('The manager needs the floor plan.', { exact: true }).waitFor();
  assert.equal(await review.getByText(mailSource.body, { exact: true }).count(), 0);
  assert.equal(await review.getByRole('button', { name: 'Accept', exact: true }).count(), 2);
});

const dealChoice = { kind: 'deal', label: 'Choose deal' };
const vendorChoice = { kind: 'vendor', label: 'Choose vendor' };

for (const { name, choices, kind, focus, dismiss, reasonRefused, reasonRequired, filterDeals, retryCheck } of [
  { name: 'mixed choices file to a deal', choices: [dealChoice, vendorChoice], kind: 'deal' },
  { name: 'the deal picker keeps the selected deal while searching', choices: [dealChoice], kind: 'deal', filterDeals: true },
  { name: 'a required reason blocks the first save', choices: [dealChoice], kind: 'deal', reasonRequired: true },
  { name: 'an unavailable check keeps the chosen deal and allows retry', choices: [dealChoice], kind: 'deal', retryCheck: true },
  { name: 'a reason refusal keeps the chosen deal and allows retry', choices: [dealChoice], kind: 'deal', reasonRefused: true },
  { name: 'vendor-only choices file to a vendor', choices: [vendorChoice], kind: 'vendor' },
  { name: 'an already decided filing focuses the next card', choices: [vendorChoice], kind: 'vendor', focus: 'next' },
  { name: 'an already decided last filing focuses the previous card', choices: [vendorChoice], kind: 'vendor', focus: 'previous' },
  { name: 'a filing can be dismissed', choices: [dealChoice], dismiss: true },
  { name: 'an older filing keeps Accept', choices: undefined },
]) test(`Home filing: ${name}`, async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.dashboard = true;
  state.items = [{ ...mailCard, suggestions: [{ id: id(41) }], ...(choices && {
    filing_choices: choices, primary_action: choices.length === 1 ? choices[0].label : 'Review filing',
  }) }];
  state.filingChoices = choices;
  state.filingConflict = Boolean(focus);
  state.filingReasonRequired = reasonRequired || reasonRefused;
  state.failFirstFilingCheck = retryCheck;
  state.filingChecks = [];
  let finishFilingCheck;
  if (reasonRequired) {
    state.filingReasonHint = 'This email is already filed to another deal. Explain why you are moving it.';
    state.waitForFilingCheck = new Promise(resolve => { finishFilingCheck = resolve; });
  }
  state.filingWrites = [];
  const previous = step(63, 'Review the sample project', { card_id: 'project:63' });
  const next = step(64, 'Check the sample space', { card_id: 'project:64' });
  if (focus) state.items.unshift(previous);
  if (focus === 'next') state.items.push(next);
  await page.route('**/api/v1/business/vendors?**', route => route.fulfill({
    json: { rows: [{ id: id(62), name: 'Sample surveyors' }], page_count: 1 },
  }));
  await open('/?mode=live');
  const card = page.getByRole('link', { name: mailCard.title });
  if (choices) await page.getByRole('button', { name: 'Review filing', exact: true }).click();
  else await card.click();
  const review = page.getByRole('region', { name: `Details for ${mailCard.title}` });
  const filing = review.getByRole('region', { name: 'File this email' });
  await filing.waitFor();
  const expected = { id: id(41), decision: dismiss ? 'dismiss' : 'accept' };
  if (choices) {
    for (const choice of [dealChoice, vendorChoice]) {
      assert.equal(await filing.getByRole('button', { name: choice.label, exact: true }).count(),
        Number(choices.includes(choice)));
    }
    assert.equal(await filing.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
    if (dismiss) {
      await filing.getByRole('button', { name: 'Drop', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Drop with a reason' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Drop', exact: true }).isDisabled(), true);
      await dialog.getByRole('textbox', { name: 'Reason for dropping' }).fill('   ');
      assert.equal(await dialog.getByRole('button', { name: 'Drop', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual(state.filingWrites, []);
      await filing.getByRole('button', { name: 'Drop', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Drop with a reason' });
      await dialog.getByRole('textbox', { name: 'Reason for dropping' }).fill('  Not relevant  ');
      await dialog.getByRole('button', { name: 'Drop', exact: true }).click();
      expected.reason = 'Not relevant';
    }
    else {
      await filing.getByRole('button', { name: `Choose ${kind}` }).click();
      if (kind === 'vendor') {
        await filing.getByRole('searchbox', { name: 'Vendor name' }).fill('surveyors');
        const searched = page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'surveyors');
        await filing.getByRole('button', { name: 'Search vendors' }).click();
        await searched;
      }
      const destination = filing.getByRole('combobox', { name: kind === 'deal' ? /^(Deal|Selected deal)$/ : 'Vendor', exact: true });
      const label = kind === 'deal' ? 'Sample clinic' : 'Sample surveyors';
      await destination.selectOption({ label });
      if (filterDeals) {
        await filing.getByRole('searchbox', { name: /Deal name|Search existing deals/ }).fill('other practice');
        assert.equal(await destination.inputValue(), id(61));
      }
      const file = filing.getByRole('button', { name: 'File email' });
      assert.deepEqual(state.filingWrites, []);
      if (kind === 'deal') {
        if (reasonRequired) {
          await filing.getByRole('status').getByText('Checking filing requirements…').waitFor();
          assert.equal(await file.isDisabled(), true);
          finishFilingCheck();
        }
        if (retryCheck) {
          const retry = filing.getByRole('button', { name: 'Retry', exact: true });
          await retry.waitFor();
          assert.equal(await file.isDisabled(), true);
          assert.equal(await destination.inputValue(), id(61));
          assert.deepEqual(state.filingWrites, []);
          await retry.click();
        }
        if (reasonRefused) {
          const reason = filing.getByRole('textbox', { name: /Reason/ });
          assert.equal(await reason.getAttribute('aria-required'), null);
          await file.click();
          const refusal = filing.getByRole('alert');
          await refusal.waitFor();
          assert.equal(await refusal.textContent(),
            "This email isn't linked to that deal yet. Add a short reason to file it there.");
          await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
          assert.equal(await reason.getAttribute('aria-required'), 'true');
          assert.equal(await file.isDisabled(), true);
          assert.equal(await destination.inputValue(), id(61));
          const [{ idempotency_key, ...first }] = state.filingWrites;
          assert.deepEqual(first, { ...expected, deal_id: id(61) });
        }
        const reason = filing.getByRole('textbox', { name: 'Reason for filing', exact: true });
        await reason.waitFor();
        const check = { id: id(41), deal_id: id(61) };
        assert.deepEqual(state.filingChecks, retryCheck ? [check, check] : [check]);
        assert.equal(await reason.getAttribute('aria-required'), reasonRequired || reasonRefused ? 'true' : null);
        if (reasonRequired) {
          await filing.getByText(state.filingReasonHint, { exact: true }).waitFor();
          assert.equal(await file.isDisabled(), true);
          assert.deepEqual(state.filingWrites, []);
        }
        if (reasonRequired || reasonRefused) {
          expected.reason = 'This email is about the sample clinic.';
          await reason.fill(expected.reason);
        }
      }
      await file.click();
      expected[`${kind}_id`] = kind === 'deal' ? id(61) : id(62);
    }
  } else {
    assert.equal(await filing.getByRole('button', { name: /^Choose / }).count(), 0);
    await filing.getByRole('button', { name: 'Accept', exact: true }).click();
  }
  await card.waitFor({ state: 'hidden' });
  await review.waitFor({ state: 'hidden' });
  assert.equal(state.filingWrites.length, reasonRefused ? 2 : 1);
  const { idempotency_key, ...request } = state.filingWrites.at(-1);
  assert.match(idempotency_key, /^[a-f0-9-]{36}$/);
  assert.deepEqual(request, expected);
  if (focus) {
    const target = page.getByRole('link', { name: (focus === 'next' ? next : previous).title });
    assert.equal(await target.evaluate(node => node === document.activeElement), true);
  }
});

for (const width of [390, 1440]) test(`Home preserves authored lines and empty message disclosures at ${width}px`, async t => {
  const { page, open, state } = await dashboard(t, width, 'light');
  state.dashboard = true;
  state.items = [mailCard];
  state.thread = [
    { ...mailThread[0], body: 'First line\nSecond line\n\nA postscript.', folded: null },
    { ...mailThread[1], body: '', folded: '' },
    { ...mailThread[1], activity_id: id(43), body: '', folded: 'Earlier conversation.' },
  ];
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();
  const thread = page.getByRole('region', { name: 'Email thread' });
  await thread.waitFor();
  const articles = thread.getByRole('article');
  assert.equal(await articles.count(), 3);
  const body = articles.nth(0).getByText('First line', { exact: false });
  assert.equal(await body.innerText(), state.thread[0].body);
  assert.equal(await body.evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
  assert.equal(await articles.nth(0).getByRole('button').count(), 0);
  assert.match(await articles.nth(1).innerText(), /From Pat · Nov 3/);
  const toggle = articles.nth(1).getByRole('button', { name: 'Show earlier text' });
  assert.equal(await toggle.isVisible(), true);
  await toggle.click();
  assert.equal(await articles.nth(1).getByRole('button', { name: 'Hide earlier text' }).getAttribute('aria-expanded'), 'true');
  const earlier = articles.nth(2);
  await earlier.getByRole('button', { name: 'Show earlier text' }).click();
  assert.equal(await earlier.getByText('Earlier conversation.').isVisible(), true);
});

test('Home reveals earlier text only for the selected email message', async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  const earlier = ['Can we use the east entrance?\n\nPat Example', 'The sample suite is open.'];
  state.dashboard = true;
  state.items = [mailCard];
  state.thread = [
    ...mailThread.map((message, index) => ({ ...message, folded: earlier[index] })),
    { ...mailThread[1], activity_id: id(43), body: 'This message has nothing folded.', folded: null },
    { ...mailThread[1], activity_id: id(44), body: 'This message uses the old response.' },
  ];
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();

  const thread = page.getByRole('region', { name: 'Email thread' });
  await thread.waitFor();
  const [first, second, noFold, legacy] = await thread.getByRole('article').all();
  for (const [index, article] of [first, second, noFold, legacy].entries()) {
    assert.equal(await article.getByText(state.thread[index].body, { exact: true }).isVisible(), true);
  }
  assert.deepEqual(await legacy.getByRole('paragraph').allTextContents(), [state.thread[3].body]);
  assert.equal(await noFold.getByRole('button').count(), 0);
  assert.equal(await legacy.getByRole('button').count(), 0);

  const firstToggle = first.getByRole('button', { name: /earlier text/ });
  const secondToggle = second.getByRole('button', { name: /earlier text/ });
  assert.equal(await thread.getByRole('button', { name: 'Show earlier text', exact: true }).count(), 2);
  const firstText = first.getByText('Can we use the east entrance?', { exact: false });
  const secondText = second.getByText(earlier[1], { exact: true });
  assert.equal(await firstText.isVisible(), false);
  assert.equal(await firstToggle.getAttribute('aria-expanded'), 'false');

  await firstToggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await firstToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await first.getByRole('button', { name: 'Hide earlier text', exact: true }).isVisible(), true);
  assert.equal(await firstText.innerText(), earlier[0]);
  assert.equal(await firstText.evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
  assert.equal(await secondToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await secondText.isVisible(), false);

  await secondToggle.click();
  assert.equal(await secondText.isVisible(), true);
  assert.equal(await firstText.isVisible(), true);
  await firstToggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await firstToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await first.getByRole('button', { name: 'Show earlier text', exact: true }).isVisible(), true);
  assert.equal(await firstText.isVisible(), false);
  assert.equal(await secondText.isVisible(), true);
});

for (const width of [390, 1280, 1440]) test(`Home names the person the reply answers above the draft at ${width}px`, async t => {
  const { page, open, state } = await dashboard(t, width, 'light');
  const draft = { ...draftCard(), title: 'Review the reply to Pat Example' };
  state.dashboard = true;
  state.items = [draft];
  state.draftSource = { ...mailSource, id: mailThread[1].activity_id };
  await open('/?mode=live');
  await page.getByRole('link', { name: draft.title }).click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  const thread = review.getByRole('region', { name: 'Email thread' });
  assert.deepEqual(await thread.getByRole('heading', { level: 5 }).allTextContents(), ['From Maya · Nov 2', 'From Pat · Nov 3']);
  assert.equal(await review.getByText('Your reply to Pat', { exact: true }).isVisible(), true);
  if (process.env.HOME_THREAD_SCREENSHOTS) {
    await mkdir(process.env.HOME_THREAD_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.HOME_THREAD_SCREENSHOTS, `reply-to-${width}.png`), fullPage: true });
  }
});

test('Home separates Your reply from the email thread', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'dark');
  const draft = draftCard();
  state.dashboard = true;
  state.items = [draft];
  await open('/?mode=live');
  await page.getByRole('link', { name: draft.title }).click();

  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  const thread = review.getByRole('region', { name: 'Email thread' });
  const label = review.getByText('Your reply', { exact: true });
  assert.equal(await label.isVisible(), true);
  assert.equal(await thread.getByText(state.draft.body, { exact: true }).count(), 0);
  assert.equal(await review.getByText(state.draft.body, { exact: true }).isVisible(), true);
  assert.ok((await label.boundingBox()).y > (await thread.boundingBox()).y + (await thread.boundingBox()).height);
  assert.equal(await label.evaluate(node => getComputedStyle(node).borderTopWidth), '1px');
});

for (const draftHasMail of [false, true]) test(`Home combines a draft with its proposal threads when draft mail is ${draftHasMail ? 'partial' : 'missing'}`, async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  const draft = { ...draftCard(), suggestions: mailSuggestions };
  const extra = { ...mailThread[0], activity_id: id(43), happened_at: '2026-11-02T16:00:00Z', body: 'The draft source.' };
  state.dashboard = true;
  state.items = [draft];
  state.draftThread = draftHasMail ? [mailThread[1], extra] : [];
  await open('/?mode=live');
  await page.getByRole('link', { name: draft.title }).click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  const thread = review.getByRole('region', { name: 'Email thread' });
  assert.equal(await thread.count(), 1);
  const expected = draftHasMail ? [extra, ...mailThread] : mailThread;
  assert.deepEqual(await thread.getByRole('paragraph').allTextContents(), [mailSource.subject, ...expected.map(row => row.body)]);
  assert.equal(await review.getByText('The original email is unavailable.', { exact: true }).count(), 0);
});

test('Home shows the email once and keeps the reasons and targets of its suggestions', async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.dashboard = true;
  state.items = [mailCard];
  state.proposalEvidence = 'From: maya@example.test\n' + mailThread[0].body;
  await open('/?mode=live');
  await page.getByRole('link', { name: mailCard.title }).click();
  const review = page.getByRole('region', { name: `Details for ${mailCard.title}` });
  await review.getByRole('heading', { name: 'File this email · Example Dental' }).waitFor();
  assert.equal(await review.getByText(mailThread[0].body).count(), 1);
  assert.equal(await review.getByText('From: maya@example.test', { exact: false }).count(), 0);
  await review.getByText('The email names the suite.', { exact: true }).waitFor();
  await review.getByText('The manager needs the floor plan.', { exact: true }).waitFor();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home draft Edit saves once at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  const draft = { ...draftCard(), suggestions: mailSuggestions };
  state.dashboard = true;
  state.items = [draft];
  await open('/?mode=live');
  const background = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);
  const opener = page.getByRole('button', { name: 'Review reply', exact: true });
  const accent = await background(opener);
  await page.getByRole('link', { name: draft.title }).click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  const edit = review.getByRole('button', { name: 'Edit', exact: true });
  await edit.waitFor();
  assert.equal(await background(review.getByRole('button', { name: 'Send reply', exact: true })), accent, 'Send reply is the primary button');
  assert.notEqual(await background(opener), accent, 'the open card gives the primary look to Send reply');
  const primaries = await page.getByRole('button').evaluateAll((nodes, accent) =>
    nodes.filter(node => getComputedStyle(node).backgroundColor === accent).map(node => node.textContent), accent);
  assert.deepEqual(primaries, ['Send reply'], 'one primary button in view');
  assert.equal(await review.getByRole('textbox', { name: 'Message' }).count(), 0);
  assert.equal(await review.getByText('First draft.', { exact: true }).count(), 1);
  assert.equal(await review.getByText('Current saved reply').count(), 0);
  for (const message of mailThread) assert.equal(await review.getByText(message.body, { exact: true }).count(), 1);
  assert.equal(await review.getByText(mailSource.body, { exact: true }).count(), 0);
  if (process.env.HOME_THREAD_SCREENSHOTS) {
    await mkdir(process.env.HOME_THREAD_SCREENSHOTS, { recursive: true });
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({ path: join(process.env.HOME_THREAD_SCREENSHOTS, `reply-${width}-${theme}.png`), fullPage: true });
  }
  await edit.click();
  const subject = review.getByRole('textbox', { name: 'Subject', exact: true });
  assert.equal(await subject.evaluate(node => node === document.activeElement), true);
  await subject.fill('Updated sample subject');
  await review.getByRole('textbox', { name: 'Message' }).fill('Edited sample draft.');
  await review.getByRole('button', { name: 'Save draft' }).click();
  await review.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(await review.getByText('Edited sample draft.', { exact: true }).count(), 1);
  assert.equal(await review.getByRole('textbox', { name: 'Message' }).count(), 0);
  assert.equal(state.draftWrites.length, 1);
  assert.equal(state.draftWrites[0].version, 1);
  assert.equal(state.draft.subject, 'Updated sample subject');
  assert.equal(state.draft.body, 'Edited sample draft.');
});

for (const width of [390, 1440]) test(`Home keeps other cards usable while a review is open at ${width}px`, async t => {
  const { page, open, state } = await dashboard(t, width, 'light');
  const draft = draftCard();
  const other = step(30, 'Call the practice manager', { card_id: 'other' });
  const swiped = step(31, 'Ask the surveyor for pricing', { card_id: 'swiped' });
  state.dashboard = true;
  state.items = [draft, other, swiped];
  await open('/?mode=live');
  await page.getByRole('link', { name: draft.title }).click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  const card = title => page.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: title }) });
  const button = (title, name) => card(title).locator(':scope > .inbox-actions').getByRole('button', { name, exact: true });
  for (const name of ['Snooze', 'Drop']) assert.equal(await button(draft.title, name).isDisabled(), true, `the card under review keeps ${name} locked`);
  if (process.env.HOME_THREAD_SCREENSHOTS) {
    await mkdir(process.env.HOME_THREAD_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.HOME_THREAD_SCREENSHOTS, `review-open-${width}.png`), fullPage: true });
  }
  for (const name of ['Snooze', 'Drop', 'Mark done']) assert.equal(await button(other.title, name).isDisabled(), false, name);
  await button(other.title, 'Snooze').click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('status').filter({ hasText: `Snoozed: ${other.title}.` }).waitFor();
  await card(swiped.title).evaluate(node => {
    const touch = x => new Touch({ identifier: 1, target: node, clientX: x, clientY: 100 });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(300)] }));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(180)] }));
  });
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('status').filter({ hasText: `Snoozed: ${swiped.title}.` }).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Send reply', exact: true }).isVisible(), true, 'the review stays open');
});

test('Inbox keeps Undo on another finished card usable while a review is open', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const finished = step(32, 'Send the sample brochure', {
    section: 'done', source_state: 'done', completed_at: now.toISOString(), undo_completion: true,
  });
  state.items = [draft, finished];
  await open('/inbox?mode=live');
  await page.getByRole('button', { name: 'Review reply', exact: true }).click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  await page.locator('summary').filter({ hasText: 'Done' }).click();
  const undo = page.locator(`[data-inbox-row="${finished.item_id}"]`).getByRole('button', { name: 'Undo', exact: true });
  assert.equal(await undo.isDisabled(), false, 'Undo stays usable on another card');
  await undo.click();
  await page.locator('.toast').getByText('Undone.', { exact: true }).waitFor();
  await page.locator(`section[aria-label="Inbox"] [data-inbox-row="${finished.item_id}"]`).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Send reply', exact: true }).isVisible(), true, 'the review stays open');
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home shows a stale edit alongside the saved draft at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  const draft = draftCard();
  state.dashboard = true;
  state.items = [draft];
  await open('/?mode=live');
  const title = page.getByRole('link', { name: draft.title });
  await title.click();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  const edit = review.getByRole('button', { name: 'Edit', exact: true });
  const send = review.getByRole('button', { name: 'Send reply', exact: true });
  await edit.click();
  const message = review.getByRole('textbox', { name: 'Message' });
  const subject = review.getByRole('textbox', { name: 'Subject' });
  await subject.fill('My sample subject');
  await message.fill('Keep this local edit.');
  Object.assign(state.draft, { version: 2, subject: 'New saved subject', body: 'Saved somewhere else.' });
  state.items = [{ ...draft, source_version: '2' }];
  const save = review.getByRole('button', { name: 'Save draft' });
  const close = review.getByRole('button', { name: 'Close review' });
  if (width === 390) {
    await save.click();
    await review.getByRole('alert').filter({ hasText: 'Your edits are kept.' }).waitFor();
    assert.equal(await message.inputValue(), 'Keep this local edit.');
    assert.equal(await save.isDisabled(), true);
    await review.getByRole('button', { name: 'Review updated card' }).click();
    await review.getByText(/Updated evidence loaded/).waitFor();
  } else {
    await close.click();
    await title.click();
    await send.waitFor();
  }

  assert.equal(await send.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  await review.getByText('New saved subject', { exact: true }).waitFor();
  await review.getByText('Saved somewhere else.', { exact: true }).waitFor();
  const unsaved = review.getByRole('region', { name: 'Your unsaved edit' });
  await unsaved.getByText('My sample subject', { exact: true }).waitFor();
  await unsaved.getByText('Keep this local edit.', { exact: true }).waitFor();
  assert.equal(await message.count(), 0);
  const attemptedVersions = width === 390 ? [1] : [];
  assert.deepEqual(state.draftWrites.map(write => write.version), attemptedVersions);

  if (process.env.HOME_THREAD_SCREENSHOTS) {
    await mkdir(process.env.HOME_THREAD_SCREENSHOTS, { recursive: true });
    if (width === 390) await unsaved.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.HOME_THREAD_SCREENSHOTS, `stale-reply-${width}-${theme}.png`), fullPage: width !== 390 });
  }

  if (theme === 'dark') {
    await unsaved.getByRole('button', { name: 'Discard' }).click();
    await edit.waitFor();
    assert.equal(await send.isEnabled(), true);
    assert.equal(await unsaved.count(), 0);
    await close.click();
    await title.click();
    await edit.click();
    assert.equal(await subject.inputValue(), 'New saved subject');
    assert.equal(await message.inputValue(), 'Saved somewhere else.');
    assert.deepEqual(state.draftWrites.map(write => write.version), attemptedVersions);
    return;
  }

  await unsaved.getByRole('button', { name: 'Use my edit' }).click();
  assert.equal(await subject.inputValue(), 'My sample subject');
  assert.equal(await message.inputValue(), 'Keep this local edit.');
  assert.equal(await send.isEnabled(), true);
  await close.click();
  await title.click();
  assert.equal(await message.inputValue(), 'Keep this local edit.');
  await save.click();
  await review.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.deepEqual(state.draftWrites.map(write => write.version), [...attemptedVersions, 2]);
  assert.equal(state.draft.body, 'Keep this local edit.');
});

test('Home uses the flat inbox when the older engine refuses the dashboard view', async t => {
  const { page, open, state } = await dashboard(t, 390, 'light');
  state.oldEngine = true;
  await open('/?mode=live');
  await page.getByRole('region', { name: 'Reminders', exact: true }).getByRole('link', { name: 'Send the signed lease' }).waitFor();
});

for (const width of [390, 1440]) {
  test(`Home shows all 90 characters of an action on the first card view at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    const title = 'Send the revised floor plan to the practice manager before the lease review next Thursday.';
    state.oldEngine = true;
    state.items[0] = step(1, title);
    await open('/?mode=live');
    const heading = page.getByRole('region', { name: 'Reminders', exact: true })
      .getByRole('heading', { level: 3, name: title, exact: true });
    await heading.waitFor();
    assert.deepEqual(await heading.evaluate(node => {
      const style = getComputedStyle(node);
      const textFits = node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth;
      return { lineClamp: style.webkitLineClamp, textOverflow: style.textOverflow, textFits };
    }), { lineClamp: 'none', textOverflow: 'clip', textFits: true });
  });

  test(`Home explains when a legacy next step failed at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    state.oldEngine = true;
    state.legacy = true;
    state.items = ['Floor plan failed to send', 'Failed to save the floor plan']
      .map((title, index) => step(index + 1, title, { source_state: 'failed' }));
    await open('/?mode=live');
    for (const item of state.items) {
      const title = page.getByRole('heading', { level: 3, name: item.title, exact: true });
      await title.waitFor();
      const card = page.locator('[data-inbox-row]').filter({ has: title });
      assert.deepEqual({
        cue: await card.getByText("Didn't go through", { exact: true }).isVisible(),
        detail: await card.getByText('Open the card to review the failed action.', { exact: true }).isVisible(),
        genericDetail: await card.getByText('Ready for your attention', { exact: true }).isVisible(),
      }, { cue: true, detail: true, genericDetail: false }, item.title);
    }
  });

  test(`Home identifies a subject-only legacy reply as a draft at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    state.oldEngine = true;
    state.legacy = true;
    const draft = step(20, 'Floor plan', {
      item_id: `email_proposal:${id(20)}`, source_type: 'email_proposal', kind_label: 'Reply draft',
      action_id: null, action_version: null, open_url: null, deal_id: null,
    });
    state.items = [draft];
    await open('/?mode=live');
    const title = page.getByRole('heading', { level: 3, name: draft.title, exact: true });
    await title.waitFor();
    const card = page.locator('[data-inbox-row]').filter({ has: title });
    assert.equal(await card.getByText('Draft ready', { exact: true }).isVisible(), true);
  });

  test(`Home shows the draft cue when the title asks for reply review at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    state.dashboard = true;
    const draft = { ...draftCard(), title: 'Review the reply to the practice manager', primary_action: 'Review reply' };
    state.items = [draft];
    await open('/?mode=live');
    const title = page.getByRole('heading', { level: 3, name: draft.title, exact: true });
    await title.waitFor();
    const card = page.locator('[data-inbox-row]').filter({ has: title });
    assert.equal(await card.getByText('Draft ready', { exact: true }).isVisible(), true);
  });

  test(`Home leaves the type label and cues off an ordinary action card at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    state.dashboard = true;
    state.items = [{ ...mailCard, primary_action: 'Review suggestions' }];
    await open('/?mode=live');
    const action = page.getByRole('heading', { level: 3, name: mailCard.title, exact: true });
    await action.waitFor();
    const card = page.locator('[data-inbox-row]').filter({ has: action });
    assert.equal(await card.getByText(mailCard.kind_label, { exact: true }).isVisible(), false);
    assert.equal(await card.getByText(/^(?:Draft ready|Didn't go through)$/).count(), 0);
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home dashboard at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  const extra = [step(10, 'Review the draft site plan'), step(11, 'Confirm the tour address')];
  state.items.push(...extra);
  let meetingItems = [scheduledMeeting];
  await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', today: '2026-11-03', viewer: 'joe',
    meetings: { state: meetingItems.length ? 'ready' : 'empty', items: meetingItems },
  } }));
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
  const meetings = tile("Today's meetings");
  await reminders.getByRole('heading', { name: 'Reminders 6' }).waitFor();
  await waiting.getByRole('heading', { name: 'In motion and waiting 1' }).waitFor();
  await meetings.getByRole('heading', { name: "Today's meetings 1" }).waitFor();
  if (process.env.HOME_GRID_SCREENSHOTS) {
    await mkdir(process.env.HOME_GRID_SCREENSHOTS, { recursive: true });
    const viewport = page.viewportSize();
    if (width === 390) await page.setViewportSize({ width, height: 1400 });
    await page.screenshot({ path: join(process.env.HOME_GRID_SCREENSHOTS, `home-${width}-${theme}.png`), fullPage: true });
    if (width === 390) await page.setViewportSize(viewport);
  }
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
  const [first, second, third] = await Promise.all([reminders, waiting, meetings].map(tile => tile.boundingBox()));
  if (width === 390) {
    assert.equal(first.x, second.x);
    assert.ok(second.y >= first.y + first.height);
    assert.equal(third.x, second.x);
    assert.ok(third.y >= second.y + second.height);
  } else {
    assert.equal(first.y, second.y);
    assert.ok(second.x >= first.x + first.width);
    assert.ok(first.width > 1.8 * second.width, 'Reminders takes the wide column');
    assert.equal(third.x, second.x);
    assert.ok(third.y >= second.y + second.height, 'the other tiles stack beside Reminders');
    const bar = await page.locator('.app-layout-topbar').boundingBox();
    assert.ok(second.y >= bar.y + bar.height, 'the top bar never covers the In motion and waiting title');
    assert.equal(await page.evaluate(() => [document.scrollingElement, document.getElementById('appMainSlot')].every(node => node.scrollHeight <= node.clientHeight)), true, 'the page itself does not scroll');
  }
  await reminders.getByRole('heading', { name: 'Late', exact: true }).waitFor();
  await reminders.getByText(/3 days late/).waitFor();
  assert.equal(await page.getByText(/Call the (new|snoozed) prospect|Follow up next week|Send the earlier note/).count(), 0);
  const wake = waiting.getByRole('button', { name: 'Wake', exact: true });
  await wake.waitFor();
  await waiting.getByText(/Snoozed until/).waitFor();
  const lease = reminders.getByRole('link', { name: 'Send the signed lease' });
  assert.match(await lease.getAttribute('href'), /focus=next-step&step=/);
  const preview = reminders.locator('[data-inbox-row]');
  const sixth = reminders.getByRole('link', { name: extra[1].title });
  assert.equal(await preview.count(), 5);
  assert.equal(await sixth.count(), 0);
  await reminders.getByRole('button', { name: 'See all 6' }).click();
  assert.equal(await preview.count(), 6);
  await sixth.waitFor();
  await reminders.getByRole('button', { name: 'Show less' }).click();
  await sixth.waitFor({ state: 'detached' });
  await reminders.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: 'Send the signed lease' }) }).getByRole('button', { name: 'Mark done' }).click();
  await lease.waitFor({ state: 'detached' });
  await reminders.getByRole('heading', { name: 'Late', exact: true }).waitFor({ state: 'detached' });
  await reminders.getByRole('heading', { name: 'Reminders 5' }).waitFor();
  assert.equal(await reminders.getByRole('button', { name: /^See all/ }).count(), 0);
  state.unavailable = true;
  await page.clock.fastForward(60_000);
  await page.getByText('Reminders and waiting items unavailable.', { exact: true }).waitFor();
  assert.equal(await reminders.getByRole('heading', { name: 'Reminders 5' }).count(), 1);
  state.unavailable = false;
  state.items = [];
  meetingItems = [];
  await page.clock.fastForward(60_000);
  await reminders.waitFor({ state: 'detached' });
  await waiting.waitFor({ state: 'detached' });
  await meetings.waitFor({ state: 'detached' });
});

for (const [width, height] of [[1280, 800], [1440, 900]]) for (const theme of ['light', 'dark']) test(`Home fits one screen with Reminders alone at ${width}x${height} in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  await page.setViewportSize({ width, height });
  state.items = [
    ...state.items.filter(item => item.section === 'inbox'),
    ...Array.from({ length: 8 }, (_, index) => step(70 + index, `Check the sample document ${index + 1}`)),
  ];
  await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', today: '2026-11-03', viewer: 'joe',
    meetings: { state: 'partial', items: [], observed_at: '2026-11-03T14:00:00Z' },
  } }));
  await page.clock.install({ time: now });
  await open('/?mode=live');
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const status = page.getByText(/^Last synced/);
  await status.waitFor();
  await reminders.getByRole('button', { name: /^See all/ }).click();
  if (process.env.HOME_GRID_SCREENSHOTS) {
    await mkdir(process.env.HOME_GRID_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.HOME_GRID_SCREENSHOTS, `home-alone-${width}x${height}-${theme}.png`) });
  }
  const [tile, grid, band] = await Promise.all([reminders, page.locator('.home-sections'), page.locator('.app-layout-topbar')]
    .map(node => node.boundingBox()));
  assert.equal(tile.width, grid.width, 'a lone Reminders tile fills the row');
  assert.ok(band.y + band.height <= 60, 'the page controls take one compact band');
  assert.ok(tile.y >= band.y + band.height, 'the top bar never covers the tile title');
  assert.deepEqual(await page.evaluate(() => [document.scrollingElement, document.getElementById('appMainSlot')].every(node => node.scrollHeight <= node.clientHeight)), true, 'the page itself does not scroll');
  assert.deepEqual(await reminders.evaluate(node => node.scrollHeight > node.clientHeight), true, 'the long list scrolls inside its tile');
  await reminders.getByRole('heading', { name: /^Reminders/ }).waitFor();
});

const draftCard = () => ({
  ...step(20, 'Reply to the practice manager'), item_id: `reply_draft:${id(20)}`,
  source_type: 'email_proposal', reply_draft_id: id(20), reply_draft_status: 'pending', kind_label: 'Reply draft',
  action_id: null, action_version: null, due_on: null, open_url: null, deal_id: null, card_id: 'conversation:1',
  primary_action: null,
});

test('Home restores reply edits after Back and reload and compares a newer revision', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const otherDraft = {
    ...draft, item_id: `reply_draft:${id(21)}`, source_id: id(21), reply_draft_id: id(21), title: 'Reply to a different email',
    card_id: 'conversation:2',
  };
  state.dashboard = true;
  state.items = [draft, otherDraft];
  state.otherDraft = { ...state.draft, draft_id: id(21), body: 'Different saved draft.' };
  await open('/?mode=live');
  const title = page.getByRole('link', { name: draft.title });
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  const subject = review.getByRole('textbox', { name: 'Subject', exact: true });
  const message = review.getByRole('textbox', { name: 'Message', exact: true });

  await title.click();
  await review.getByRole('button', { name: 'Edit', exact: true }).click();
  await subject.fill('My sample subject');
  await message.fill('Keep this local edit.');
  await review.getByRole('button', { name: 'Close review' }).click();
  await page.getByRole('link', { name: otherDraft.title }).click();
  const otherReview = page.getByRole('region', { name: `Details for ${otherDraft.title}` });
  await otherReview.getByText('Different saved draft.', { exact: true }).waitFor();
  assert.equal(await otherReview.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  await otherReview.getByRole('button', { name: 'Close review' }).click();
  await title.click();
  await subject.waitFor();
  assert.equal(await subject.inputValue(), 'My sample subject');
  assert.equal(await message.inputValue(), 'Keep this local edit.');

  await page.reload();
  await title.click();
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  assert.equal(await subject.count(), 1, 'Reload should reopen the editor');
  assert.equal(await subject.inputValue(), 'My sample subject');
  assert.equal(await message.inputValue(), 'Keep this local edit.');

  Object.assign(state.draft, { version: 2, subject: 'New saved subject', body: 'Saved somewhere else.' });
  state.items = [{ ...draft, source_version: '2' }];
  await page.reload();
  await title.click();
  await review.getByText('New saved subject', { exact: true }).waitFor();
  const unsaved = review.getByRole('region', { name: 'Your unsaved edit' });
  assert.equal(await unsaved.getByText('My sample subject', { exact: true }).count(), 1);
  assert.equal(await unsaved.getByText('Keep this local edit.', { exact: true }).count(), 1);
  assert.equal(await message.count(), 0);
  assert.deepEqual(state.draftWrites, []);
});

function sessionHasReplyEdit(page, text) {
  return page.evaluate(value => Object.values(sessionStorage).some(entry => entry.includes(value)), text);
}

for (const event of ['sign-out', 'partner change', 'drop']) test(`Home clears reply edits on ${event}`, async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const localEdit = 'My private sample reply.';
  let actor = 'joe';
  state.dashboard = true;
  state.items = [draft];
  await page.route('**/auth/session', route => route.fulfill({
    status: actor ? 200 : 401,
    headers: { 'x-doctorcre-partner-sign-in': 'engine' },
    json: actor ? { actor: { slug: actor }, csrf_token: `synthetic-${actor}` } : {},
  }));
  await page.route('**/auth/signout', route => {
    actor = null;
    return route.fulfill({ status: 302, headers: { location: '/' } });
  });

  await open('/?mode=live');
  const title = page.getByRole('link', { name: draft.title });
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await title.click();
  await review.getByRole('button', { name: 'Edit', exact: true }).click();
  await review.getByRole('textbox', { name: 'Message', exact: true }).fill(localEdit);
  assert.equal(await sessionHasReplyEdit(page, localEdit), true);

  if (event === 'drop') {
    await review.getByRole('button', { name: 'Close review' }).click();
    await page.locator('[data-inbox-row]').filter({ hasText: draft.title }).getByRole('button', { name: 'Drop', exact: true }).click();
    const reason = page.getByRole('dialog', { name: 'Drop with a reason' });
    await reason.getByRole('textbox', { name: 'Reason for dropping' }).fill('Handled elsewhere');
    await reason.getByRole('button', { name: 'Drop', exact: true }).click();
    await title.waitFor({ state: 'detached' });
    assert.equal(state.draft.status, 'dismissed');
  } else if (event === 'sign-out') {
    await page.locator('#selfAvatar').click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/public-shell/session-ended.html');
  } else {
    actor = 'dell';
    await page.reload();
    await title.click();
    await review.getByText('First draft.', { exact: true }).waitFor();
    assert.equal(await review.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  }
  assert.equal(await sessionHasReplyEdit(page, localEdit), false);
});

test('Home skips edits from a retired session when the same partner signs back in elsewhere', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const edit = 'Sample edit from the retired session.';
  state.dashboard = true;
  state.items = [draft];
  let signedIn = true;
  const auth = route => route.fulfill({
    status: signedIn ? 200 : 401,
    headers: { 'x-doctorcre-partner-sign-in': 'engine' },
    json: signedIn ? { actor: { slug: 'joe' }, csrf_token: 'synthetic' } : {},
  });
  await page.route('**/auth/session', auth);
  await open('/?mode=live');
  const home = page.url();
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await page.getByRole('link', { name: draft.title }).click();
  await review.getByRole('button', { name: 'Edit', exact: true }).click();
  await review.getByRole('textbox', { name: 'Message', exact: true }).fill(edit);
  await open('/public-shell/session-ended.html');

  const otherTab = await page.context().newPage();
  await otherTab.route('**/auth/session', auth);
  await otherTab.route('**/auth/signout', route => {
    signedIn = false;
    return route.fulfill({ status: 302, headers: { location: '/' } });
  });
  await otherTab.goto(home);
  await otherTab.locator('#selfAvatar').click();
  await otherTab.getByRole('button', { name: 'Sign out', exact: true }).click();
  await otherTab.waitForURL('**/public-shell/session-ended.html');
  signedIn = true;
  await otherTab.goto(home);
  await otherTab.evaluate(async () => {
    const { privateSession } = await import('/js/private-session.js');
    await privateSession().verify();
  });
  assert.equal(await sessionHasReplyEdit(page, edit), true, 'The inactive tab missed the storage event');

  await page.goto(home);
  await page.getByRole('link', { name: draft.title }).click();
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  assert.equal(await review.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  assert.equal(await review.getByText('First draft.', { exact: true }).count(), 1);
});

test('Home evicts the old reply edit when browser storage rejects its replacement', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  state.dashboard = true;
  state.items = [draft];
  await open('/?mode=live');
  const title = page.getByRole('link', { name: draft.title });
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  const message = review.getByRole('textbox', { name: 'Message', exact: true });
  await title.click();
  await review.getByRole('button', { name: 'Edit', exact: true }).click();
  await message.fill('First local edit.');
  assert.equal(await sessionHasReplyEdit(page, 'First local edit.'), true);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && value.includes('Latest local edit.')) throw new DOMException('Full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await message.fill('Latest local edit.');
  await review.getByRole('button', { name: 'Close review' }).click();
  await title.click();
  assert.equal(await message.inputValue(), 'Latest local edit.');
  await page.reload();
  await title.click();
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  assert.equal(await message.count(), 0, 'A failed write must not restore older text after reload');
  assert.equal(await review.getByText('First draft.', { exact: true }).count(), 1);
});

for (const width of [390, 1440]) test(`Home links open exact mailbox reviews without loading the inbox at ${width}px`, async t => {
  const { page, open, state } = await dashboard(t, width, 'light');
  const draft = { ...draftCard(), suggestions: [{ id: id(43) }] };
  const suggestion = { ...mailCard, source_id: id(41), item_id: `suggestion:${id(41)}` };
  const writes = [];
  const listReads = [];
  let cardRouteAvailable = true;
  async function signIn(page, partner) {
    await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: partner }, csrf_token: 'synthetic' } }));
    await page.route('**/mcp', async route => {
      const request = route.request();
      const name = request.postDataJSON()?.params?.name;
      if (name?.startsWith('read-home-inbox-')) listReads.push(name);
      if (!name?.includes('engine-home-') && !name?.startsWith('read-home-inbox-')) return route.fallback();
      const response = await worker.fetch(new Request(request.url(), {
        method: request.method(), headers: request.headers(), body: request.postData(),
      }), {
        APP_ENV: 'production',
        ENGINE: { fetch: async request => {
          const [, , , collection, reviewId, action] = new URL(request.url).pathname.split('/');
          if (collection === 'home') {
            if (reviewId !== 'cards') return Response.json(snapshot([]));
            if (!cardRouteAvailable) return new Response('404 Not Found', { status: 404 });
            const itemId = decodeURIComponent(action);
            const card = [draft, suggestion].find(item => item.item_id === itemId ||
              item.suggestions.some(({ id }) => `suggestion:${id}` === itemId));
            if (partner !== 'joe' || !card) return Response.json({ error: 'not_found' }, { status: 404 });
            if (card === draft) return Response.json({ ...draft, source_version: String(state.draft.version) });
            const [{ id }] = suggestion.suggestions;
            return Response.json({ ...suggestion, source_id: id, item_id: `suggestion:${id}` });
          }
          if (collection === 'proposals' && [id(41), id(42), id(43)].includes(reviewId)) {
            if (partner !== 'joe') return Response.json({ error: 'not_found' }, { status: 404 });
            if (action === 'decision') {
              const { decision } = await request.json();
              writes.push([action, reviewId, decision]);
              if (reviewId === id(43)) draft.suggestions = [];
              else suggestion.suggestions = suggestion.suggestions.filter(({ id }) => id !== reviewId);
              return Response.json({ proposal_id: reviewId, status: 'accepted' });
            }
            return Response.json({
              proposal_id: reviewId, kind: reviewId === id(42) ? 'phase_move' : 'file_to_deal',
              target_name: 'Example Dental', evidence: 'Review the plan.', reason: 'The sender named the suite.',
              source_activity: mailSource, thread: mailThread,
            });
          }
          assert.equal(collection, 'reply-drafts');
          assert.equal(reviewId, id(20));
          if (partner !== 'joe') return Response.json({ error: 'not_mailbox_owner' }, { status: 403 });
          if (action) {
            const { version, subject, body } = await request.json();
            writes.push([action, reviewId, version, body]);
            state.draft = { ...state.draft, version: version + 1, subject, body,
              status: action === 'edit' ? 'pending' : 'approved' };
          }
          return Response.json({
            ...state.draft, to: 'sender@example.test', cc: 'partner@example.test', attachments: [],
            source_activity: mailSource, thread: mailThread,
          });
        } },
      });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
  }

  await signIn(page, 'joe');
  const path = item => `/inbox/card/${encodeURIComponent(item)}?mode=live`;
  const suggestionUrl = path(suggestion.item_id);
  const draftUrl = path(draft.item_id);
  await open(suggestionUrl);
  const thread = page.getByRole('region', { name: 'Email thread' });
  await thread.getByText(mailThread[0].body, { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Deal progress', exact: true }).getByRole('button', { name: 'Accept' }).waitFor();
  assert.equal(await thread.getByText(mailThread[0].body, { exact: true }).count(), 1);
  await page.getByRole('region', { name: 'File this email', exact: true }).getByRole('button', { name: 'Accept' }).click();
  await page.getByText('Suggestion accepted.', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Deal progress', exact: true }).getByRole('button', { name: 'Accept' }).waitFor();

  await open(draftUrl);
  await page.getByText('First draft.', { exact: true }).waitFor();
  const filing = page.getByRole('region', { name: 'File this email', exact: true });
  await filing.getByText('The sender named the suite.', { exact: true }).waitFor();
  assert.equal(await thread.getByText(mailThread[0].body, { exact: true }).count(), 1);
  await filing.getByRole('button', { name: 'Accept' }).click();
  await page.getByText('Suggestion accepted.', { exact: true }).waitFor();
  await filing.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Updated sample draft.');
  await page.goBack();
  await page.goForward();
  await message.waitFor();
  assert.equal(await message.inputValue(), 'Updated sample draft.');
  await page.reload();
  await message.waitFor();
  assert.equal(await message.inputValue(), 'Updated sample draft.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(await sessionHasReplyEdit(page, 'Updated sample draft.'), false);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await message.fill('Ready to send.');
  assert.equal(await sessionHasReplyEdit(page, 'Ready to send.'), true);
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await page.getByText('Sending', { exact: true }).waitFor();
  assert.equal(await sessionHasReplyEdit(page, 'Ready to send.'), false);
  assert.deepEqual(writes, [
    ['decision', id(41), 'accept'],
    ['decision', id(43), 'accept'],
    ['edit', id(20), 1, 'Updated sample draft.'],
    ['submission', id(20), 2, 'Ready to send.'],
  ]);

  const otherPartner = await scenario(t, { root: join(outDir, 'site'), page: { viewport: { width, height: 760 } } });
  otherPartner.page.setDefaultTimeout(4000);
  await signIn(otherPartner.page, 'dell');
  for (const url of [suggestionUrl, draftUrl]) {
    await otherPartner.open(url);
    const deniedPage = otherPartner.page;
    await deniedPage.getByText('This review is unavailable.', { exact: true }).waitFor();
    assert.equal(await deniedPage.getByRole('region', { name: 'Email thread' }).count(), 0);
    assert.equal(await deniedPage.getByText(/Sample email|Review the plan|Updated sample draft/).count(), 0);
    assert.equal(await deniedPage.getByRole('button', { name: /^(Accept|Edit|Send reply)$/ }).count(), 0);
  }
  cardRouteAvailable = false;
  await open(draftUrl);
  await page.getByText('This review is unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Back to Home' }).getAttribute('href'), '/');
  assert.deepEqual(listReads, []);
  assert.equal(state.dashboardReads, 0);
});

for (const width of [390, 1440]) {
  test(`A snoozed Home link shows its evidence without review actions at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    const draft = draftCard();
    state.linkedDisposition = {
      ...draft, suggestions: [{ id: id(41) }], disposition: 'snoozed', section: 'snoozed',
      snoozed_until: '2026-11-04T16:00:00Z', waiting_reason: 'Snoozed',
    };
    await open(`/inbox/card/${encodeURIComponent(draft.item_id)}?mode=live`);
    const review = page.getByRole('region', { name: `Details for ${draft.title}` });
    await review.getByText('First draft.', { exact: true }).waitFor();
    await review.getByRole('region', { name: 'File this email', exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: /^(Accept|Drop|Edit|Send reply)$/ }).count(), 0);
    await page.getByText('Snoozed until Nov 4, 2026, 10:00 AM', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Back to Home' }).getAttribute('href'), '/');
  });

  test(`A snoozed Home link hides filing picker actions at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    const draft = draftCard();
    state.filingChoices = [dealChoice, vendorChoice];
    state.linkedDisposition = {
      ...draft, suggestions: [{ id: id(41) }], disposition: 'snoozed', section: 'snoozed',
      snoozed_until: '2026-11-04T16:00:00Z', waiting_reason: 'Snoozed',
    };
    await open(`/inbox/card/${encodeURIComponent(draft.item_id)}?mode=live`);
    const review = page.getByRole('region', { name: `Details for ${draft.title}` });
    await review.getByText('First draft.', { exact: true }).waitFor();
    await review.getByRole('region', { name: 'File this email', exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: /^(Choose deal|Choose vendor|Dismiss|Drop|Edit|Send reply)$/ }).count(), 0);
    await page.getByText('Snoozed until Nov 4, 2026, 10:00 AM', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Back to Home' }).getAttribute('href'), '/');
  });

  test(`An older filing link opens the current Home decision at ${width}px`, async t => {
    const { page, open, state } = await dashboard(t, width, 'light');
    const requested_item_id = `suggestion:${id(44)}`;
    state.linkedDisposition = {
      ...mailCard, item_id: `suggestion:${id(41)}`, source_id: id(41),
      suggestions: [{ id: id(41) }], requested_item_id,
    };
    state.filingChoices = [dealChoice, vendorChoice];
    state.filingChecks = [];
    state.filingWrites = [];
    state.filingConflict = true;
    state.filingReasonHint = 'This email is already filed to another deal. Explain why you are moving it.';
    await open(`/inbox/card/${encodeURIComponent(requested_item_id)}?mode=live`);
    const filing = page.getByRole('region', { name: 'File this email', exact: true });
    await filing.getByRole('button', { name: 'Choose vendor', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Email thread' }).getByText(mailThread[0].body, { exact: true }).waitFor();
    await filing.getByRole('button', { name: 'Choose deal', exact: true }).click();
    await filing.getByRole('combobox', { name: 'Selected deal', exact: true }).selectOption({ label: 'Sample clinic' });
    await filing.getByText(state.filingReasonHint, { exact: true }).waitFor();
    const file = filing.getByRole('button', { name: 'File email', exact: true });
    assert.equal(await file.isDisabled(), true);
    assert.deepEqual(state.filingChecks, [{ id: id(41), deal_id: id(61) }]);
    assert.deepEqual(state.filingWrites, []);
    const reason = 'The sender confirmed this is the right deal.';
    await filing.getByRole('textbox', { name: 'Reason for filing', exact: true }).fill(reason);
    await file.click();
    await page.getByText('This review is finished.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Suggestion accepted.', { exact: true }).count(), 0);
    assert.equal(state.filingWrites.length, 1);
    const [{ id: proposal, deal_id: deal, reason: savedReason }] = state.filingWrites;
    assert.deepEqual([proposal, deal, savedReason], [id(41), id(61), reason]);
  });
}

test('A link to a dropped or replaced Home draft shows its saved outcome', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  const url = `/inbox/card/${encodeURIComponent(draft.item_id)}?mode=live`;
  for (const [disposition, label, reason] of [
    ['dropped', 'Draft dropped.', 'I already replied'],
    ['replaced', 'Draft replaced.', 'Replaced by a newer reply draft in this conversation'],
  ]) {
    state.draft.status = 'pending';
    state.linkedDisposition = draft;
    await open(url);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent sample edit.');
    assert.equal(await sessionHasReplyEdit(page, 'Unsent sample edit.'), true);
    state.linkedDisposition = { state: disposition, reason };
    await page.reload();
    await page.getByText(label, { exact: true }).waitFor();
    await page.getByText(reason, { exact: true }).waitFor();
    assert.equal(await page.getByText(/A reply needs the sender/).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(Edit|Drop|Send reply)$/ }).count(), 0);
    assert.equal(await sessionHasReplyEdit(page, 'Unsent sample edit.'), false);
  }
});

test('The Home query link still opens its loaded draft', async t => {
  const { page, open, state } = await dashboard(t, 1440, 'light');
  const draft = draftCard();
  state.dashboard = true;
  state.items = [draft];
  await open(`/?mode=live&card=${encodeURIComponent(draft.item_id)}`);
  const review = page.getByRole('region', { name: `Details for ${draft.title}` });
  await review.getByRole('button', { name: 'Send reply', exact: true }).waitFor();
  await review.getByRole('button', { name: 'Close review' }).click();
  assert.equal(await review.count(), 0);
  await page.getByRole('link', { name: draft.title }).waitFor();
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
    await review.getByRole('button', { name: 'Edit', exact: true }).click();
    await review.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited sample draft.');
    await review.getByRole('button', { name: 'Save draft', exact: true }).click();
    await review.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  }

  assert.equal(state.dashboardReads, reads + 1);
  assert.equal(await original.evaluate(node => node.isConnected), true);
  await unchanged.waitFor();
});

for (const width of [390, 900, 1440]) for (const theme of ['light', 'dark']) test(`Home polls in place at ${width}px in ${theme}`, async t => {
  const { page, open, state } = await dashboard(t, width, theme);
  // Safari has no scroll anchoring, so Home keeps the page's place itself.
  if (width < 1000) await page.addInitScript(() => addEventListener('DOMContentLoaded', () =>
    document.head.append(Object.assign(document.createElement('style'), { textContent: '* { overflow-anchor: none !important; }' }))));
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
  await review.getByRole('button', { name: 'Edit', exact: true }).click();
  const originalCard = await draftTitle.elementHandle();
  const message = review.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Unsaved edit for the floor plan.');
  await message.scrollIntoViewIfNeeded();
  const before = await message.evaluate(node => ({ y: scrollY + document.getElementById('appMainSlot').scrollTop + node.closest('.home-slice').scrollTop, top: node.getBoundingClientRect().top }));
  assert.ok(before.y > 0 && before.top >= 0 && before.top < 760);
  const reads = state.dashboardReads;
  const added = { ...step(32, 'Confirm the site visit'), card_id: 'suite:new' };
  state.items = [added, ...state.items.filter(item => item !== tasks[0]).reverse()];
  await page.clock.fastForward(60_000);
  await reminders.getByRole('link', { name: added.title }).waitFor();
  await reminders.getByRole('link', { name: tasks[0].title, exact: true }).waitFor({ state: 'detached' });
  assert.equal(state.dashboardReads, reads + 1);
  assert.equal(await draftTitle.evaluate((node, original) => node === original, originalCard), true);
  assert.equal(await message.inputValue(), 'Unsaved edit for the floor plan.');
  assert.equal(await message.evaluate(node => node === document.activeElement), true);
  const after = await message.evaluate(node => ({ y: scrollY + document.getElementById('appMainSlot').scrollTop, top: node.getBoundingClientRect().top }));
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
  key: 'aaaaaaaaaaaaaaaa', title: 'Tour Cedar Suite', start: '2026-11-03T13:30:00Z', end: '2026-11-03T14:30:00Z',
};
const meetingOutcome = { ...scheduledMeeting, state: 'needs_review' };
const meetingDeal = { id: id(99), name: 'Example Dental', owner: 'joe' };

async function meetingDashboard(t, calendar, time = NOW, items = []) {
  const { page, open, state } = await dashboard(t, 1440, 'light', 'UTC');
  state.items = items;
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
  await page.getByText('Last synced Nov 3, 8:00 AM').waitFor();
  await page.clock.fastForward(60_000);
  await page.getByText('Meetings unavailable.', { exact: true }).waitFor();
  await page.getByText('Last synced Nov 3, 8:00 AM').waitFor();
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
  await meetings.getByText('Last synced Nov 3, 8:01 AM').waitFor();
  await title.waitFor();
});

test('Home replaces meeting details with the newest row for the same key', async t => {
  const open_url = `/deals?deal=${meetingDeal.id}`;
  const location = 'Cedar Suite lobby';
  const calendar = { items: [{ ...scheduledMeeting, open_url, location, attendees: [{ name: 'Pat Example' }] }] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  const summary = meetings.locator('summary').filter({ hasText: scheduledMeeting.title });
  await summary.press('Enter');
  await meetings.getByText('Pat Example', { exact: true }).waitFor();

  const { key, title, start, end } = {
    ...scheduledMeeting, title: 'Cedar Suite walkthrough',
    start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T15:00:00.000Z',
  };
  calendar.items = [{
    key, title, start, end, location: null, organizer: { name: null, email: null },
    attendees: [], attendee_count: 0, all_day: false, recurring: false, time_changed: false,
    times: [], conflict: false, schedule_conflict: false, schedule_conflicts: [], schedule_conflicts_omitted: 0,
  }];
  calendar.follow_up_reviews = [{
    key, title, start, end, state: 'needs_review', prompt: 'Confirm whether this meeting happened.',
  }];
  calendar.state = 'partial';
  calendar.observed_at = '2026-11-03T15:00:00.000Z';
  await page.clock.fastForward(60_000);

  const updated = meetings.locator('details[open]').filter({ has: page.locator('summary').filter({ hasText: title }) });
  await updated.getByRole('button', { name: 'It happened', exact: true }).waitFor();
  assert.equal(await updated.locator('summary time').getAttribute('datetime'), start);
  assert.equal(await updated.getByText('Pat Example', { exact: true }).count(), 0);
  assert.equal(await updated.getByText(location, { exact: true }).count(), 0);
  assert.equal(await updated.getByRole('link', { name: 'Open deal' }).count(), 0);
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

test('Home keeps same-time Outlook invites separate when attendees and outcomes change', async t => {
  const pat = { ...scheduledMeeting, key: 'bbbbbbbbbbbbbbbb', attendees: [{ name: 'Pat Example' }] };
  const lee = { ...scheduledMeeting, attendees: [{ name: 'Lee Example' }] };
  const calendar = { items: [pat, lee] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  await meetings.getByRole('heading', { name: "Today's meetings 2" }).waitFor();
  for (const summary of await meetings.locator('summary').all()) await summary.press('Enter');
  await meetings.getByText('Lee Example', { exact: true }).waitFor();

  calendar.items = [pat, { ...lee, attendees: [{ name: 'Sam Example' }] }];
  calendar.follow_up_reviews = [meetingOutcome];
  await page.clock.fastForward(60_000);
  const samRow = meetings.locator('details').filter({ hasText: 'Sam Example' });
  await samRow.getByRole('button', { name: 'It happened', exact: true }).waitFor();
  assert.equal(await meetings.locator('summary').count(), 2);
  assert.equal(await meetings.locator('details').filter({ hasText: 'Pat Example' })
    .getByRole('button', { name: 'It happened', exact: true }).count(), 0);
});

test('Home keeps a legacy invite separate from an outcome with the same title and times', async t => {
  const legacy = { ...scheduledMeeting, key: undefined, attendees: [{ name: 'Pat Example' }] };
  const { meetings } = await meetingDashboard(t, {
    items: [legacy], follow_up_reviews: [meetingOutcome],
  });
  await meetings.locator('summary').first().waitFor();
  for (const summary of await meetings.locator('summary').all()) await summary.press('Enter');
  const legacyRow = meetings.locator('details').filter({ hasText: 'Pat Example' });
  await meetings.getByRole('button', { name: 'It happened', exact: true }).waitFor();
  assert.equal(await legacyRow.getByRole('button', { name: 'It happened', exact: true }).count(), 0);
  assert.equal(await meetings.locator('summary').count(), 2);
});

test('Home keeps the open meeting outcome and its focus when earlier meetings arrive', async t => {
  const calendar = { items: [scheduledMeeting], follow_up_reviews: [meetingOutcome] };
  const { page, meetings } = await meetingDashboard(t, calendar);
  await meetings.locator('summary').filter({ hasText: scheduledMeeting.title }).press('Enter');
  const choice = meetings.getByRole('combobox', { name: 'Deal', exact: true });
  await choice.selectOption(meetingDeal.id);
  await choice.focus();
  const earlier = Array.from({ length: 3 }, (_, index) => ({
    key: `000000000000000${index}`, title: `Earlier sample meeting ${index + 1}`,
    start: '2026-11-03T12:00:00Z', end: '2026-11-03T13:00:00Z',
  }));
  calendar.items = [...earlier, scheduledMeeting];
  await page.clock.fastForward(60_000);
  await meetings.getByRole('heading', { name: "Today's meetings 4" }).waitFor();
  assert.equal(await choice.inputValue(), meetingDeal.id);
  assert.equal(await choice.evaluate(node => node === document.activeElement), true);
});

const movedMeeting = { ...scheduledMeeting, start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z' };
const movedReview = { ...meetingOutcome, start: '2026-11-02T19:00:00Z', end: '2026-11-02T20:00:00Z' };

async function meetingWrites(page) {
  const writes = [];
  await page.route('**/api/engine/activities', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { activity_id: id(91), existing: false } });
  });
  return writes;
}

test('Home shows a meeting moved to today once, on its tile row, and logs the time the row shows', async t => {
  const { key } = movedMeeting;
  const { page, meetings } = await meetingDashboard(t, { items: [movedMeeting], follow_up_reviews: [movedReview] });
  const writes = await meetingWrites(page);
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const summary = meetings.locator('summary').filter({ hasText: movedMeeting.title });
  await summary.waitFor();
  assert.equal(await summary.count(), 1);
  assert.equal(await summary.locator('time').getAttribute('datetime'), movedMeeting.start);
  assert.equal(await reminders.locator(`[data-review="${key}"]`).count(), 0);
  assert.equal(await reminders.getByText(/Tour Cedar Suite/).count(), 0);
  assert.equal(await page.locator(`[data-review="${key}"]`).count(), 0);
  await summary.press('Enter');
  const row = meetings.locator('details[open]');
  await row.waitFor();
  assert.equal(await row.getByRole('button', { name: 'It happened', exact: true }).count(), 0);
  assert.equal(await row.getByRole('combobox', { name: 'Deal', exact: true }).count(), 0);

  await page.clock.fastForward('03:30:00');
  const happened = row.getByRole('button', { name: 'It happened', exact: true });
  await happened.waitFor();
  assert.equal(await reminders.locator(`[data-review="${key}"]`).count(), 0);
  assert.equal(await reminders.getByText(/Tour Cedar Suite/).count(), 0);
  assert.equal(await page.locator(`[data-review="${key}"]`).count(), 1);
  await row.getByRole('combobox', { name: 'Deal', exact: true }).selectOption(meetingDeal.id);
  await happened.click();
  await page.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].calendar_review_key, key);
  assert.equal(writes[0].happened_at, '2026-11-03T18:00:00.000Z');
});

test('Home logs the tile time when a meeting and its outcome are both today at different times', async t => {
  const item = { ...scheduledMeeting, start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:00:00Z' };
  const { page, meetings } = await meetingDashboard(t, { items: [item], follow_up_reviews: [meetingOutcome] });
  const writes = await meetingWrites(page);
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const summary = meetings.locator('summary');
  await summary.filter({ hasText: item.title }).press('Enter');
  const happened = meetings.getByRole('button', { name: 'It happened', exact: true });
  await happened.waitFor();
  assert.equal(await summary.count(), 1);
  assert.equal(await summary.locator('time').getAttribute('datetime'), item.start);
  assert.equal(await reminders.locator(`[data-review="${item.key}"]`).count(), 0);
  await meetings.getByRole('combobox', { name: 'Deal', exact: true }).selectOption(meetingDeal.id);
  await happened.click();
  await page.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].happened_at, '2026-11-03T15:00:00.000Z');
});

test('Home keeps an earlier outcome in Reminders and a later one off Home', async t => {
  const earlier = { key: 'bbbbbbbbbbbbbbbb', title: 'Visit Elm Suite',
    start: '2026-11-02T19:00:00Z', end: '2026-11-02T20:00:00Z', state: 'needs_review' };
  const later = { key: 'cccccccccccccccc', title: 'Tour Pine Suite',
    start: '2026-11-04T19:00:00Z', end: '2026-11-04T20:00:00Z', state: 'needs_review' };
  const { page, meetings } = await meetingDashboard(t, { items: [scheduledMeeting], follow_up_reviews: [earlier, later] });
  const writes = await meetingWrites(page);
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  const earlierReview = reminders.locator(`[data-review="${earlier.key}"]`);
  await earlierReview.waitFor();
  await meetings.locator('summary').filter({ hasText: scheduledMeeting.title }).waitFor();
  assert.equal(await page.locator(`[data-review="${earlier.key}"]`).count(), 1);
  assert.equal(await meetings.getByText(earlier.title).count(), 0);
  assert.equal(await page.locator(`[data-review="${later.key}"]`).count(), 0);
  assert.equal(await meetings.getByText(later.title).count(), 0);
  assert.equal(await reminders.getByText(later.title).count(), 0);
  await earlierReview.getByRole('button', { name: `Confirm ${earlier.title}` }).press('Enter');
  await earlierReview.getByRole('combobox', { name: 'Deal', exact: true }).selectOption(meetingDeal.id);
  await earlierReview.getByRole('button', { name: 'It happened', exact: true }).click();
  await page.getByText('Meeting logged on Example Dental.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].calendar_review_key, earlier.key);
  assert.equal(writes[0].happened_at, '2026-11-02T19:00:00.000Z');
});

test('Home moves an unanswered moved meeting to Reminders after Central midnight', async t => {
  const { key } = movedMeeting;
  const calendar = { items: [movedMeeting], follow_up_reviews: [movedReview] };
  const { page, meetings } = await meetingDashboard(t, calendar, new Date('2026-11-04T05:59:50Z'));
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  await meetings.locator('summary').filter({ hasText: movedMeeting.title }).waitFor();
  assert.equal(await reminders.locator(`[data-review="${key}"]`).count(), 0);
  calendar.items = [];
  await page.clock.fastForward(20_000);
  await page.clock.fastForward(60_000);
  await meetings.waitFor({ state: 'detached' });
  const review = reminders.locator(`[data-review="${key}"]`);
  await review.waitFor();
  assert.equal(await page.locator(`[data-review="${key}"]`).count(), 1);
  assert.equal(await review.locator('time').getAttribute('datetime'), movedReview.start);
});

test('Home with meetings and a late reminder keeps the Today rail hidden and never says overdue', async t => {
  const earlier = { ...movedReview, key: 'bbbbbbbbbbbbbbbb', title: 'Visit Elm Suite' };
  const { page, meetings } = await meetingDashboard(t, { items: [movedMeeting], follow_up_reviews: [movedReview, earlier] },
    NOW, [step(1, 'Send the signed lease', { due_on: '2026-10-31', days_late: 3 })]);
  const reminders = page.getByRole('region', { name: 'Reminders', exact: true });
  await reminders.getByText(/3 days late/).waitFor();
  await reminders.locator(`[data-review="${earlier.key}"]`).waitFor();
  await meetings.locator('summary').filter({ hasText: movedMeeting.title }).waitFor();
  assert.equal(await page.locator('#appToday').isVisible(), false);
  assert.equal(await page.getByRole('heading', { name: 'Meetings', exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /overdue/i);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home meeting tile at ${width}px in ${theme}`, async t => {
  const { page, open } = await dashboard(t, width, theme);
  const deal = { id: id(99), name: 'Example Dental', owner: 'joe' };
  const current = { key: 'aaaaaaaaaaaaaaaa', title: 'Tour Cedar Suite', start: '2026-11-03T13:30:00Z', end: '2026-11-03T14:30:00Z',
    context_label: deal.name, attendees: [{ name: 'Pat Example' }], open_url: `/deals?deal=${deal.id}` };
  const later = ['Review sample terms', 'Visit Elm Suite', 'Tour Pine Suite', 'Tour Oak Suite', 'Discuss lease dates'].map((title, index) => ({
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
  await meetings.getByRole('heading', { name: "Today's meetings 6" }).waitFor();
  await reminders.getByRole('heading', { name: 'Reminders 5' }).waitFor();
  await meetings.getByText('Last synced Nov 3, 8:00 AM').waitFor();
  assert.equal(await meetings.getByText(current.title, { exact: true }).count(), 1);
  assert.equal(await meetings.getByText(laterDay.title, { exact: true }).count(), 0);
  assert.equal(await meetings.locator('summary').count(), 5);
  assert.equal(await meetings.getByText('7:30 AM', { exact: true }).count(), 1);
  const sixth = meetings.getByText(later[4].title, { exact: true });
  assert.equal(await sixth.count(), 0);
  await meetings.getByRole('button', { name: 'See all 6' }).click();
  await sixth.waitFor();
  await meetings.getByRole('button', { name: 'Show less' }).click();
  await sixth.waitFor({ state: 'detached' });
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

async function homeDropFixture(t, width, { items, markDrop = true, proposalDrop = true, invalidDrop = false, theme } = {}) {
  const { page, open } = await scenario(t, { root: join(outDir, 'site'), now: NOW, page: { viewport: { width, height: 900 } } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const state = { items: items.map(card => ({ ...card })) };
  const writes = [];
  const env = {
    APP_ENV: 'production',
    ENGINE: { fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/engine/home/inbox') return Response.json({
        ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true,
        ...(proposalDrop && { home_proposal_drop: true }), ...(markDrop && { home_mark_drop: true }), items: state.items,
      });
      assert.equal(request.method, 'POST');
      const body = await request.json();
      writes.push({ path, body });
      if (path === '/api/engine/home/marks') {
        if (state.unanswered) return new Response('', { status: 503 });
        if (invalidDrop || (body.action === 'drop' && !/^(capture_post_call_action|notification):/.test(body.item_id)))
          return Response.json({ error: 'invalid_field_value', fields: ['action'] }, { status: 400 });
        if (body.action === 'drop') {
          state.items = state.items.filter(item => item.item_id !== body.item_id);
          return Response.json({ ok: true, item_id: body.item_id });
        }
        const card = state.items.find(item => item.item_id === body.item_id);
        const snoozed = body.action === 'snooze';
        Object.assign(card, { base_version: `${card.base_version}+`, disposition: snoozed ? 'snoozed' : 'inbox',
          section: snoozed ? 'snoozed' : 'inbox', snoozed_until: snoozed ? body.until : null, waiting_reason: snoozed ? 'Snoozed' : null });
        return Response.json({ ok: true, item_id: body.item_id, base_version: card.base_version,
          previous: { disposition: snoozed ? null : 'snoozed', snoozed_until: null } });
      }
      const proposal = path.match(/^\/api\/engine\/proposals\/([^/]+)\/decision$/);
      if (proposal) {
        const [, proposalId] = proposal;
        state.items = state.items.filter(item =>
          item.item_id !== `suggestion:${proposalId}` && !item.suggestions?.some(entry => entry.id === proposalId));
        return Response.json({ proposal_id: proposalId, status: 'dismissed', decided_at: NOW.toISOString(), created: {} });
      }
      const draft = path.match(/^\/api\/engine\/reply-drafts\/([^/]+)\/dismissal$/);
      if (draft) {
        const [, draftId] = draft;
        const card = state.items.find(item => item.reply_draft_id === draftId);
        if (!card || card.reply_draft_status !== 'pending')
          return Response.json({ error: 'draft_changed', version: Number(card?.source_version ?? 1) }, { status: 409 });
        state.items = state.items.filter(item => item.reply_draft_id !== draftId);
        return Response.json({ draft_id: draftId, version: body.version + 1, status: 'dismissed' });
      }
      assert.fail(`Unexpected engine write: ${path}`);
    } },
    CARR: { fetch: async request => {
      if (request.method === 'GET') return Response.json({ error: 'not_found' }, { status: 404 });
      const { id: rpc } = await request.json();
      const payload = { ok: true, items: [], deals: [] };
      return Response.json({ jsonrpc: '2.0', id: rpc, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    } },
  };
  await page.route('**/mcp', async route => {
    const request = route.request();
    const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.route('**/api/engine/home/inbox?view=dashboard', route => route.fulfill({ status: 404 }));
  await page.route(url => url.pathname === '/' && url.searchParams.get('mode') === 'live', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<html ', '<html data-home-today-from-engine ') });
  });
  await page.clock.install({ time: NOW });
  await open('/?mode=live');
  const rows = items.map(card => page.locator(`[data-inbox-row="${card.item_id}"]`));
  for (const row of rows) await row.waitFor();
  const dialog = page.getByRole('dialog', { name: 'Drop with a reason' });
  const confirm = async (reason) => {
    await dialog.getByRole('textbox', { name: 'Reason for dropping' }).fill(reason);
    await dialog.getByRole('button', { name: 'Drop', exact: true }).click();
  };
  return { page, state, rows, writes, dialog, confirm, confirmation: page.locator('.toast[role="status"]'), alert: page.locator('.inbox-notice[role="alert"]') };
}

const dropCard = (number, fields) => ({
  source_id: id(number), source_version: '2', source_state: 'needs_attention',
  base_version: `2:${number}:inbox`, activity_at: '2026-11-02T12:00:00.000Z', completed_at: null, due_on: null,
  hold_until: null, snoozed_until: null, disposition: 'inbox', section: 'inbox', unseen: false,
  context_label: 'Example Dental', open_url: null, deal_id: null, action_id: null, action_version: null,
  merged_source_ids: [id(number)], waiting_version: 0, waiting_on: null, source_activity: null, ...fields,
});

for (const [label, card, expectedPath, expectedBody] of [
  [
    'follow-up',
    dropCard(70, { item_id: `capture_post_call_action:${id(70)}`, source_type: 'capture_post_call_action',
      kind_label: 'Call follow-up', title: 'Call back the sample landlord', action_id: id(70), action_version: 2 }),
    '/api/engine/home/marks',
    (body) => ({ item_id: `capture_post_call_action:${id(70)}`, base_version: '2:70:inbox', action: 'drop', reason: 'Already handled.', idempotency_key: body.idempotency_key }),
  ],
  [
    'notification',
    dropCard(71, { item_id: `notification:${id(71)}`, source_type: 'notification', kind_label: 'Update', title: 'Checklist reminder for Example Dental' }),
    '/api/engine/home/marks',
    (body) => ({ item_id: `notification:${id(71)}`, base_version: '2:71:inbox', action: 'drop', reason: 'Already handled.', idempotency_key: body.idempotency_key }),
  ],
  [
    'suggestion',
    dropCard(72, { item_id: `suggestion:${id(72)}`, source_type: 'email_proposal', kind_label: 'Suggestion', title: 'Review the sample email' }),
    `/api/engine/proposals/${id(72)}/decision`,
    (body) => ({ decision: 'dismiss', reason: 'Already handled.', idempotency_key: body.idempotency_key }),
  ],
  [
    'reply draft',
    dropCard(73, { item_id: `reply_draft:${id(73)}`, source_type: 'email_proposal', kind_label: 'Reply draft',
      title: 'Reply to the sample landlord', reply_draft_id: id(73), reply_draft_status: 'pending' }),
    `/api/engine/reply-drafts/${id(73)}/dismissal`,
    (body) => ({ version: 2, reason: 'Already handled.', idempotency_key: body.idempotency_key }),
  ],
]) for (const width of [390, 1440]) test(`Home drops a ${label} card through its engine route with a trimmed reason at ${width}px`, async t => {
  const { page, rows: [row], writes, dialog, confirm, confirmation } = await homeDropFixture(t, width, { items: [card] });
  const buttons = await row.getByRole('button').allTextContents();
  assert.equal(buttons[buttons.indexOf('Snooze') + 1], 'Drop', buttons.join(', '));
  const drop = row.getByRole('button', { name: 'Drop', exact: true });
  await drop.click();
  const submit = dialog.getByRole('button', { name: 'Drop', exact: true });
  assert.equal(await submit.isDisabled(), true);
  await dialog.getByRole('textbox', { name: 'Reason for dropping' }).fill('   ');
  assert.equal(await submit.isDisabled(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(writes.length, 0);
  assert.equal(await drop.evaluate(node => node === document.activeElement), true);
  await drop.click();
  await confirm('  Already handled.  ');
  await row.waitFor({ state: 'detached' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, expectedPath);
  assert.deepEqual(writes[0].body, expectedBody(writes[0].body));
  assert.ok(writes[0].body.idempotency_key);
  await confirmation.getByText(`Dropped: ${card.title}.`, { exact: true }).waitFor();
  assert.equal(await confirmation.getByRole('button').count(), 0, 'a drop has no reverse route, so no Undo');
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
});

for (const width of [390, 1440]) test(`Home hides Drop on Tour feedback, Fact review, and failed reply drafts at ${width}px`, async t => {
  const items = [
    dropCard(74, { item_id: `notification:${id(74)}`, source_type: 'notification', kind: 'tour_feedback', kind_label: 'Tour feedback', title: 'Tour feedback on Cedar Suite' }),
    dropCard(75, { item_id: `notification:${id(75)}`, source_type: 'notification', kind_label: 'Fact review', title: 'Lease fact on Cedar Suite' }),
    dropCard(76, { item_id: `reply_draft:${id(76)}`, source_type: 'email_proposal', kind_label: 'Reply draft',
      title: 'Failed reply to the sample landlord', source_state: 'failed', reply_draft_id: id(76), reply_draft_status: 'failed' }),
  ];
  const { rows } = await homeDropFixture(t, width, { items });
  for (const row of rows) {
    await row.getByRole('button', { name: 'Snooze', exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Drop', exact: true }).count(), 0);
  }
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home confirms a snooze at the bottom with Undo at ${width}px in ${theme}`, async t => {
  const card = dropCard(78, { item_id: `notification:${id(78)}`, source_type: 'notification', kind_label: 'Update', title: 'Sample reminder to snooze' });
  const { page, rows: [row], writes } = await homeDropFixture(t, width, { items: [card], theme });
  await row.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Snoozed: Sample reminder to snooze.' });
  await toast.waitFor();
  assert.equal(await toast.getAttribute('aria-atomic'), 'true');
  const box = await toast.boundingBox();
  assert.ok(box.y > 900 / 2 && box.y + box.height <= 900, 'the confirmation sits at the bottom of the screen');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const colors = await toast.evaluate(node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor]);
  assert.notEqual(colors[0], colors[1], 'the message is readable on its own background');
  await mkdir('test-artifacts/save-confirmation', { recursive: true });
  await page.screenshot({ path: `test-artifacts/save-confirmation/home-${width}-${theme}.png` });
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = page.getByRole('status').filter({ hasText: 'Undone.' });
  await undone.waitFor();
  assert.deepEqual(writes.map(write => write.body.action), ['snooze', 'unsnooze']);
  assert.equal(await undone.getByRole('button').count(), 0, 'an undo is not itself offered for undo');
  await row.getByRole('button', { name: 'Snooze', exact: true }).waitFor();
  await page.clock.runFor(5_000);
  await undone.waitFor({ state: 'detached' });
});

test('Home keeps the bottom Undo unusable while a later save is unresolved', async t => {
  const cards = [80, 81].map(n => dropCard(n, { item_id: `notification:${id(n)}`, source_type: 'notification', kind_label: 'Update', title: `Sample reminder ${n}` }));
  const { page, state, rows: [first, second], writes } = await homeDropFixture(t, 1440, { items: cards });
  const snooze = async row => {
    await row.getByRole('button', { name: 'Snooze', exact: true }).click();
    await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  };
  await snooze(first);
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo', exact: true });
  await undo.waitFor();
  state.unanswered = true;
  await snooze(second);
  await page.getByText(/Result uncertain/).waitFor();
  assert.equal(await undo.isDisabled(), true, 'Undo waits while the later save is unresolved');
  state.unanswered = false;
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Snoozed: Sample reminder 81.' }).waitFor();
  assert.deepEqual(writes.map(write => [write.body.action, write.body.item_id]),
    [['snooze', cards[0].item_id], ['snooze', cards[1].item_id], ['snooze', cards[1].item_id]]);
});

for (const width of [390, 1440]) test(`Home alerts and keeps a card when the engine refuses Drop with 400 invalid_field_value at ${width}px`, async t => {
  const card = dropCard(77, { item_id: `notification:${id(77)}`, source_type: 'notification', kind_label: 'Update', title: 'Reminder the server refuses to drop' });
  const { page, rows: [row], writes, confirm, alert } = await homeDropFixture(t, width, { items: [card], invalidDrop: true });
  await row.getByRole('button', { name: 'Drop', exact: true }).click();
  await confirm('Already handled.');
  await alert.getByText("This card can't be dropped. Nothing was saved.", { exact: true }).waitFor();
  await page.clock.fastForward(5000);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/engine/home/marks');
  assert.equal(await row.isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Retry same request' }).count(), 0);
  const title = row.locator(':is(h3 a, h3[tabindex])');
  await page.waitForFunction(node => node === document.activeElement, await title.elementHandle());
});

});
