import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { SAVED_VIEWS_KEY } from '../js/search-model.js';
const scopedViewsKey = `${SAVED_VIEWS_KEY}:joe`;

test('S2 saved search stays under the keyboard while its results update', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const artifacts = new URL('../out/test-artifacts/s2-verification/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) for (const [label, name] of [
    ['plain', 'Demo saved search'], ['punctuation', `Demo's "saved" <search> & view`],
  ]) {
    await t.test(`${width} ${theme} ${label}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 960 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ theme, key, name }) => {
        localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
        localStorage.setItem(key, JSON.stringify([{ name, query: 'Demo Dental', kinds: [] }]));
      }, { theme, key: scopedViewsKey, name });
      await page.route('**/api/**', route => route.fulfill({ json: {} }));
      await page.goto(`${server.origin}/search?mode=fixture&q=Demo`);
      const saved = page.getByRole('link', { name, exact: true });
      await saved.waitFor({ state: 'visible' });
      await saved.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#searchResults').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#searchQuery').inputValue(), 'Demo Dental');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.view), name);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.rename), name);
      await page.screenshot({ path: new URL(`search-${width}-${theme}-${label}.png`, artifacts).pathname });
      await page.locator('#resetViewsButton').click();
      assert.equal(await page.locator('[data-view]').count(), 0);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), scopedViewsKey), '[]');
      await page.locator('#saveViewName').fill('Demo replacement');
      await page.locator('#saveViewButton').click();
      assert.equal(await page.getByRole('link', { name: 'Demo replacement', exact: true }).isVisible(), true);
      page.once('dialog', dialog => dialog.accept('Demo renamed'));
      await page.locator('[data-rename="Demo replacement"]').click();
      assert.equal(await page.getByRole('link', { name: 'Demo renamed', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('link', { name: 'Demo replacement', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});

for (const answer of ['Demo renamed', null]) {
  test(`Search Rename ${answer === null ? 'cancel' : 'accept'} keeps keyboard focus`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.addInitScript(key => localStorage.setItem(key, JSON.stringify([
      {name: 'Demo saved search', query: 'Demo Dental', kinds: []},
      {name: 'Other saved search', query: 'Demo', kinds: []},
    ])), scopedViewsKey);
    await page.route('**/api/**', route => route.fulfill({json: {}}));
    await page.goto(`${server.origin}/search?mode=fixture&q=Demo`);
    const rename = page.locator('[data-rename="Demo saved search"]');
    await rename.focus();
    page.once('dialog', dialog => answer === null ? dialog.dismiss() : dialog.accept(answer));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.rename), answer || 'Demo saved search');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.view), 'Other saved search');
  });
}

test('Search Rename keeps duplicate names and queries consistent without replacing focused controls', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify([
    {name: 'First', query: 'First query', kinds: []},
    {name: 'Second', query: 'Second query', kinds: []},
  ])), scopedViewsKey);
  await page.route('**/api/**', route => route.fulfill({json: {}}));
  await page.goto(`${server.origin}/search?mode=fixture&q=Demo`);
  for (const name of ['Second', `Shared 'name' <&>`]) {
    page.once('dialog', dialog => dialog.accept(name));
    await page.locator('[data-rename]').first().focus();
    await page.keyboard.press('Enter');
  }
  assert.deepEqual(await page.locator('[data-view]').evaluateAll(nodes => nodes.map(node => ({
    name: node.dataset.view, text: node.textContent, query: new URL(node.href).searchParams.get('q'),
  }))), [
    {name: `Shared 'name' <&>`, text: `Shared 'name' <&>`, query: 'First query'},
    {name: `Shared 'name' <&>`, text: `Shared 'name' <&>`, query: 'Second query'},
  ]);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.rename), `Shared 'name' <&>`);
});

test('Global Search shows openable records with one count in both themes', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const artifacts = new URL('../out/test-artifacts/global-search/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const id = n => `00000000-0000-4000-8000-00000000000${n}`;
  const deal = { id: id(1), name: 'Demo Lease', phase: 'site_selection', owner: 'joe' };
  const record = (n, name, roles, kind = 'person') => ({ id: id(n), name, roles, kind, city: null, lead_id: roles.includes("lead") ? id(n) : null, deals: [] });
  const parties = [
    { ...record(2, 'Demo Person', ['client', 'lead']), deals: [{ id: deal.id, name: deal.name }] },
    record(3, 'Demo Prospect', ['lead']),
    record(4, 'Demo Company', [], 'company'),
    record(5, 'Demo Vendor', ['vendor'], 'company'),
  ];
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(4000);
      t.after(() => page.close());
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      const reads = [];
      await page.route('**/mcp', route => {
        const { id, params } = route.request().postDataJSON();
        if (params.name === 'find') assert.equal(route.request().headers()['x-doctorcre-search'], 'search.v1');
        if (['find', 'find-and-catch-up'].includes(params.name)) reads.push(params.name);
        const payload = params.name === 'find' ? { schema_version: 'search.v1', parties, deals: [deal] } : {};
        return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      });
      await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
      await page.goto(`${server.origin}/search?mode=live`);
      assert.deepEqual(reads, []);
      for (const label of ['Search by name', 'Scope', 'Saved views', 'Search coverage']) {
        assert.equal(await page.getByText(label, { exact: true }).isVisible(), false);
      }
      await page.locator('#searchQuery').fill('practice.example');
      await page.locator('#searchQuery').press('Enter');
      try {
        await page.locator('#searchCount').filter({ hasText: /^5 results$/ }).waitFor();
      } catch (error) {
        throw new Error(JSON.stringify({reads, screen: await page.locator('main').innerText()}), { cause: error });
      }
      assert.deepEqual(reads, ['find']);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.getByRole('link', { name: 'Demo Person', exact: true }).count(), 1);
      assert.match(await page.locator('#searchResults').innerText(), /Client · Lead/);
      assert.match(await page.locator('#searchResults').innerText(), /Site Selection · Joe/);
      assert.doesNotMatch(await page.locator('main').innerText(), /Ref |00000000|site_selection|Multiple matches|retired aliases/);
      const links = [
        ['Demo Person', `/clients?record=${id(2)}`],
        ['Demo Prospect', `/leads?lead=${id(3)}`],
        ['Demo Company', `/relationships?node=party%3A${id(4)}`],
        ['Demo Vendor', `/vendors?record=${id(5)}`],
        ['Demo Lease', `/deals?deal=${id(1)}`],
      ];
      for (const [name, href] of links) {
        assert.equal(await page.getByRole('heading', { name, exact: true }).getByRole('link').getAttribute('href'), href);
      }
      await page.screenshot({ path: new URL(`search-${width}-${theme}.png`, artifacts).pathname, fullPage: true });
      await page.goto(`${server.origin}/relationships?node=party%3Ademo-client`);
      await page.getByRole('dialog').getByRole('heading', { name: 'Demo Coastal Dental' }).waitFor();
    });
  }
});
