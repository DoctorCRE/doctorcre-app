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
  page.setDefaultTimeout(5000);
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
  const records = () => ({
    ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true,
    items: tasks.map((task, index) => {
      const id = `00000000-0000-0000-0000-00000000001${index}`;
      const source = task.call ? 'capture_post_call_action' : 'next_action';
      return {
        item_id: `${source}:${id}`, source_type: source, source_id: id, source_version: enabled ? '2147483648' : '7',
        source_state: 'needs_attention', base_version: enabled ? '2147483648:0:inbox' : 'legacy:7', title: task.title,
        activity_at: '2026-11-02T12:00:00.000Z', completed_at: null, due_on: '2026-11-03',
        hold_until: null, snoozed_until: null, disposition: 'inbox', section: 'inbox', unseen: false,
        explicit_unsettle: false, auto_settled: false, context_label: task.call ? 'Example Dental' : task.label,
        open_url: task.path, kind_label: task.call ? 'Call follow-up' : 'Task', action_id: id, action_version: enabled ? 2147483648 : 7,
        deal_id: task.dealId ?? null, merged_source_ids: [id], waiting_version: 0, waiting_on: null,
        source_activity: task.call ? { kind: 'call', id: callId, happened_at: '2026-11-02T11:00:00.000Z',
          contact: 'Example Contact', summary: 'Discussed the floor plan.', quote: 'Please send the floor plan.' } : null,
      };
    }),
  });
  const state = records();
  if (enabled) state.items.push({
    ...state.items[0], item_id: `notification:${partyId}`, source_type: 'notification', source_id: partyId,
    action_id: null, action_version: null, due_on: null, kind_label: 'Update', title: 'The sample deal moved ahead',
  });
  const details = new Map();
  let mailRows = [];
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
        return Response.json({ ok: true, schema_version: 'home-mail-priorities.v1', items: mailRows, more: false });
      }
      const [, , , collection, id, action] = path.split('/');
      if (request.method === 'GET') return Response.json(details.get(id));
      if (collection !== 'home') {
        const args = await request.json();
        writes.push([path, args]);
        const item = state.items.find(row => [row.action_id, row.reply_draft_id, row.completion_review?.proposal_id].includes(id) ||
          row.suggestions?.some(suggestion => suggestion.id === id));
        assert.ok(item);
        if (collection === 'next-steps') {
          assert.equal(args.base_version, item.action_version);
          const done = action === 'end';
          if (done) assert.equal(args.resolution, 'done');
          const change_id = ++item.action_version;
          Object.assign(item, { source_state: done ? 'done' : 'needs_attention', completed_at: done ? NOW.toISOString() : null,
            section: done ? 'done' : 'inbox', disposition: done ? 'settled' : 'inbox', base_version: `${change_id}:0:${done ? 'settled' : 'inbox'}` });
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
            if (!item.suggestions.length) state.items.splice(state.items.indexOf(item), 1);
          }
          return Response.json({ proposal_id: id, status: args.decision === 'accept' ? 'accepted' : 'dismissed' });
        }
        const draft = details.get(id);
        assert.equal(args.version, draft.version);
        draft.version++;
        draft.subject = args.subject ?? draft.subject;
        draft.body = args.body ?? draft.body;
        draft.status = action === 'submission' ? 'approved' : action === 'dismissal' ? 'dismissed' : 'pending';
        if (draft.status === 'dismissed') state.items.splice(state.items.indexOf(item), 1);
        Object.assign(item, { source_version: String(draft.version), reply_draft_status: draft.status, source_state: action === 'submission' ? 'working' : 'needs_attention',
          section: action === 'submission' ? 'working' : 'inbox' });
        return Response.json({ draft_id: id, version: draft.version, status: draft.status });
      }
      assert.equal(path, '/api/engine/home/marks');
      const args = await request.json();
      writes.push([path, args]);
      assert.equal(args.base_version, state.items.find(item => item.item_id === args.item_id)?.base_version);
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

  await open('/?mode=live');
  const reader = enabled ? 'new inbox' : 'current inbox';
  const inbox = page.getByRole('region', { name: 'Inbox cards', exact: true });
  const first = inbox.getByRole('link', { name: new RegExp(`^${tasks[0].title}`) });
  await first.waitFor();
  assert.equal(await first.textContent(), `${tasks[0].title} (${reader})`);
  await inbox.getByRole('region', { name: 'Today', exact: true }).getByRole('button', { name: 'See all 3', exact: true }).click();
  assert.equal(await inbox.locator('[data-inbox-row]').count(), state.items.length);
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
  assert.deepEqual(writes[1][1], { item_id: id, base_version: snoozedVersion, action: 'unsettle', idempotency_key: writes[1][1].idempotency_key });
  for (const task of tasks.slice(0, 2)) await inbox.getByRole('checkbox', { name: `Select ${task.title} (${reader})` }).check();
  const before = reads.length;
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
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
    assert.equal(args.action, 'unsettle');
    assert.equal('until' in args, false);
  }
  assert.equal(new Set(writes.slice(2).map(([, args]) => args.idempotency_key)).size, 4);
  await page.getByRole('button', { name: 'Finish reviewing batch' }).click();
  conflict = true;
  await clickSnooze();
  await page.getByText('This card changed. Refreshing your inbox. Your change was not saved.', { exact: true }).waitFor();
  await today.getByRole('link', { name: /Read the revised sample lease/ }).waitFor();
  assert.equal(writes.length, 7);
  const update = inbox.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row]')
    .filter({ has: page.getByRole('link', { name: /The sample deal moved ahead/ }) });
  await update.getByRole('button', { name: 'Got it', exact: true }).click();
  await update.waitFor({ state: 'detached' });
  assert.equal(writes[7][1].action, 'settle');
  assert.equal(writes[7][1].item_id, `notification:${partyId}`);
  await undo.click();
  await update.waitFor();

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

  const proposal = '00000000-0000-0000-0000-000000000020';
  const log = '00000000-0000-0000-0000-000000000021';
  const draft = '00000000-0000-0000-0000-000000000022';
  const next = '00000000-0000-0000-0000-000000000023';
  const decline = '00000000-0000-0000-0000-000000000024';
  const leading = '00000000-0000-0000-0000-000000000025';
  const phase = '00000000-0000-0000-0000-000000000026';
  const evidence = { evidence: 'Discussed next steps.', source_activity: { kind: 'call', summary: 'The sample call summary.', happened_at: NOW.toISOString() } };
  state.items[2].completion_review = { proposal_id: proposal, can_resolve: false };
  details.set(proposal, { ...evidence, proposal_id: proposal, kind: 'next_step_done' });
  const notice = state.items[3];
  state.items.push(
    { ...notice, title: 'Call suggestions', item_id: `suggestion:${log}`, source_id: log, source_type: 'capture_session',
      deal_id: null, kind_label: 'Call', suggestions: [{ id: log }, { id: phase }] },
    { ...notice, title: 'Email suggestions', item_id: `suggestion:${leading}`, source_id: leading, source_type: 'email_proposal',
      deal_id: null, kind_label: 'Task', suggestions: [{ id: leading }, { id: next }] },
    { ...notice, title: 'Reply to the sample email', item_id: `reply_draft:${draft}`, source_id: draft, source_type: 'email_proposal',
      deal_id: null, kind_label: 'Reply draft', source_version: '1', reply_draft_id: draft },
  );
  details.set(log, { ...evidence, proposal_id: log, kind: 'log_call', target_name: 'Example Dental', what: 'Log the sample call' });
  details.set(next, { ...evidence, proposal_id: next, kind: 'next_step', what: 'Share the plan', due_on: '2026-11-04' });
  details.set(phase, { ...evidence, proposal_id: phase, kind: 'phase_move', to_phase: 'legal' });
  details.set(leading, { ...evidence, proposal_id: leading, kind: 'possible_new_deal' });
  details.set(draft, { draft_id: draft, version: 1, status: 'pending', subject: 'Sample reply', body: 'First draft.',
    to: 'sender@example.test', cc: 'partner@example.test', attachments: [{ document_id: dealId, name: 'Sample plan' }],
    source_activity: { sender: 'sender@example.test', subject: 'Sample email', body: 'Please share the sample plan.', happened_at: NOW.toISOString() } });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const cardFor = name => inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name }) });
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
  await inbox.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('button', { name: /^See all/ }).click();
  const suggestions = cardFor(/Call suggestions/);
  const reply = cardFor(/Reply to the sample email/);
  for (const [row, id] of [[suggestions, `suggestion:${log}`], [reply, `reply_draft:${draft}`]]) {
    const base_version = state.items.find(card => card.item_id === id).base_version;
    await row.getByRole('button', { name: 'Snooze', exact: true }).click();
    await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
    await row.waitFor({ state: 'detached' });
    assert.equal(writes.at(-1)[1].item_id, id);
    assert.equal(writes.at(-1)[1].base_version, base_version);
    await undo.click();
    await row.waitFor();
  }
  await suggestions.getByRole('button', { name: 'Open', exact: true }).click();
  await suggestions.getByRole('heading', { name: 'Log a call · Example Dental' }).waitFor();
  await suggestions.getByRole('button', { name: 'Accept', exact: true }).first().click();
  await suggestions.getByRole('button', { name: 'Open', exact: true }).click();
  assert.equal(writes.at(-1)[1].decision, 'accept');
  proposalRefusals.set(phase, ['version_conflict', 409]);
  await suggestions.getByRole('button', { name: 'Accept', exact: true }).click();
  await suggestions.getByRole('alert').filter({ hasText: /This deal has moved since the suggestion/ }).waitFor();
  assert.equal(await suggestions.getByRole('button', { name: 'Review updated card' }).count(), 0);
  await suggestions.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await suggestions.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1)[1].decision, 'dismiss');
  const priority = { item_id: `suggestion:${leading}`, base_version: notice.base_version, conversation_id: 'sample-conversation',
    proposal_id: next, reply_draft_id: null, sender: 'Sample Sender', subject: 'Sample message', suggestion: 'Share the plan',
    due_on: '2026-11-04', source_activity: { kind: 'email', id: log, happened_at: NOW.toISOString() } };
  mailRows = [priority, { ...priority, proposal_id: leading }];
  const mail = page.getByRole('region', { name: 'Mail priorities', exact: true });
  await mail.getByRole('button', { name: 'Refresh mail priorities', exact: true }).click();
  await mail.getByRole('button', { name: 'Sample Sender · Sample message', exact: true }).click();
  assert.equal(await mail.locator('li').count(), 1);
  const email = cardFor(/Email suggestions/);
  for (const [error, status, message] of [
    ['open_step_exists', 409, /You already have an open step for this client or deal/],
    ['invalid_field_value', 422, /This suggestion could not be saved/],
  ]) {
    proposalRefusals.set(next, [error, status]);
    await email.getByRole('button', { name: 'Accept', exact: true }).click();
    await email.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(await email.getByRole('button', { name: 'Retry same review request' }).count(), 0);
    await page.keyboard.press('Escape');
    await mail.getByRole('button', { name: 'Sample Sender · Sample message', exact: true }).click();
  }
  await email.getByRole('textbox', { name: 'Next step', exact: true }).fill('Share the revised plan');
  assert.equal(await email.getByRole('heading', { name: 'Possible new deal', exact: true }).count(), 0);
  await email.getByRole('button', { name: 'Accept', exact: true }).click();
  await email.getByRole('textbox', { name: 'Next step', exact: true }).waitFor({ state: 'detached' });
  assert.ok(writes.at(-1)[0].includes(next));
  assert.deepEqual(writes.at(-1)[1].edits, { what: 'Share the revised plan', due_on: '2026-11-04' });
  await reply.getByRole('button', { name: 'Open', exact: true }).click();
  await reply.getByText('Please share the sample plan.', { exact: true }).waitFor();
  await reply.getByRole('link', { name: 'Sample plan', exact: true }).waitFor();
  await reply.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited reply.');
  await reply.getByRole('button', { name: 'Save draft', exact: true }).click();
  await reply.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 1, subject: 'Sample reply', body: 'Edited reply.' });
  await reply.getByRole('button', { name: 'Send reply', exact: true }).click();
  await inbox.getByRole('region', { name: 'In motion and waiting', exact: true }).getByRole('button', { name: /^See all/ }).click();
  await inbox.getByText('Sending', { exact: true }).first().waitFor();
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 2, subject: 'Sample reply',
    body: 'Edited reply.', to: 'sender@example.test', cc: 'partner@example.test', document_ids: [dealId] });
  details.set(decline, { ...details.get(draft), draft_id: decline, version: 1, status: 'pending' });
  state.items.push({ ...notice, title: 'Another sample draft', item_id: `reply_draft:${decline}`, source_id: decline,
    source_type: 'email_proposal', deal_id: null, kind_label: 'Reply draft', source_version: '1', reply_draft_id: decline });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const declined = cardFor(/Another sample draft/);
  await declined.getByRole('button', { name: 'Open', exact: true }).click();
  await declined.getByRole('textbox', { name: 'Reason for declining' }).fill('Already answered.');
  await declined.getByRole('button', { name: 'Decline draft', exact: true }).click();
  await declined.waitFor({ state: 'detached' });
  assert.deepEqual(writes.at(-1)[1], { idempotency_key: writes.at(-1)[1].idempotency_key, version: 1, reason: 'Already answered.' });
  Object.assign(state.items.find(row => row.reply_draft_id === draft), { section: 'settled', disposition: 'settled',
    auto_settled: true, source_state: 'done', reply_draft_status: 'sent', completed_at: NOW.toISOString() });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const sent = inbox.getByRole('region', { name: 'Done today', exact: true });
  await sent.getByText(/^Sent /).waitFor();
  assert.equal(await sent.getByRole('button', { name: /Snooze|Undo/ }).count(), 0);

  const lease = inbox.locator('[data-inbox-row]').filter({ has: page.getByRole('link', { name: /Read the revised sample lease/ }) });
  await lease.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('dialog', { name: 'Snooze cards' }).getByRole('button', { name: /^1 hour/ }).click();
  const waiting = inbox.getByRole('region', { name: 'In motion and waiting', exact: true });
  if (await waiting.getByRole('button', { name: /^See all/ }).isVisible()) await waiting.getByRole('button', { name: /^See all/ }).click();
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
  await undoRestore('Wake', 'unsettle', undefined, true);
  await lease.getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await undoRestore('Show in inbox', 'settle');
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
