import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadBoardClient } from '../js/leads-client.js';
import { agendaSnapshot, readHomeDashboard, topNewLeads } from '../js/home-dashboard-model.js';

const now = Date.parse('2026-10-01T15:00:00Z');
const lead = score => ({ id: `demo-${score}`, name: 'Demo practice', stage: 'new', score, created_at: new Date(now).toISOString() });
test('R1 live lead decimals rank numerically while malformed score strings are excluded', async () => {
  const rows = ['98.00', '9.50', '80.25', '', ' ', '98x', '0x62', 'Infinity', '1e2', null].map(lead);
  const client = createLeadBoardClient({ fetchImpl: async () => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ leads: rows }) }] } })) });
  const ranked = topNewLeads(await client.getLeadBoard(), { now });
  assert.deepEqual(ranked.map(row => row.score), [98, 80.25, 9.5]);
});

test('R8 timed-out and disposed Home reads abort the live lead transport', async () => {
  const requests = [];
  const leads = createLeadBoardClient({ fetchImpl: (_path, init) => {
    requests.push(init);
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const client = { getHomeAgenda: async () => ({ schema_version: 'home-agenda.v1', actor: 'joe', deals: [] }), getLeadBoard: leads.getLeadBoard };
  for (let i = 0; i < 3; i++) await readHomeDashboard(client, { timeoutMs: 5 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(init => init.signal?.aborted));
  const controller = new AbortController();
  const pending = readHomeDashboard(client, { signal: controller.signal });
  controller.abort(); await pending;
  assert.equal(requests.at(-1).signal.aborted, true);
});

test('R12 malformed optional rows do not throw or remove valid independent agenda entries', () => {
  const board = { actor: 'joe', deals: [{ id: 'demo', name: 'Demo deal' }] };
  const details = new Map([['demo', { critical_dates: [null, 1, { id: 'demo-date', due_on: '2026-10-02', status: 'open' }],
    next_actions: [null, 1, {}, { id: 'demo-task', description: 'Demo task', status: 'open', due_on: '2026-10-01' }] }]]);
  const agenda = agendaSnapshot(board, details, { today: '2026-10-01' });
  assert.deepEqual(agenda.entries.map(row => row.key), ['task:demo-task', 'demo-date']);
  assert.deepEqual(agenda.failed, ['demo']);
});

const bundle = await (await import('esbuild')).build({ entryPoints: ['src/ui/home/review.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseReview } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { factCases } = await import('../scripts/prove-home-fact-review-source-page-range.mjs');
for (const c of factCases()) test(`fact source admission ${c.name}`, () => {
  const { response } = c;
  if (c.valid) {
    const review = parseReview(response, response.reference);
    assert.deepEqual(review.observations[0].source, response.detail.observations[0].source);
    assert.deepEqual(review.operations, response.operations);
  } else assert.throws(() => parseReview(response, response.reference), /not supported safely/);
});
test('fact review preserves reference and operation binding', () => {
  const { response } = factCases()[0];
  for (const change of [{ item_id: 'another' }, { source_version: 'v2' }, { kind: 'action' }, { operations: ['delete-record'] }]) {
    assert.throws(() => parseReview({ ...response, reference: { ...response.reference, ...change } }, response.reference), /not supported safely/);
  }
});

const engineBundle = await (await import('esbuild')).build({
  entryPoints: ['src/ui/home/engine-review.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
});
const { loadEngineReview, saveEngineReview } = await import(
  `data:text/javascript;base64,${Buffer.from(engineBundle.outputFiles[0].text).toString('base64')}`
);
const filingItem = { engine_marks: true, suggestions: [{ id: 'sample-proposal' }] };
const filingProposal = { proposal_id: 'sample-proposal', kind: 'possible_new_deal', evidence: 'Sample email' };
const deal = { kind: 'deal', label: 'Choose deal' };
const vendor = { kind: 'vendor', label: 'Choose vendor' };
test('Home keeps the exact filing choices from the proposal detail', async () => {
  for (const choices of [[deal, vendor], [vendor], undefined]) {
    const detail = await loadEngineReview(async () => ({
      ...filingProposal, ...(choices && { filing_choices: choices }),
    }), filingItem);
    assert.deepEqual(detail.proposals[0].filingChoices, choices);
  }
});

test('A filing review uses the proposal email ID even if the thread shows a display copy', async () => {
  const thread = ['first', 'display-copy', 'latest'].map((activity_id, index) => ({
    activity_id, happened_at: `2026-11-0${index + 1}T12:00:00Z`, body: 'Example message',
  }));
  for (const [activity_kind, activity_id, expected] of [
    ['email', 'origin', 'origin'],
    ['email', null, null],
    ['call', 'origin', null],
  ]) {
    const detail = await loadEngineReview(async () => ({
      ...filingProposal, thread, filing_choices: [deal, vendor],
      source_activity: { kind: 'email', id: 'display-copy' },
    }), { ...filingItem, suggestions: [{ id: filingProposal.proposal_id, activity_kind, activity_id }] });
    assert.equal(detail.proposals[0].filingEmailId, expected);
  }
});

test('Home treats only a 409 already_decided response as a settled filing', async () => {
  const request = { verb: 'decide-engine-home-proposal', args: {
    id: 'sample-proposal', decision: 'accept', vendor_id: 'sample-vendor', idempotency_key: 'sample-key',
  } };
  const settle = (error, http_status) => saveEngineReview(async (verb, body) => {
    assert.equal(verb, request.verb);
    assert.deepEqual(body, request.args);
    throw Object.assign(Error(error), { payload: { error, http_status } });
  }, filingItem, request);
  assert.equal(await settle('already_decided', 409), 'already_decided');
  await assert.rejects(settle('invalid_field_value', 422), { message: 'invalid_field_value' });
  await assert.rejects(settle('already_decided', 422), { message: 'home_review_resolved' });
});
