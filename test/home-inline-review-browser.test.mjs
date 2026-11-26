import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import axe from 'axe-core';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
// Below three columns an opened item covers the list and its close button reads Back.
const closeReview = /^(Close review|Back)$/;
const closeItem = /^(Close|Back)$/;
const test = (name, run) => nodeTest(name, async t => { try { await run(t); } catch (error) { console.error(error); throw error; } });
let outDir;
before(async () => { outDir = temporaryDirectory('inline-review-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('test-artifacts/inline-review', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
const id = '00000000-0000-0000-0000-000000000001';
const eventId = '00000000-0000-0000-0000-000000000002';
async function setup(t, { width = 1440, theme = 'light', kind = 'reply_draft', refusal = null, reference = true, missingRecipients = false, initialBody = 'Synthetic body', writeRefusal = null, waitingPerson = false, surface = '/', sourceType = null, sourceState = 'needs_attention', sourceUrl = null, contextLabel = null, dueOn = null, dealId = null } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const row = { waiting_version: 0, waiting_on: null, item_id: 'one', source_type: kind === 'action' ? 'next_action' : kind === 'reply_draft' ? 'email_proposal' : 'fact_review', source_id: kind === 'fact_review' ? JSON.stringify([id, 'term_months']) : id, source_version: 'v1', source_state: 'needs_attention', title: 'Synthetic review', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: kind === 'action' ? 'Task' : kind === 'reply_draft' ? 'Reply draft' : 'Fact review', merged_source_ids: [], action_id: kind === 'action' ? id : null, action_version: kind === 'action' ? 1 : null, deal_id: null, auto_settled: false, completed_at: null };
  if (waitingPerson) Object.assign(row, { waiting_version: 1, waiting_on: { identity: { kind: 'party', id, available: true, display_name: 'Demo reviewer' }, reason: 'Review the lease terms', evidence: ['call:synthetic'], version: 1 } });
  if (reference) row.review_reference = { kind, item_id: row.item_id, source_version: row.source_version, operations: kind === 'action' ? ['complete-one-action'] : kind === 'reply_draft' ? ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'] : ['resolve-fact-review'] };
  if (sourceType) Object.assign(row, { source_type: sourceType, kind_label: sourceType === 'capture_post_call_action' ? 'Call follow-up' : sourceType === 'notification' ? 'Update' : row.kind_label, action_id: sourceType === 'capture_post_call_action' ? id : null, action_version: sourceType === 'capture_post_call_action' ? 1 : null, review_reference: null });
  row.source_state = sourceState;
  row.open_url = sourceUrl;
  row.context_label = contextLabel;
  row.due_on = dueOn;
  row.deal_id = dealId;
  let version = 1, subject = 'Synthetic subject', body = initialBody, fail = refusal;
  const calls = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params; calls.push({ name, args });
    let payload = { items: [] };
    if (name === 'read-home-inbox-v5') payload = { ok: true, schema_version: 'home-inbox.v5', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: [row] };
    if (name === 'read-home-review') {
      if (fail && fail !== 'version_conflict' && fail !== 'uncertain' && fail !== 'after_save_change') payload = { error: fail };
      else if (args.source_version !== row.source_version) payload = { error: 'home_review_stale' };
      else {
        const bound = { proposal_id: id, base_version: version };
        const draft = { subject, body, ...(missingRecipients ? {} : { to: ['demo@example.test'], cc: ['copy@example.test'] }) };
        payload = { ok: true, schema_version: 'home-review.v1', reference: row.review_reference,
          detail: kind === 'action' ? { title: row.title } : kind === 'reply_draft' ? { reply_draft: draft, source: { sender: 'Demo sender', subject: 'Synthetic incoming email', occurred_at: '2026-11-03T02:00:00Z', evidence_quote: 'Can you confirm the tour time?' }, ...(missingRecipients ? { confirm_verb: null, preview_error: 'email_draft_copy_address_missing' } : {}) } : { canonical_fact: null, observations: [{ id: eventId, value: '60', unit: 'months', source: { document_ref: id, page_start: 1, page_end: 1, cited_text: 'Synthetic signed term is 60 months.' } }] },
          operations: kind === 'action' ? [{ verb: 'complete-one-action', args: { action_id: id, base_version: version } }] : kind === 'reply_draft' ? [{ verb: 'edit-email-draft', args: bound }, { verb: 'dismiss-email-proposal', args: bound }, ...(missingRecipients ? [] : [{ verb: 'submit-email-draft', args: { ...bound, ...draft } }])] : [{ verb: 'resolve-fact-review', args: { entity_ref: id, fact_key: 'term_months', base_version: 0, review_version: 'r1' }, decisions: ['approve', 'correct', 'reject'] }] };
      }
    }
    if (['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft', 'complete-one-action', 'resolve-fact-review', 'reopen-one-action'].includes(name)) {
      if (writeRefusal) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: writeRefusal }) }] } } });
      if (fail === 'uncertain') { fail = null; return route.abort(); }
      if (fail === 'version_conflict') { fail = null; version++; row.source_version = 'v2'; row.review_reference.source_version = 'v2'; payload = { error: 'version_conflict' }; }
      else {
        version++; row.source_version = `v${version}`; row.review_reference.source_version = row.source_version;
        if (name === 'edit-email-draft') { subject = args.subject; body = args.body; }
        else if (name === 'reopen-one-action') Object.assign(row, { completed_at: null, action_version: version, source_state: 'needs_attention', disposition: 'inbox', section: 'inbox', auto_settled: false });
        else Object.assign(row, { completed_at: new Date().toISOString(), waiting_on: null, waiting_version: row.waiting_version + 1, action_version: kind === 'action' ? version : null, source_state: 'done', disposition: 'settled', section: 'settled', auto_settled: true });
        payload = kind === 'action' ? { ok: true, action_id: id, status: name === 'reopen-one-action' ? 'open' : 'done', version, completion_event_id: eventId } : kind === 'fact_review' ? { ok: true, schema_version: 'fact-review.v1', review_receipt: { entity_ref: id, fact_key: 'term_months' } } : { ok: true, proposal_id: id, version };
        if (fail === 'after_save_change' && name === 'edit-email-draft') { version++; row.source_version = `v${version}`; row.review_reference.source_version = row.source_version; subject = 'Updated elsewhere'; fail = null; }
      }
    }
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}${surface}?mode=live`);
  await page.locator('[data-inbox-row="one"]').waitFor();
  return {
    page, calls, row, panel: page.getByRole('region', { name: 'Details for Synthetic review', exact: true }),
    reviseDraft(nextBody) {
      body = nextBody;
      row.source_version = `v${++version}`;
      row.review_reference.source_version = row.source_version;
    },
  };
}
for (const [name, options, expectedLink, expectedName] of [
  ['task with a deal', { kind: 'action', contextLabel: 'Demo practice', sourceUrl: '/deals?deal=synthetic', dueOn: '2026-10-01' }, '/deals?deal=synthetic', 'Demo practice'],
  ['task with a client', { kind: 'action', contextLabel: 'Demo client', sourceUrl: `/clients?record=${id}` }, `/clients?record=${id}`, 'Demo client'],
  ['task with a contact', { kind: 'action', contextLabel: 'Demo contact', sourceUrl: `/relationships?node=party%3A${id}` }, `/relationships?node=party%3A${id}`, 'Demo contact'],
  ['call follow-up', { kind: 'action', sourceType: 'capture_post_call_action', sourceUrl: '/calls?session=synthetic', contextLabel: 'Demo practice', dealId: id }, '/calls?session=synthetic', 'Call summary'],
  ['update', { kind: 'action', sourceType: 'notification', contextLabel: 'Demo practice update', sourceUrl: '/updates', dealId: id }, `/deals?deal=${id}`, 'Demo practice update'],
  ['unlinked completed task', { kind: 'action', reference: false, sourceState: 'done', surface: '/inbox' }],
]) test(`Home Open shows the exact ${name}`, async t => {
  const { page, panel, calls } = await setup(t, { width: 390, ...options });
  const opener = page.locator('[data-inbox-row] h3 a');
  await opener.click();
  await panel.waitFor();
  if (expectedLink) {
    assert.equal(await panel.getByRole('link', { name: expectedName, exact: true }).getAttribute('href'), expectedLink);
    if (name === 'call follow-up') assert.equal(await panel.getByRole('link', { name: 'Demo practice', exact: true }).getAttribute('href'), `/deals?deal=${id}`);
    if (options.dueOn) assert.equal(await panel.getByText('Oct 1, 2026', { exact: true }).count(), 1);
  } else {
    assert.equal(await panel.getByRole('button', { name: closeItem }).count(), 1);
    assert.equal(await panel.getByText('No linked record.', { exact: true }).count(), 1);
    assert.equal(await panel.getByRole('link').count(), 0);
    assert.equal(await panel.getByText('Synthetic review', { exact: true }).count(), 1);
  }
  assert.equal(calls.some(call => /^(complete|settle|snooze|edit|submit)-/.test(call.name)), false);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  assert.equal(await opener.evaluate(link => link === document.activeElement), true);
});
test('legacy Home reload opens the newest saved reply without applying an earlier edit', async t => {
  const { page, panel, calls, reviseDraft } = await setup(t);
  const openReview = page.locator('[data-inbox-row] h3 a');
  const message = panel.getByRole('textbox', { name: 'Message', exact: true });
  await openReview.click();
  await message.fill('Unsent legacy edit.');
  await page.keyboard.press('Escape');
  await openReview.click();
  assert.equal(await message.inputValue(), 'Unsent legacy edit.');
  reviseDraft('New saved legacy reply.');
  await page.reload();
  await openReview.click();
  assert.equal(await message.inputValue(), 'New saved legacy reply.');
  assert.equal(calls.some(call => /^(edit|submit)-email-draft$/.test(call.name)), false);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`inline reply edits, saves and explicitly submits ${width} ${theme}`, async t => {
  const { page, panel, calls } = await setup(t, { width, theme });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Subject', { exact: true }).waitFor();
  assert.match(await panel.textContent(), /Review this card.*Their email.*Demo sender.*Nov 2.*Synthetic incoming email.*Can you confirm the tour time\?.*Exact reply for review/s);
  assert.equal(await panel.getByLabel('Message', { exact: true }).inputValue(), 'Synthetic body');
  assert.equal(await panel.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
  assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
  await panel.getByLabel('Subject', { exact: true }).fill('Reviewed exact subject');
  await panel.getByLabel('Message', { exact: true }).fill('Reviewed exact body');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'submit-email-draft').length, 0);
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await panel.evaluate(async node => (await window.axe.run(node)).violations), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/inline-review/reply-${width}-${theme}.png`, fullPage: true });
  await panel.getByRole('button', { name: 'Submit reply for sending', exact: true }).click();
  await panel.getByText('Reply submitted to the existing sender. Delivery is not yet confirmed.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'submit-email-draft'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args.to, ['demo@example.test']); assert.deepEqual(writes[0].args.cc, ['copy@example.test']);
  assert.equal(writes[0].args.subject, 'Reviewed exact subject'); assert.equal(writes[0].args.body, 'Reviewed exact body');
  assert.equal(page.url().includes('/inbox'), false);
  await panel.getByRole('button', { name: closeReview }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Inbox cards');
});
test('conflict keeps text and reload binds a fresh version before another deliberate save', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'version_conflict' });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Message', { exact: true }).fill('Keep my local edits');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Review updated card', exact: true }).click();
  await panel.getByText('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message', { exact: true }).inputValue(), 'Keep my local edits');
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'edit-email-draft');
  assert.equal(writes[1].args.base_version, 2); assert.notEqual(writes[0].args.idempotency_key, writes[1].args.idempotency_key);
});
test('uncertain write retries only the identical frozen request', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'uncertain' });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Retry same review request', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'edit-email-draft'); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
});
for (const refusal of ['home_review_stale', 'home_review_resolved', 'home_review_unsupported', 'human_only_verb_requires_verified_partner']) test(`review safely refuses ${refusal}`, async t => {
  const { page, panel, calls } = await setup(t, { refusal });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByText(refusal === 'home_review_stale' ? 'This card changed. Your edits are kept. Review the updated card before submitting again.' : refusal === 'home_review_resolved' ? 'This card is already resolved. Refresh the inbox to see its current state.' : refusal === 'human_only_verb_requires_verified_partner' ? 'Sign in as the owning verified partner to review this card.' : 'This card cannot be reviewed here. Open its source record.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0); assert.equal(calls.filter(c => c.name === 'submit-email-draft').length, 0);
});
test('task review completes one canonical action and retains Undo receipt', async t => {
  const { page, panel, calls } = await setup(t, { kind: 'action' });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByRole('button', { name: 'Mark done', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: closeItem }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  assert.equal(calls.filter(c => c.name === 'complete-one-action').length, 1);
  assert.equal(calls.find(c => c.name === 'reopen-one-action').args.completion_event_id, eventId);
});
for (const dealId of [null, id]) test(`a fact review card ${dealId ? 'with' : 'without'} a deal offers no inline review, whose old save is gone`, async t => {
  const { page, panel, calls } = await setup(t, { kind: 'fact_review', dealId });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByRole('button', { name: closeItem }).waitFor();
  if (dealId) assert.equal(await panel.locator(`a[href="/deals?deal=${id}"]`).count(), 1);
  assert.equal(await panel.getByText('No linked record.', { exact: true }).count(), dealId ? 0 : 1);
  assert.equal(await panel.getByText('Review this card', { exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Save review', exact: true }).count(), 0);
  assert.equal(calls.filter(c => ['read-home-review', 'resolve-fact-review'].includes(c.name)).length, 0);
});
test('older producer without references keeps a navigable card', async t => {
  const { page, calls } = await setup(t, { reference: false });
  await page.locator('[data-inbox-row] h3 a').click();
  await page.getByText('The email and draft are unavailable for this card.', { exact: true }).waitFor();
  assert.ok(await page.getByRole('link', { name: 'Synthetic review', exact: true }).getAttribute('href'));
  assert.equal(calls.filter(c => c.name === 'read-home-review').length, 0);
});
test('keyboard review and rapid repeated activation make one deliberate write', async t => {
  const { page, panel, calls } = await setup(t);
  const opener = page.locator('[data-inbox-row] h3 a');
  await opener.focus(); await page.keyboard.press('Enter');
  const save = panel.getByRole('button', { name: 'Save draft', exact: true });
  await save.evaluate(button => { button.click(); button.click(); });
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('[data-inbox-row] h3 a'));
});
test('closing a loading review rejects late detail and sends no domain command', async t => {
  const { page, panel, calls } = await setup(t);
  let held;
  await page.route('**/mcp', route => {
    if (route.request().postDataJSON().params.name === 'read-home-review') { held = route; return; }
    return route.fallback();
  });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByText('Loading current evidence…', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await held?.fulfill({ json: { error: 'home_review_stale' } }).catch(() => {});
  assert.equal(await panel.count(), 0);
  assert.equal(calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name)).length, 0);
});

test('a newer draft after the save receipt requires explicit review and preserves local text', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'after_save_change' });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Message', { exact: true }).fill('Keep the reviewed local body');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Review updated card', exact: true }).click();
  await panel.getByText('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.', { exact: true }).waitFor();
  await panel.getByText('Current saved reply', { exact: true }).click();
  await panel.getByText('Updated elsewhere', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message', { exact: true }).inputValue(), 'Keep the reviewed local body');
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
});

for (const initialBody of ['Synthetic body', '']) test(`decline ignores invalid content with initial body ${initialBody ? 'present' : 'empty'}`, async t => {
  const { page, panel, calls } = await setup(t, { width: 390, initialBody });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Message', { exact: true }).fill('');
  await panel.getByLabel('Subject', { exact: true }).fill('');
  await panel.getByLabel('Reason for declining', { exact: true }).fill('Decline this synthetic draft');
  await panel.getByRole('button', { name: 'Decline draft', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'dismiss-email-proposal');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args.reason, 'Decline this synthetic draft');
  assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
});
for (const action of ['Save draft', 'Decline draft']) test(`unavailable send recipients preserve ${action}`, async t => {
  const { page, panel, calls } = await setup(t, { width: 390, missingRecipients: true });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByText('Sending unavailable: email_draft_copy_address_missing', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Submit reply for sending', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Decline draft', exact: true }).count(), 1);
  await panel.getByLabel('Message', { exact: true }).fill('Reviewed without recipients');
  await panel.getByLabel('Reason for declining', { exact: true }).fill('No reply needed');
  await panel.getByRole('button', { name: action, exact: true }).click();
  await panel.getByText(action === 'Save draft' ? 'Saved as a draft. Nothing was sent.' : 'This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  const writes = calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, action === 'Save draft' ? 'edit-email-draft' : 'dismiss-email-proposal');
  assert.equal('to' in writes[0].args || 'cc' in writes[0].args, false);
});
for (const writeRefusal of ['human_only_verb_requires_verified_partner', 'home_review_resolved']) test(`submitted review refuses ${writeRefusal}`, async t => {
  const { page, panel, calls } = await setup(t, { writeRefusal });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText(writeRefusal === 'home_review_resolved' ? 'This card is already resolved. Refresh the inbox to see its current state.' : 'Sign in as the owning verified partner to review this card.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
});
test('Escape closes unsaved edits without a write and returns focus', async t => {
  const { page, panel, calls } = await setup(t);
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Message', { exact: true }).fill('Unsaved local changes');
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  await page.waitForFunction(() => document.activeElement?.matches('[data-inbox-row] h3 a'));
  assert.equal(calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name)).length, 0);
});
test('save and send still require valid reply content', async t => {
  const { page, panel, calls } = await setup(t);
  await page.locator('[data-inbox-row] h3 a').click();
  for (const field of ['Message', 'Subject']) {
    await panel.getByLabel(field, { exact: true }).fill('');
    for (const name of ['Save draft', 'Submit reply for sending']) await panel.getByRole('button', { name, exact: true }).click();
    assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
    await panel.getByLabel(field, { exact: true }).fill('Reviewed content');
  }
});

test('decline requires a nonblank reason even when content is empty', async t => {
  const { page, panel, calls } = await setup(t, { initialBody: '' });
  await page.locator('[data-inbox-row] h3 a').click();
  await panel.getByLabel('Reason for declining', { exact: true }).fill('   ');
  await panel.getByRole('button', { name: 'Decline draft', exact: true }).click();
  await panel.getByText('Give a reason before declining this draft.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'dismiss-email-proposal').length, 0);
});

for (const width of [390, 1440]) for (const surface of ['/', '/inbox', '/inbox/card/one']) for (const [kind, sourceType, sourceState, sourceUrl] of [
  ['action', null, 'needs_attention', null],
  ['action', 'capture_post_call_action', 'needs_attention', null],
  ['reply_draft', null, 'needs_attention', null],
  ['reply_draft', 'email_proposal', 'failed', null],
  ['action', 'notification', 'needs_attention', '/notifications?watch=synthetic'],
  ['action', 'notification', 'needs_attention', '/deals?deal=synthetic'],
  ['action', 'notification', 'needs_attention', null],
  ['action', 'capture_session', 'needs_attention', '/deals?deal=synthetic'],
  ['action', 'capture_session', 'needs_attention', null],
  ['action', 'capture_session', 'working', null],
  ['fact_review', null, 'needs_attention', null],
]) test(`card finish control ${width} ${surface} ${sourceType || kind} ${sourceState} ${sourceUrl || 'unlinked'}`, async t => {
  const { page, panel, row } = await setup(t, { width, surface, kind, sourceType, sourceState, sourceUrl, waitingPerson: true });
  const card = page.locator('[data-inbox-row="one"]');
  const home = surface === '/';
  const opener = home ? card.locator('h3 a') : card.getByRole('button', { name: 'Open', exact: true });
  const finish = row.action_id && sourceState === 'needs_attention' ? 'Mark done' : home ? 'Review' : 'Open';
  if (home) assert.equal(await card.getByRole('button', { name: finish, exact: true }).count(), 1);
  else assert.equal(await card.getByRole('button', { name: finish, exact: true }).getAttribute('class'), 'inbox-primary');
  assert.equal(await opener.count(), 1);
  assert.equal(await card.getByRole('button', { name: 'Hide from inbox', exact: true }).count(), sourceState === 'working' || surface === '/' ? 0 : 1);
  if (sourceState === 'failed') {
    assert.equal(await card.getByText(home ? /Didn't go through/ : "This reply didn't send. Send it from your email, then press Hide from inbox.", { exact: !home }).count(), 1);
  }
  assert.equal(await card.getByText(/Work is in progress|Review card|Waiting on|Set waiting person|Correct waiting person/).count(), 0);
  await page.screenshot({ path: `test-artifacts/inline-review/finish-${width}-${surface === '/' ? 'home' : surface === '/inbox' ? 'inbox' : 'opened'}-${sourceType || kind}-${sourceState}${sourceUrl ? `-linked-${sourceUrl.split(/[/?]/)[1]}` : ''}.png`, fullPage: true });
  await card.screenshot({ path: `test-artifacts/inline-review/card-finish-${width}-${surface === '/' ? 'home' : surface === '/inbox' ? 'inbox' : 'opened'}-${sourceType || kind}-${sourceState}${sourceUrl ? `-linked-${sourceUrl.split(/[/?]/)[1]}` : ''}.png` });
  if (kind === 'reply_draft' && sourceState === 'needs_attention') {
    await opener.click();
    await panel.getByRole('button', { name: 'Submit reply for sending', exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Decline draft', exact: true }).count(), 1);
  }
});

for (const sourceUrl of ['/deals?deal=synthetic', 'https://invalid.example.test/record']) test(`opened completable card source ${sourceUrl}`, async t => {
  const { page } = await setup(t, { kind: 'action', surface: '/inbox/card/one', sourceUrl });
  const card = page.locator('[data-inbox-row="one"]');
  assert.equal(await card.getByRole('button', { name: 'Mark done', exact: true }).count(), 1);
  if (sourceUrl.startsWith('/deals')) {
    assert.equal(await card.getByRole('link', { name: 'Open deal', exact: true }).getAttribute('href'), sourceUrl);
    assert.equal(await card.getByRole('link', { name: /^Open / }).count(), 1);
  } else {
    assert.equal(await card.getByText("This link can't be opened here.", { exact: true }).count(), 1);
    assert.equal(await card.getByRole('link', { name: /^Open / }).count(), 0);
  }
});
