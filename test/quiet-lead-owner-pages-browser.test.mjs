import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateQuietFollowUps, validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';

const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
test('malformed owners are unavailable, omitted owners remain unrecorded', () => {
  for (const owner of [2, {}, [], false, '', '  ']) assert.throws(() => validateQuietFollowUps({ ...recording, proposals: [{ ...recording.proposals[0], owner }] }));
  const row = { ...recording.proposals[0] }; delete row.owner;
  validateQuietFollowUps({ ...recording, proposals: [row] });
});

test('quiet reads keep the latest cohort and clear on session refusal', async t => {
  const { JSDOM } = await import('jsdom');
  const { mountLeadsWorkspace } = await import('../js/leads-workspace-app.js');
  const { workspace, id } = await import('./leads-workspace-fixture.mjs');
  const dom = new JSDOM(await readFile(new URL('../leads.html', import.meta.url), 'utf8'), { url: 'http://localhost/leads', pretendToBeVisual: true });
  const { window: w } = dom;
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const pending = [];
  const app = mountLeadsWorkspace(w.document, {
    getActor: async () => 'joe',
    getWorkspace: async () => workspace(),
    getQuietFollowUps: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  t.after(() => { app.dispose(); w.close(); });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const button = w.document.getElementById('quietFilter');
  const badges = () => w.document.querySelectorAll('.lead-card .work-card-status').length;
  const snapshot = { ...recording, proposals: [{
    ...recording.proposals.find(row => row.subject_type === 'lead'), subject_id: id(1), ref: 'L-1', days_overdue: 2,
  }] };
  await app.refresh();
  assert.equal(button.disabled, true);
  pending.at(-1).resolve(snapshot); await settle();
  assert.equal(badges(), 1);
  button.click();
  assert.equal(w.document.getElementById('leadCount').textContent, '1 lead');
  pending[0].resolve({ ...snapshot, proposals: [] }); await settle();
  assert.equal(badges(), 1, 'superseded quiet read cannot replace the board cohort');
  await app.refresh(); pending.at(-1).reject({ code: 'network_error' }); await settle();
  assert.match(w.document.getElementById('quietStatus').textContent, /Quiet leads unavailable/);
  assert.equal(badges(), 0);
  assert.equal(w.document.getElementById('leadCount').textContent, '');
  await app.refresh(); pending.at(-1).resolve(snapshot); await settle();
  assert.equal(badges(), 1);
  await app.refresh(); pending.at(-1).reject({ status: 403 }); await settle();
  assert.equal(button.disabled, true);
  assert.equal(w.document.querySelectorAll('.lead-card').length, 0);
  assert.match(w.document.getElementById('leadBoardError').textContent, /Sign-in required/);
});

test('registered producer recording retains its pinned source and app parser contract', async () => {
  const root = new URL('./fixtures/quiet-lead-owner-pages/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  assert.equal(createHash('sha256').update(await readFile(new URL('producer.txt', root))).digest('hex'), provenance.sha256);
  assert.equal(provenance.revision, 'd2ca440d318e75f85f49c60b83700979cac57d51');
  validateQuietFollowUps(recording);
  assert.ok(recording.proposals.some(row => row.subject_type === 'vendor'));
  assert.equal(recording.sent, false);
  assert.equal(recording.tasks_created, false);
});

test('quiet badges and research clear on hidden, reject delayed reads, resume and retire on pagehide then dispose', async t => {
  const research = JSON.parse(await readFile(new URL('./fixtures/research-kind-filter/recordings.json', import.meta.url)));
  validateLeadWorkspace(research);
  validateLeadDetail(research.detail, research.detail.id);
  validateQuietFollowUps(recording);
  const proposal = { ...recording.proposals.find(row => row.subject_type === 'lead'), subject_id: research.detail.id, ref: research.detail.registry_ref, days_overdue: 2 };
  const quiet = { ...recording, proposals: [proposal] };
  validateQuietFollowUps(quiet);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await routeLeads(page);
  await page.route('**/leads', async route => {
    const html = await readFile(new URL('../leads.html', import.meta.url), 'utf8');
    const bootstrap = `<script type="module">
      const board = document.getElementById('leadBoard');
      board.id = 'fixtureBoard';
      const { mountLeadsWorkspace } = await import('/js/leads-workspace-app.js');
      board.id = 'leadBoard';
      window.fixture = { research: ${JSON.stringify(research)}, quiet: ${JSON.stringify(quiet)}, held: false, pending: [], reads: { board: 0, detail: 0, quiet: 0 } };
      const read = kind => {
        fixture.reads[kind]++;
        const value = structuredClone(kind === 'quiet' ? fixture.quiet : fixture.research);
        return fixture.held ? new Promise(resolve => fixture.pending.push({ kind, resolve: () => resolve(value) })) : Promise.resolve(value);
      };
      window.app = mountLeadsWorkspace(document, {
        getActor: async () => 'example-partner',
        getWorkspace: () => read('board'),
        getLeadDetail: () => read('detail'),
        getQuietFollowUps: () => read('quiet'),
      }, { mapFactory: async () => ({ update() {}, dispose() {} }) });
    </script>`;
    await route.fulfill({ contentType: 'text/html', body: html.replace('<script type="module" src="/js/leads-workspace-app.js"></script>', bootstrap) });
  });
  await page.goto('http://localhost/leads');
  const counts = () => page.evaluate(() => ({
    quiet: document.querySelectorAll('.lead-card .work-card-status').length,
    research: document.querySelectorAll('#sourcedResearch li').length,
  }));
  const mounted = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.lead-card .work-card-status').length === 1 && document.querySelectorAll('#sourcedResearch li').length === 4);
    assert.deepEqual(await counts(), { quiet: 1, research: 4 });
  };
  const holdReads = async () => {
    await page.evaluate(() => {
      fixture.held = true;
      window.lateDetail = app.readDetail(fixture.research.detail.id, false);
      window.lateBoard = app.refresh();
    });
    await page.waitForFunction(() => ['board', 'detail', 'quiet'].every(kind => fixture.pending.some(read => read.kind === kind)));
  };
  const completeReads = async () => {
    await page.evaluate(async () => {
      for (const pending of fixture.pending.splice(0)) pending.resolve();
      await Promise.all([lateDetail, lateBoard]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  const hide = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { quiet: document.querySelectorAll('.lead-card .work-card-status').length, research: document.querySelectorAll('#sourcedResearch li').length };
  });
  const resume = () => page.evaluate(async () => {
    fixture.held = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await app.refresh();
    await app.readDetail(fixture.research.detail.id);
  });
  await page.waitForFunction(() => window.app?.state.identityReady);
  await page.evaluate(() => app.readDetail(fixture.research.detail.id));
  await mounted();
  assert.deepEqual(await hide(), { quiet: 0, research: 0 }, 'hidden clears both populated islands immediately');
  await resume();
  await mounted();
  await holdReads();
  const beforeResume = await page.evaluate(() => ({ ...fixture.reads }));
  assert.deepEqual(await hide(), { quiet: 0, research: 0 }, 'hidden clears both islands during reads');
  await completeReads();
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'hidden rejects all delayed completions');
  await resume();
  await mounted();
  const afterResume = await page.evaluate(() => fixture.reads);
  for (const kind of ['board', 'detail', 'quiet']) assert.ok(afterResume[kind] > beforeResume[kind], `visible return reads fresh ${kind}`);
  await holdReads();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    app.dispose();
    app.dispose();
  });
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'pagehide then repeated dispose clears both islands');
  await completeReads();
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'disposed islands reject all delayed completions');
  await page.evaluate(async () => {
    fixture.held = false;
    await app.refresh();
    await app.readDetail(fixture.research.detail.id);
  });
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'explicit reads cannot revive disposed islands');
});
