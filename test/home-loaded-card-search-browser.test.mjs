import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { context as buildContext } from 'esbuild';
import { fileURLToPath } from 'node:url';
async function syntheticCards() {
  const compiler = await buildContext({ stdin: { contents: "export {fixtureInboxRpc} from './src/ui/home/fixture'; export {createInboxClient,parseSnapshot} from './src/ui/home/inbox';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' });
  let compiled;
  try { compiled = await compiler.rebuild(); } finally { await compiler.dispose(); }
  const { fixtureInboxRpc, parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const raw = fixtureInboxRpc();
  const snapshot = parseSnapshot(await raw('read-home-inbox-v5', {}));
  return { snapshot, parseSnapshot, rpc: async (name, args) => {
    const value = await raw(name, args);
    if (name === 'read-home-inbox-v5') parseSnapshot(value);
    return value;
  } };
}

let outDir;
before(async () => { outDir = temporaryDirectory('loaded-search-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));
async function setup(t, width = 1440, theme = 'light', review = false, card = null) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.clock.install({ time: new Date('2026-11-06T16:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const fixture = await syntheticCards();
  let snapshot = fixture.snapshot;
  if (review) snapshot = fixture.parseSnapshot({ ...snapshot, items: snapshot.items.map((item, index) => index ? item : { ...item, review_reference: { kind: 'action', item_id: item.item_id, source_version: item.source_version, operations: ['complete-one-action'] } }) });
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push(name);
    let payload;
    if (name === 'read-home-inbox-v5') payload = fixture.parseSnapshot(snapshot);
    else if (name === 'read-home-review') {
      const item = snapshot.items[0];
      payload = { ok: true, schema_version: 'home-review.v1', reference: item.review_reference, detail: { title: item.title }, operations: [{ verb: 'complete-one-action', args: { action_id: item.action_id, base_version: item.action_version } }] };
    } else if (name === 'complete-one-action' || name === 'reopen-one-action') {
      payload = await fixture.rpc(name, args);
      snapshot = fixture.parseSnapshot(await fixture.rpc('read-home-inbox-v5', {}));
    } else payload = { items: [] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/?mode=live${card ? `&card=${encodeURIComponent(card)}` : ''}`);
  await page.getByRole('region', { name: 'Reminders', exact: true }).waitFor();
  return { page, fixture, calls, update: value => { snapshot = fixture.parseSnapshot(value); } };
}
for (const destination of ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000099', 'bad']) test(`watch Home source selects exact client or visibly refuses ${destination}`, async t => {
  const { directoryFixture } = await import('./fixtures/vendor-directory.synthetic.mjs');
  const { page, fixture, update } = await setup(t);
  const card = { ...fixture.snapshot.items[0], item_id: 'notification:watch', source_id: '00000000-0000-4000-8000-000000000009', source_type: 'notification', kind_label: 'Update', title: 'Demo watched lease changed', source_state: 'needs_attention', disposition: 'inbox', section: 'inbox', open_url: `/clients?record=${destination}`, action_id: null, action_version: null, review_reference: null, due_on: null, deal_id: null };
  const contract = JSON.parse(await (await import('node:fs/promises')).readFile('contracts/carr-interface.v1/home_inbox_contract.json', 'utf8'));
  assert.equal(fixture.snapshot.schema_version, contract.schema_version);
  const snapshot = fixture.parseSnapshot({ ...fixture.snapshot, items: [card] });
  update(snapshot);
  const reads = [];
  await page.route('**/api/v1/business/**', route => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[5];
    if (id) reads.push(id);
    if (id === '00000000-0000-4000-8000-000000000099') return route.fulfill({ status: 404, json: { error: 'RECORD_NOT_FOUND' } });
    return route.fulfill({ json: directoryFixture(url.href) });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.fastForward(60_000);
  await mkdir('test-artifacts/home-loaded-card-search', { recursive: true });
  await page.getByRole('link', { name: card.title, exact: true }).click();
  if (destination.endsWith('002')) await page.screenshot({ path: 'test-artifacts/home-loaded-card-search/watch-home.png', fullPage: true });
  if (destination === 'bad') {
    await page.getByText('No linked record.', { exact: true }).waitFor();
    assert.equal(await page.locator('.inbox-source').count(), 0);
    assert.deepEqual(reads, []);
  } else {
    const link = page.locator('[data-inbox-row="notification:watch"] .inbox-source').first();
    assert.equal(await link.getAttribute('href'), card.open_url);
    await link.focus();
    await Promise.all([page.waitForURL('**/clients?record=*'), page.keyboard.press('Enter')]);
    assert.equal(new URL(page.url()).searchParams.get('record'), destination);
    if (destination.endsWith('099')) await page.getByRole('heading', { name: 'Not here', exact: true }).waitFor();
    else {
      await page.locator('#recordBody[data-record-id]').waitFor();
      assert.equal(await page.locator('#recordBody').getAttribute('data-record-id'), destination);
      assert.equal(await page.locator('#recordTitle').innerText(), 'Demo Practice 02');
      await page.screenshot({ path: 'test-artifacts/home-loaded-card-search/watch-client.png', fullPage: true });
    }
    assert.deepEqual(reads, [destination]);
  }
  assert.deepEqual(errors, []);
});
