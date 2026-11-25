import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const createLegacyInboxClient = rpc => createInboxClient((name, ...args) => ['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name) ? Promise.resolve({ error: 'unknown_tool' }) : rpc(name, ...args));
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot, shelves, createInboxClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
export const item = (item_id, fields = {}) => ({ completed_at: null, auto_settled: false, item_id, source_type: 'next_action', source_id: item_id, source_version: 'source:1', source_state: 'needs_attention', title: 'Synthetic follow-up', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: 'Demo practice', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001', ...fields });
const legacySnapshot = items => ({ ok: true, schema_version: 'home-inbox.v2', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: false });
const snapshot = items => ({ ...legacySnapshot(items), schema_version: 'home-inbox.v3', auto_settle_enabled: true });
test('actor snapshot rejects duplicate identities and refusal is not empty', () => {
  assert.throws(() => parseSnapshot(snapshot([item('a'), item('a')])));
  assert.throws(() => parseSnapshot({ ok: false, error: 'read_limit_exceeded' }));
  assert.deepEqual(parseSnapshot(snapshot([])).items, []);
});
test('Done is not Settled and current Working card remains reachable', () => {
  const state = parseSnapshot(snapshot([item('done', { source_state: 'done', unseen: true }), item('work', { source_state: 'working', section: 'working' }), item('settled', { disposition: 'settled', section: 'settled' })]));
  const placed = shelves(state.items, 'work');
  assert.deepEqual(placed.inbox.map(row => row.item_id), ['done']);
  assert.equal(placed.current.item_id, 'work');
  assert.equal(placed.working.length, 1);
  assert.equal(placed.settled[0].item_id, 'settled');
});

test('commands retain exact retry identity and inspect mixed and missing results', async () => {
  const { command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = []; let attempt = 0;
  const client = createLegacyInboxClient(async (name, args) => {
    if (name === 'read-home-inbox-v3') return snapshot([item('a', { disposition: 'settled', base_version: 'opaque:2' })]);
    calls.push({ name, args: structuredClone(args) });
    if (++attempt === 1) throw Error('Response lost');
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [
      { item_id: 'a', ok: true, item: item('a', { disposition: 'settled', base_version: 'opaque:2' }) },
      { item_id: 'b', ok: false, error: 'version_conflict', current_version: 'opaque:9' },
    ] };
  });
  const request = command('settle', [item('a'), item('b'), item('c')]);
  await assert.rejects(client.run(request), /Response lost/);
  const result = await client.run(request);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(result[0].item.disposition, 'settled');
  assert.equal(result[1].error, 'version_conflict');
  assert.match(result[2].error, /uncertain/);
  const offline = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try { await assert.rejects(client.run(request), /Offline/); assert.equal(calls.length, 2); }
  finally { Object.defineProperty(globalThis, 'navigator', offline); }
});

test('unexpected command results cannot confirm another item', async () => {
  const { command, parseResults } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const request = command('settle', [item('a')]);
  assert.throws(() => parseResults({ ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'other', ok: true, item: item('other') }] }, request), /uncertain/);
});

test('wire states must be strings and placement uses the canonical section', () => {
  for (const fields of [{ source_state: ['done'] }, { disposition: ['inbox'] }, { section: 'unknown' }]) assert.throws(() => parseSnapshot(snapshot([item('a', fields)])));
  const state = parseSnapshot(snapshot([item('a', { source_state: 'working', section: 'inbox' })]));
  assert.deepEqual(shelves(state.items).inbox.map(row => row.item_id), ['a']);
});

test('v2 preserves producer context, completion identity and opaque versions', () => {
  const parsed = parseSnapshot(snapshot([item('a'), item('loop', { deal_id: null, context_label: null, open_url: null })]));
  assert.equal(parsed.items[0].action_version, 7);
  assert.equal(parsed.items[0].base_version, 'opaque:1');
  assert.equal(parsed.items[1].deal_id, null);
  for (const fields of [{ action_id: null }, { action_version: null }, { action_version: '7' }, { action_version: 0 }, { action_version: 1.5 }, { action_id: 'bad' }, { deal_id: 'bad' }, { deal_id: undefined }, { action_id: undefined }, { action_version: undefined }]) {
    assert.throws(() => parseSnapshot(snapshot([item('bad', fields)])), JSON.stringify(fields));
  }
  assert.doesNotThrow(() => parseSnapshot(snapshot([item('update', { source_type: 'notification', kind_label: 'Update', action_id: null, action_version: null, deal_id: null, section: 'held' })])));
  assert.throws(() => parseSnapshot(snapshot([item('update', { source_type: 'notification', kind_label: 'Update' })])));
});

test('v1 command receipts recover v2 metadata through one authoritative read', async () => {
  const { command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = [];
  const request = command('settle', [item('a', { base_version: 'do-not-parse:007' })]);
  const client = createLegacyInboxClient(async (name, args) => {
    calls.push({ name, args });
    if (name === 'read-home-inbox-v3') return snapshot([item('a', { disposition: 'settled', section: 'settled', base_version: 'next:opaque', context_label: 'Updated deal' })]);
    const { context_label, due_on, open_url, kind_label, merged_source_ids, action_id, action_version, deal_id, ...legacy } = item('a', { disposition: 'settled', section: 'settled', base_version: 'next:opaque' });
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'a', ok: true, item: legacy }] };
  });
  const [result] = await client.run(request);
  assert.equal(result.item.context_label, 'Updated deal');
  assert.equal(result.item.action_version, 7);
  assert.equal(result.ok, true);
  assert.equal(result.item.base_version, 'next:opaque');
  assert.equal(command('unsettle', [result.item]).args.items[0].base_version, 'next:opaque');
  assert.deepEqual(calls.map(call => call.name), ['settle-home-inbox', 'read-home-inbox-v3']);
  assert.equal(calls[0].args.items[0].base_version, 'do-not-parse:007');
});

test('source links use only supported producer destinations', async () => {
  const built = await build({ entryPoints: ['src/ui/home/routes.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { recordRoutes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
  for (const open_url of [null, 'javascript:alert(1)', 'https://example.com', '//example.com', '/\\example.com', '/missing-page']) assert.equal(recordRoutes.source(item('a', { open_url })), null);
  const url = '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step';
  assert.equal(recordRoutes.source(item('a', { open_url: url })), url);
});

for (const change of ['snooze', 'source edit']) for (const retry of [false, true]) test(`newer ${change} readback cannot authorize Undo${retry ? ' after exact-key retry' : ''}`, async () => {
  const { command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const receipt = item('a', { disposition: 'settled', section: 'settled', base_version: 'receipt:2' });
  const current = item('a', { ...receipt, base_version: 'later:3', ...(change === 'snooze' ? { disposition: 'snoozed', section: 'snoozed', snoozed_until: '2099-01-01T00:00:00Z' } : { title: 'Edited elsewhere', source_version: 'source:2', action_version: 8, context_label: 'New deal', due_on: '2026-11-06' }) });
  const writes = [];
  const client = createLegacyInboxClient(async (name, args) => {
    if (name === 'read-home-inbox-v3') return snapshot([current]);
    writes.push(structuredClone(args));
    if (retry && writes.length === 1) throw Error('Response lost');
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'a', ok: true, item: receipt }] };
  });
  const request = command('settle', [item('a')]);
  if (retry) await assert.rejects(client.run(request), /Response lost/);
  const [result] = await client.run(request);
  assert.equal(result.ok, false, 'the older command must not offer Undo against a newer version');
  assert.equal(result.error, 'intervening_change');
  assert.deepEqual(result.current_item, current, 'the caller can display the newer state');
  if (retry) assert.deepEqual(writes[0], writes[1]);
});

 test('completion receipt authorizes only its exact task version and event', async () => {
  const { taskCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = [];
  const event = '00000000-0000-0000-0000-000000000009';
  const client = createLegacyInboxClient(async (name, args) => {
    calls.push({ name, args });
    if (name === 'read-home-inbox-v3') return snapshot([item('a', { source_state: 'done', section: 'done', action_version: 8 })]);
    return { ok: true, action_id: item('a').action_id, status: 'done', version: 8, completion_event_id: event };
  });
  const [result] = await client.run(taskCommand('complete', item('a')));
  assert.equal(result.ok, true);
  const undo = taskCommand('reopen', result.item, result.receipt);
  assert.equal(undo.args.base_version, 8);
  assert.equal(undo.args.completion_event_id, event);
  assert.equal(undo.args.action_id, item('a').action_id);
  assert.equal(calls[0].name, 'complete-one-action');
  assert.equal(calls[0].args.base_version, 7);
  assert.equal('items' in calls[0].args, false);
 });

for (const laterVersion of [9, 10]) for (const lost of [false, true]) test(`completion cannot authorize a newer version ${laterVersion}, lost response ${lost}`, async () => {
  const { taskCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const writes = [];
  const client = createLegacyInboxClient(async (name, args) => {
    if (name === 'read-home-inbox-v3') return snapshot([item('a', { source_state: 'done', section: 'done', action_version: laterVersion })]);
    writes.push(structuredClone(args));
    if (lost && writes.length === 1) throw Error('Response lost');
    return { ok: true, action_id: item('a').action_id, status: 'done', version: 8, completion_event_id: '00000000-0000-0000-0000-000000000009' };
  });
  const request = taskCommand('complete', item('a'));
  if (lost) await assert.rejects(client.run(request), /Response lost/);
  const [result] = await client.run(request);
  assert.equal(result.ok, false); assert.equal(result.error, 'intervening_change');
  assert.equal(result.current_item.action_version, laterVersion);
  if (lost) assert.deepEqual(writes[0], writes[1]);
});
for (const invalid of [
  {},
  { completion_event_id: null },
  { completion_event_id: 'not-an-event' },
  { completion_event_id: '00000000-0000-0000-0000-000000000009', action_id: '00000000-0000-0000-0000-000000000099' },
]) test(`invalid completion receipt refuses confirmation and retains exact retry ${JSON.stringify(invalid)}`, async () => {
  const { taskCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = [];
  let valid = false;
  const client = createLegacyInboxClient(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'read-home-inbox-v3') return snapshot([item('a', { source_state: 'done', section: 'done', action_version: 8 })]);
    return { ok: true, action_id: item('a').action_id, status: 'done', version: 8, ...(valid ? { completion_event_id: '00000000-0000-0000-0000-000000000009' } : invalid) };
  });
  const request = taskCommand('complete', item('a'));
  await assert.rejects(client.run(request), /Completion (event|receipt) unreadable/);
  assert.deepEqual(calls.map(call => call.name), ['complete-one-action'], 'invalid receipts cannot authorize readback');
  assert.throws(() => taskCommand('reopen', item('a')), /Can't undo/);
  valid = true;
  const [result] = await client.run(request);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(result.ok, true);
  assert.equal(taskCommand('reopen', result.item, result.receipt).args.completion_event_id, '00000000-0000-0000-0000-000000000009');
  assert.throws(() => taskCommand('reopen', result.item, { ...result.receipt, action_id: '00000000-0000-0000-0000-000000000099' }), /Can't undo/);
  assert.throws(() => taskCommand('complete', item('working', { source_state: 'working' })), /cannot be marked done/);
});


test('v5 watch notification routes to its exact client record', async () => {
  const contract = JSON.parse(await readFile('contracts/carr-interface.v1/home_inbox_contract.json', 'utf8'));
  assert.equal(contract.read, 'read-home-inbox-v5');
  const url = '/clients?record=00000000-0000-4000-8000-000000000002';
  const card = item('notification:watch', { source_type: 'notification', source_id: '00000000-0000-4000-8000-000000000009', kind_label: 'Update', open_url: url, action_id: null, action_version: null, waiting_version: 0, waiting_on: null });
  for (const field of Object.keys(contract.projection.item_fields)) assert.ok(Object.hasOwn(card, field) || field === 'review_reference', field);
  const client = createInboxClient(async name => {
    assert.equal(name, contract.read);
    return { ...snapshot([card]), schema_version: contract.schema_version };
  });
  const parsed = await client.read();
  const built = await build({ entryPoints: ['src/ui/home/routes.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { recordRoutes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
  assert.equal(recordRoutes.source(parsed.items[0]), url);
  for (const open_url of ['/clients', '/clients?record=bad', '/clients?record=', '/clients?record=00000000-0000-4000-8000-000000000002&record=00000000-0000-4000-8000-000000000003']) assert.equal(recordRoutes.source({ ...parsed.items[0], open_url }), null);
  for (const open_url of ['/deals?deal=demo', '/calls?session=demo', '/doc-chats?conversation=demo']) assert.equal(recordRoutes.source({ ...parsed.items[0], open_url }), open_url);
  for (const open_url of ['/updates', '/updates?notification=demo', '/notifications?watch=demo']) assert.equal(recordRoutes.source({ ...parsed.items[0], open_url }), null);
});

test('engine Home returns previously hidden work and wakes a snooze through unsnooze', async () => {
  const target = item('next_action:example', { disposition: 'settled', section: 'settled', waiting_version: 0, waiting_on: null });
  const engineSnapshot = { ...snapshot([target]), schema_version: 'home-inbox.v5', engine_marks: true };
  const parsed = parseSnapshot(engineSnapshot).items[0];
  assert.equal(parsed.section, 'inbox');
  assert.equal(parsed.disposition, 'inbox');
  assert.equal(parsed.base_version, target.base_version);
  const calls = [];
  const client = createInboxClient(async (name, args) => {
    if (name === 'read-home-inbox-v5') return engineSnapshot;
    calls.push(args.action);
    return { ok: true, item_id: target.item_id, base_version: target.base_version, previous: { disposition: 'snoozed', snoozed_until: '2099-01-01T00:00:00Z' } };
  });
  const { command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  await client.run(command('unsnooze', [parsed]));
  assert.deepEqual(calls, ['unsnooze']);
});

test('engine card Drop selects the reason-bearing door and confirms no Undo receipt', async () => {
  const { dropCommand, dropTarget } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const id = '00000000-0000-0000-0000-000000000001';
  const base = item(`next_action:${id}`, { action_id: id, engine_marks: true });
  const draft = { ...base, item_id: `reply_draft:${id}`, source_type: 'email_proposal', source_version: '3', reply_draft_id: id, reply_draft_status: 'pending' };
  const suggestion = { ...base, item_id: `suggestion:${id}`, source_type: 'email_proposal', suggestions: [{ id }], home_proposal_drop: true };
  const update = { ...base, item_id: `notification:${id}`, source_type: 'notification', kind_label: 'Update', home_mark_drop: true };
  assert.equal(dropTarget({ ...suggestion, home_proposal_drop: undefined }), null);
  assert.equal(dropTarget({ ...update, home_mark_drop: undefined }), null);
  assert.equal(dropTarget({ ...base, engine_marks: undefined }), null);
  assert.equal(dropTarget({ ...update, source_type: 'fact_review', kind_label: 'Fact review' }), null);
  assert.throws(() => dropCommand(base, '   '));

  for (const [card, verb, receipt] of [
    [base, 'end-engine-home-step', { next_step_id: id, status: 'cancelled' }],
    [draft, 'dismiss-engine-home-draft', { draft_id: id, status: 'dismissed' }],
    [suggestion, 'decide-engine-home-proposal', { proposal_id: id, status: 'dismissed' }],
    [update, 'save-engine-home-mark', { ok: true, item_id: update.item_id }],
  ]) {
    const calls = [];
    const client = createInboxClient(async (name, args) => {
      if (name === 'read-home-inbox-v5')
        return { ...snapshot([]), schema_version: 'home-inbox.v5', engine_marks: true };
      calls.push([name, args]);
      if (calls.length === 1) throw Error('Response lost');
      return receipt;
    });
    const command = dropCommand(card, '  Work moved.  ');
    await assert.rejects(client.run(command), /Response lost/);
    const [result] = await client.run(command);
    assert.equal(result.ok, true);
    assert.equal(result.item, null);
    assert.equal(result.undo, undefined);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[1][0], verb);
    assert.equal(calls[1][1].reason, 'Work moved.');
  }
});

test('a grouped card writes every step it covers under its own key and reports each result', async () => {
  const { coverCommand, parseItem } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const ids = [11, 12, 13, 14].map(n => `00000000-0000-0000-0000-0000000000${n}`);
  const covers = ids.map((id, index) => ({ item_id: `next_action:${id}`, base_version: `${index + 3}:0:inbox`, action_id: id, action_version: index + 3, record_name: null }));
  const card = item(covers[0].item_id, { action_id: ids[0], action_version: 3, base_version: covers[0].base_version, merged_source_ids: ids, covers });
  assert.equal(parseItem(card, true, true, true).covers.length, 4);
  assert.equal(parseItem({ ...card, covers: undefined }, true, true, true).covers, undefined, 'a card without covers is its own step');
  assert.equal(parseItem({ ...card, covers: [covers[0]] }, true, true, true).covers, undefined);
  assert.throws(() => parseItem({ ...card, covers: covers.slice(1) }, true, true, true), /unreadable reminders/);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  for (const [change, verb] of [[{ change: 'complete' }, 'end-engine-home-step'], [{ change: 'drop', reason: ' Work moved. ' }, 'end-engine-home-step'], [{ change: 'snooze', until }, 'save-engine-home-mark']]) {
    const calls = [];
    const client = createInboxClient(async (name, args) => {
      if (name === 'read-home-inbox-v5') return { ...snapshot([]), schema_version: 'home-inbox.v5', engine_marks: true };
      calls.push(args);
      const target = args.id ?? args.item_id.slice('next_action:'.length);
      if (target === ids[1]) return { error: 'step_ended', http_status: 409 };
      if (target === ids[2]) return { error: 'version_conflict', http_status: 409 };
      return args.id
        ? { next_step_id: args.id, status: args.resolution, change_id: 9 }
        : { ok: true, item_id: args.item_id, base_version: 'next', previous: { disposition: null, snoozed_until: null } };
    });
    const results = await client.run(coverCommand(covers, change));
    assert.equal(calls.length, 4, `${change.change} writes each covered step`);
    assert.equal(new Set(calls.map(args => args.idempotency_key)).size, 4, 'each step has its own retry key');
    if (verb === 'end-engine-home-step') assert.deepEqual(calls.map(args => [args.id, args.base_version, args.resolution, args.reason]), covers.map(c => [c.action_id, c.action_version, change.change === 'drop' ? 'cancelled' : 'done', change.reason?.trim()]));
    else assert.deepEqual(calls.map(args => [args.item_id, args.base_version, args.until]), covers.map(c => [c.item_id, c.base_version, until]));
    assert.deepEqual(results.map(result => result.ok), [true, change.change !== 'snooze', false, true], 'a step already ended counts as finished; a refusal is reported for that step only');
  }
  assert.throws(() => coverCommand(covers, { change: 'drop', reason: ' ' }));
});

test('engine inbox cards drop through the route the engine accepts, with no Drop on Tour feedback or Fact review', async () => {
  const { dropTarget } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const id = '00000000-0000-0000-0000-000000000001';
  const engine = (item_id, source_type, kind_label, fields = {}) => item(item_id, {
    source_type, kind_label, engine_marks: true, section: 'inbox', source_state: 'needs_attention',
    home_mark_drop: true, home_proposal_drop: true, action_id: null, action_version: null, ...fields,
  });
  const pendingReply = engine(`reply_draft:${id}`, 'email_proposal', 'Reply draft', {
    source_version: '2', reply_draft_id: id, reply_draft_status: 'pending',
  });
  const failedReply = (failure_reason) => engine(`reply_draft:${id}`, 'email_proposal', 'Reply draft', {
    source_state: 'failed', source_version: '3', reply_draft_id: id, reply_draft_status: 'failed', failure_reason,
  });
  const bareSuggestion = engine(`suggestion:${id}`, 'email_proposal', 'Suggestion');
  assert.deepEqual(dropTarget(engine(`capture_post_call_action:${id}`, 'capture_post_call_action', 'Call follow-up')), { kind: 'mark' });
  assert.deepEqual(dropTarget(engine(`notification:${id}`, 'notification', 'Update')), { kind: 'mark' });
  assert.deepEqual(dropTarget(pendingReply), { kind: 'draft', id, version: 2 });
  assert.deepEqual(dropTarget(bareSuggestion), { kind: 'suggestions', ids: [id] });
  assert.deepEqual(dropTarget(failedReply('invalid_submission')), { kind: 'mark' });
  for (const reason of ['aborted_before_dispatch', 'submission_recipients_invalid', 'unconfirmed_after_30'])
    assert.equal(dropTarget(failedReply(reason)), null, reason);
  assert.equal(dropTarget({ ...failedReply('invalid_submission'), home_mark_drop: undefined }), null);
  assert.equal(dropTarget({ ...pendingReply, reply_draft_status: 'approved' }), null);
  assert.equal(dropTarget({ ...bareSuggestion, home_proposal_drop: undefined }), null);
  assert.equal(dropTarget({ ...bareSuggestion, suggestions: [{ id }], home_proposal_drop: undefined }), null);
  assert.equal(dropTarget(engine(`notification:${id}`, 'notification', 'Tour feedback')), null);
  assert.equal(dropTarget(engine(`tour_feedback:${id}`, 'tour_feedback', 'Tour feedback')), null);
  assert.equal(dropTarget(engine(`notification:${id}`, 'notification', 'Fact review')), null);
  assert.equal(dropTarget(engine(`notification:${id}`, 'fact_review', 'Update')), null);
});

test('engine suggestion refusals say drop, never dismiss', async () => {
  const review = await build({ entryPoints: ['src/ui/home/engine-review.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { proposalRefusal } = await import(`data:text/javascript;base64,${Buffer.from(review.outputFiles[0].contents).toString('base64')}`);
  for (const payload of [
    { http_status: 409, error: 'version_conflict', current_stage: 'x' },
    { http_status: 409, error: 'version_conflict' },
    { http_status: 409, error: 'open_step_exists' },
    { http_status: 422, error: 'other' },
  ]) {
    const text = proposalRefusal({ payload });
    assert.match(text, /drop/i, payload.error);
    assert.doesNotMatch(text, /ismiss/, payload.error);
  }
});

test('engine Home v5 reads open and completed work without settlement fields', () => {
  const { auto_settled, explicit_unsettle, ...open } = item('next_action:open', {
    waiting_version: 0, waiting_on: null,
  });
  const done = { ...open, item_id: 'next_action:done', source_state: 'done', section: 'done', completed_at: '2026-11-19T18:00:00Z' };
  const read = parseSnapshot({
    ok: true, schema_version: 'home-inbox.v5', engine_marks: true, truncated: false, limit: 1000,
    working_collapsed: true, items: [open, done],
  });
  assert.deepEqual(read.items.map(row => row.section), ['inbox', 'done']);
  assert.equal('auto_settle_enabled' in read, false);
  for (const row of read.items) {
    assert.equal('explicit_unsettle' in row, false);
    assert.equal('auto_settled' in row, false);
  }
});
