import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);

for (const width of [390, 1280]) test(`a checklist item opens its own sheet and preserves an unsent instruction at ${width}px`, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  const deal = seed.deals.find(d => d.id === 'd14');
  Object.assign(deal, { name: "Dr. Demo's Sample Deal, multidisciplinary practice", short_name: "Dr. Demo's Sample Deal", phase: 'Research', workspace_kind: 'team', operating_state: 'active', account_client_id: null,
    items: [{ id: 'demo-intro', title: 'Vendor Introductions', due_on: '2026-10-01', status: 'open', source_ref: 'capture:demo',
      bullets: [{ date: '2026-09-11', kind: 'call', text: 'Lender introduction discussed.' }, { date: null, kind: 'suggestion', text: 'Arrange a short call.' }] },
      { id: 'demo-study', title: 'Prelim Market Study', status: 'open', bullets: [] },
      { id: 'demo-etl', title: 'ETL not completed', status: 'open', bullets: [] }] });

  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ json: seed });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals');
  const card = page.locator('.kanban-column [data-id="d14"]');
  await card.waitFor({ timeout: 15000 });
  assert.equal(await card.locator('h4').textContent(), "Dr. Demo's Sample Deal, multidisciplinary practice");
  assert.equal(await card.locator('ol li').count(), 0);
  await card.locator('.card-open').click();
  const snapshot = page.getByRole('region', { name: 'Deal snapshot' });
  await snapshot.waitFor();
  assert.equal(await snapshot.locator('ol li').count(), 3);
  const itemsFit = await snapshot.locator('ol button').evaluateAll(buttons => buttons.every(button => {
    const { width, height } = button.getBoundingClientRect();
    return width >= 44 && height >= 44 && button.scrollWidth <= button.clientWidth;
  }));
  assert.ok(itemsFit, 'item titles wrap inside their buttons and keep a 44px target');
  assert.equal(await card.locator('.owner').getAttribute('title'), 'Owner: Joe');
  assert.equal(await card.locator('.next-line,.vendor-pills,.auto-move').count(), 0);
  await mkdir(new URL('out/test-artifacts/deal-items/', root), { recursive: true });
  await snapshot.screenshot({ path: new URL(`out/test-artifacts/deal-items/${width}-snapshot.png`, root).pathname });
  const itemButton = snapshot.getByRole('button', { name: 'Vendor Introductions', exact: true });
  if (width > 760) { await itemButton.focus(); await itemButton.press('Enter'); }
  else await itemButton.click();
  const sheet = page.getByRole('dialog', { name: 'Vendor Introductions', exact: true });
  await sheet.waitFor();
  assert.ok((await sheet.boundingBox()).width <= 560, 'an item sheet stays narrow enough for short facts');
  assert.equal(await sheet.locator('section li').first().textContent(), '2026-09-11 · Lender introduction discussed.');
  assert.equal(await sheet.locator('section p').count(), 0);
  assert.equal(await sheet.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.screenshot({ path: new URL(`out/test-artifacts/deal-items/${width}-detail.png`, root).pathname });
  await sheet.getByLabel('Tell Dr. CRE').fill('Arrange the introduction tomorrow.');
  assert.equal(await sheet.getByRole('button', { name: 'Save instruction' }).isDisabled(), true);
  assert.match(await sheet.textContent(), /Not submitted\. This control cannot send a request to Dr\. CRE\./);
  assert.equal(await sheet.getByLabel('Tell Dr. CRE').inputValue(), 'Arrange the introduction tomorrow.');
  await sheet.getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-item-status]')?.textContent === 'Item marked done');
  await page.waitForFunction(() => document.querySelectorAll('#recordPanel .deal-opening-snapshot ol li').length === 2);
  await sheet.getByRole('button', { name: 'Close item' }).click();
  assert.equal(await snapshot.isVisible(), true);
  assert.deepEqual(errors, []);
});
