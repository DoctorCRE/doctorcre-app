import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { detail, emptyQuietFollowUps, leads, workspace } from './leads-workspace-fixture.mjs';
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
      const title = await page.getByRole('heading', { level: 1, name: 'Search' }).boundingBox();
      assert.ok(title.y < (await page.getByRole('searchbox', { name: 'Name, email or domain' }).boundingBox()).y);
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
  const deal = { id: 'd01', name: 'Demo Dental North', phase: 'site_selection', owner: 'joe' };
  const [lead] = leads;
  const record = (n, name, roles, kind = 'person') => ({ id: id(n), name, roles, kind, city: null, lead_id: roles.includes("lead") ? id(n) : null, deals: [] });
  const parties = [
    { ...record(2, 'Demo Practice 02', ['client', 'lead']), deals: [{ id: deal.id, name: deal.name }] },
    { ...record(3, lead.doctor_name, ['lead']), id: lead.party_id, lead_id: lead.id },
    { ...record(4, 'Demo Therapy Group', [], 'company'), id: 'demo-therapy' },
    record(5, 'Demo Partner 05', ['vendor'], 'company'),
  ];
  const legacy = {
    parties: [], deals: [], organizations: [], lead_client_links: [],
    connections: [{ from_name: parties[0].name, to_name: parties[2].name, from_ref: 'C-DEMO-2', to_ref: 'demo-therapy', kind: 'knows', note: null }],
    deals_via_link: [{ name: deal.name, phase: deal.phase, owner: deal.owner, client_ref: null, invoiced_on: null, closed_on: null, lane: null, outcome: null }],
    note: 'Synthetic search results.',
  };
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(4000);
      t.after(() => page.close());
      await page.addInitScript(({ theme, key }) => {
        localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
        localStorage.setItem(key, JSON.stringify([
          { name: 'Linked deals', query: 'Versioned linked', kinds: ['deals_via_link'] },
          { name: 'Legacy linked deals', query: 'Legacy linked', kinds: ['deals_via_link'] },
          { name: 'Connections', query: 'Legacy connections', kinds: ['connections'] },
        ]));
      }, { theme, key: scopedViewsKey });
      const reads = [];
      await page.route('**/mcp', route => {
        const { id, params } = route.request().postDataJSON();
        if (['find', 'find-and-catch-up'].includes(params.name)) reads.push(params.name);
        let payload = {};
        if (params.name === 'find') {
          const query = params.arguments.query;
          assert.equal(route.request().headers()['x-doctorcre-search'], query === 'Legacy connections' ? undefined : 'search.v1');
          payload = query.startsWith('Legacy ') ? legacy
            : { schema_version: 'search.v1', parties, deals: query === 'Versioned linked' ? [] : [deal] };
        }
        if (params.name === 'lead-board') {
          payload = { ...workspace(), ...(params.arguments.lead_id === lead.id && { detail: detail(lead) }) };
        }
        if (params.name === 'quiet-follow-ups') payload = emptyQuietFollowUps();
        return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
      });
      await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
      await page.route('**/api/v1/business/{clients,vendors}**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
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
      assert.equal(await page.getByRole('link', { name: parties[0].name, exact: true }).count(), 1);
      assert.match(await page.locator('#searchResults').innerText(), /Client · Lead/);
      assert.match(await page.locator('#searchResults').innerText(), /Site Selection · Joe/);
      assert.doesNotMatch(await page.locator('main').innerText(), /Ref |00000000|site_selection|Multiple matches|retired aliases/);
      const links = [
        [parties[0].name, `/clients?record=${id(2)}`, '#recordTitle'],
        [lead.doctor_name, `/leads?lead=${lead.id}`, '#leadDetail #detailTitle'],
        [parties[2].name, '/relationships?node=party%3Ademo-therapy', 'dialog[open] #relationshipTitle'],
        [parties[3].name, `/vendors?record=${id(5)}`, '#recordTitle'],
        [deal.name, `/deals?deal=${deal.id}`, '#panelTitle'],
      ];
      await page.screenshot({ path: new URL(`search-${width}-${theme}.png`, artifacts).pathname, fullPage: true });
      const searchUrl = `${server.origin}/search?mode=live&q=practice.example`;
      for (const [name, href, title] of links) {
        await t.test(`opens ${name} from Search`, async () => {
          await page.goto(searchUrl);
          await page.getByRole('heading', { name, exact: true }).getByRole('link').click();
          await page.waitForURL(`${server.origin}${href}`);
          await page.locator(title).and(page.getByRole('heading', { name, exact: true })).waitFor();
        });
      }
      await t.test('opens scopes saved by the prior app', async () => {
        await page.goto(searchUrl);
        const results = page.locator('#searchResults');
        await page.locator('[data-view="Linked deals"]').click();
        await results.getByRole('link', { name: deal.name, exact: true }).waitFor();
        assert.equal(await results.getByRole('heading', { name: lead.doctor_name, exact: true }).count(), 0);
        const savedAddress = new URL(page.url());
        savedAddress.searchParams.set('mode', 'live');
        await page.goto(savedAddress.href);
        await results.getByRole('link', { name: deal.name, exact: true }).waitFor();
        await page.locator('[data-view="Legacy linked deals"]').click();
        await results.getByRole('heading', { name: deal.name, exact: true }).waitFor();
        await page.locator('[data-view="Connections"]').click();
        await results.getByRole('link', { name: parties[2].name, exact: true }).waitFor();
        assert.equal(await results.getByRole('heading', { name: deal.name, exact: true }).count(), 0);
      });
    });
  }
});

test('Back restores a typed search and scope, and clearing removes it', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let releaseSeed;
  const seedReady = new Promise(resolve => { releaseSeed = resolve; });
  t.after(() => releaseSeed());
  await page.route('**/data/board-seed.json', async route => {
    await seedReady;
    await route.continue();
  });
  await page.goto(`${server.origin}/search?mode=fixture`);
  releaseSeed();
  await page.getByText('Saved on this device').waitFor({ state: 'attached' });
  await page.locator('#searchQuery').fill('Demo');
  await page.locator('#searchResults a').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'), 'Demo');
  const chip = page.locator('#searchChips [data-chip]').first();
  await chip.click();
  const selected = await chip.getAttribute('data-chip');
  const result = page.locator('#searchResults a').first();
  const destination = await result.getAttribute('href');
  await page.route(`**${destination}`, route => route.fulfill({ contentType: 'text/html', body: '<title>Record</title>' }));
  await result.click();
  // Back sent while the record page is still loading reaches a document Chromium is detaching.
  await page.waitForURL(new URL(destination, server.origin).href);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#searchQuery')?.value === 'Demo', null, { timeout: 3000 });
  await page.locator(`#searchChips [data-chip="${selected}"][aria-pressed="false"]`).waitFor();
  await page.locator('#searchResults a').first().waitFor();
  await page.locator('#searchQuery').fill('');
  await page.waitForURL(url => !url.searchParams.has('q'));
});

test('A late search response cannot restore an earlier query', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let finished;
  const responseFinished = new Promise(resolve => { finished = resolve; });
  let started;
  const first = new Promise(resolve => { started = resolve; });
  await page.route('**/mcp', async route => {
    const { id, params } = route.request().postDataJSON();
    if (params.name === 'find' && params.arguments.query === 'Earlier') {
      started();
      await delayed;
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ schema_version: 'search.v1', parties: [], deals: [] }) }] } } }).catch(() => {});
    if (params.name === 'find' && params.arguments.query === 'Earlier') finished();
  });
  await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.goto(`${server.origin}/search?mode=live`);
  await page.locator('#searchQuery').fill('Earlier');
  await first;
  await page.locator('#searchQuery').fill('');
  release();
  await responseFinished;
  await page.waitForFunction(() => document.querySelector('#searchState')?.dataset.state === 'idle');
  assert.equal(new URL(page.url()).searchParams.has('q'), false);
  assert.equal(await page.locator('#searchQuery').inputValue(), '');
  assert.equal(await page.locator('#searchResults a').count(), 0);
});

test('Back restores typing when leaving before the search debounce', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/record-for-search-test', route => route.fulfill({ contentType: 'text/html', body: '<title>Record</title>' }));
  await page.goto(`${server.origin}/search?q=Demo&kinds=deals`);
  await page.waitForFunction(() => document.querySelector('#searchQuery')?.value === 'Demo');
  const historyLength = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    const input = document.querySelector('#searchQuery');
    input.value = 'Demo Dental';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    location.assign('/record-for-search-test');
  });
  await page.waitForURL('**/record-for-search-test');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#searchQuery')?.value === 'Demo Dental', null, { timeout: 3000 });
  assert.equal(new URL(page.url()).searchParams.get('kinds'), 'deals');
  assert.equal(await page.evaluate(() => history.length), historyLength + 1);
  await page.waitForFunction(() => document.querySelector('#searchResults')?.getAttribute('aria-busy') === 'false');
});

test('Search keeps typing entered while the page loads', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let releaseLayout;
  const layoutReady = new Promise(resolve => { releaseLayout = resolve; });
  t.after(() => releaseLayout());
  let layoutRequested;
  const layoutRequest = new Promise(resolve => { layoutRequested = resolve; });
  await page.route('**/js/app-layout.js', async route => {
    layoutRequested();
    await layoutReady;
    await route.continue();
  });
  let releaseModule;
  const moduleReady = new Promise(resolve => { releaseModule = resolve; });
  t.after(() => releaseModule());
  let moduleRequested;
  const requested = new Promise(resolve => { moduleRequested = resolve; });
  await page.route('**/js/search.js', async route => {
    moduleRequested();
    await moduleReady;
    await route.continue();
  });
  const queries = [];
  await page.route('**/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    if (params.name === 'find') queries.push(params.arguments.query);
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ schema_version: 'search.v1', parties: [], deals: [] }) }] } } });
  });
  await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const navigation = page.goto(`${server.origin}/search?mode=live`);
  await Promise.all([requested, layoutRequest]);
  const input = page.locator('#searchQuery');
  await input.fill('Demo Dental');
  await input.evaluate(node => node.setSelectionRange(5, 5));
  releaseLayout();
  await page.locator('#appLayout').waitFor({ state: 'attached' });
  assert.equal(await input.evaluate(node => document.activeElement === node), true);
  assert.equal(await input.evaluate(node => node.selectionStart), 5);
  await page.keyboard.insertText('New ');
  releaseModule();
  await navigation;
  assert.equal(await input.evaluate(node => document.activeElement === node), true);
  assert.equal(await input.evaluate(node => node.selectionStart), 9);
  await page.waitForFunction(() => document.querySelector('#searchState')?.dataset.state === 'no_match');
  assert.equal(await page.locator('#searchQuery').inputValue(), 'Demo New Dental');
  assert.deepEqual(queries, ['Demo New Dental']);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'Demo New Dental');
});

for (const nativeMove of [true, false]) {
  test(`Search keeps IME composition through shell layout (state-preserving move ${nativeMove})`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    if (!nativeMove) await page.addInitScript(() => { Element.prototype.moveBefore = undefined; });
    let releaseLayout, releaseSearch, layoutRequested, searchRequested;
    const layoutGate = new Promise(resolve => { releaseLayout = resolve; });
    const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    const layoutRequest = new Promise(resolve => { layoutRequested = resolve; });
    const searchRequest = new Promise(resolve => { searchRequested = resolve; });
    t.after(() => { releaseLayout(); releaseSearch(); });
    await page.route('**/js/app-layout.js', async route => { layoutRequested(); await layoutGate; await route.continue(); });
    await page.route('**/js/search.js', async route => { searchRequested(); await searchGate; await route.continue(); });
    await page.route('**/mcp', route => {
      const { id } = route.request().postDataJSON();
      return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ schema_version: 'search.v1', parties: [], deals: [] }) }] } } });
    });
    await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
    const navigation = page.goto(`${server.origin}/search?mode=live`);
    await Promise.all([layoutRequest, searchRequest]);
    assert.equal(await page.evaluate(() => typeof Element.prototype.moveBefore === 'function'), nativeMove);
    const input = page.locator('#searchQuery');
    await input.focus();
    await input.evaluate(node => { window.compositionEvents = []; for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) node.addEventListener(type, event => window.compositionEvents.push([event.type, event.data])); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    releaseLayout();
    await page.locator('#appLayout').waitFor({ state: 'attached' });
    await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '日本' });
    assert.equal(await input.inputValue(), '日本');
    const events = await page.evaluate(() => window.compositionEvents);
    assert.deepEqual(events.filter(([type]) => type !== 'compositionupdate'), [['compositionstart', ''], ['compositionend', '日本']]);
    assert.ok(events.some(([type, data]) => type === 'compositionupdate' && data === 'に'));
    assert.ok(events.some(([type, data]) => type === 'compositionupdate' && data === '日本'));
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
    releaseSearch();
    await navigation;
    if (!nativeMove) {
      await page.locator('#searchForm button').focus();
      assert.equal(await input.evaluate(node => Boolean(node.closest('#appMainSlot'))), false);
      await page.locator('#appTodayToggle').focus();
      await page.locator('#appMainSlot #searchQuery').waitFor({ state: 'attached' });
    }
  });
}

test('Fallback waits for composition to end after focus leaves', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => { Element.prototype.moveBefore = undefined; });
  let releaseLayout, layoutRequested;
  const gate = new Promise(resolve => { releaseLayout = resolve; });
  const requested = new Promise(resolve => { layoutRequested = resolve; });
  t.after(() => releaseLayout());
  await page.route('**/js/app-layout.js', async route => { layoutRequested(); await gate; await route.continue(); });
  const navigation = page.goto(`${server.origin}/search?mode=fixture`);
  await requested;
  const input = page.locator('#searchQuery');
  await input.focus();
  await input.dispatchEvent('compositionstart', { data: '' });
  releaseLayout();
  await navigation;
  await page.locator('#appTodayToggle').focus();
  assert.equal(await input.evaluate(node => Boolean(node.closest('#appMainSlot'))), false);
  await input.dispatchEvent('compositionend', { data: '日本' });
  await page.locator('#appMainSlot #searchQuery').waitFor({ state: 'attached' });
});

test('The search control opens a lead in its Leads drawer', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const [lead] = leads;
  await page.route('**/mcp', route => {
    const { id, params } = route.request().postDataJSON();
    const payload = params.name === 'lead-board'
      ? { ...workspace(), ...(params.arguments.lead_id === lead.id && { detail: detail(lead) }) }
      : params.name === 'quiet-follow-ups' ? emptyQuietFollowUps() : {};
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.goto(`${server.origin}/search?mode=live`);
  await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
  await page.evaluate(async node => {
    const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
    openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [],
      read: async () => ({ board: { deals: [] }, network: { nodes: [node] } }) });
  }, { id: `party:${lead.party_id}`, record_id: lead.id, name: lead.doctor_name, kind: 'lead' });
  await page.getByRole('combobox', { name: 'Jump to' }).fill(lead.doctor_name);
  await page.getByRole('option', { name: `${lead.doctor_name} Contact`, exact: true }).click();
  await page.waitForURL(`${server.origin}/leads?lead=${lead.id}`);
  await page.locator('#leadDetail #detailTitle').and(page.getByRole('heading', { name: lead.doctor_name, exact: true })).waitFor();
});

test('Search holds still on a computer: one title, one-line rows, results scroll under the search box', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const parties = Array.from({ length: 30 }, (_, n) => ({ id: id(n + 1), name: `Demo Practice ${n + 1}`, kind: 'company', roles: ['client'], city: 'Demo City', lead_id: null, deals: [] }));
  await page.route('**/mcp', route => {
    const { id: rid, params } = route.request().postDataJSON();
    const payload = params.name === 'find' ? { schema_version: 'search.v1', parties, deals: [] } : {};
    return route.fulfill({ json: { jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.route('**/{auth/session,api/system-work/session}', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.goto(`${server.origin}/search?mode=live&q=Demo`);
  await page.locator('#searchCount').filter({ hasText: '30 results' }).waitFor();
  const titles = await page.getByRole('heading', { name: 'Search', exact: true }).evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.closest('#appTopbar') !== null));
  assert.deepEqual(titles, [true], 'the title shows once, in the top bar');
  const row = page.locator('.search-row').first();
  const [name, meta] = await Promise.all([row.locator('h3').boundingBox(), row.locator('p').boundingBox()]);
  assert.ok(Math.abs(name.y + name.height / 2 - (meta.y + meta.height / 2)) < 4, 'name and roles share one line');
  const box = await page.locator('#searchQuery').boundingBox();
  await page.locator('.search-row').last().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
  assert.deepEqual(await page.locator('#searchQuery').boundingBox(), box, 'the search box stays put');
  assert.ok(await page.locator('#saveViewButton').isVisible());
  assert.ok((await page.locator('#saveViewButton').boundingBox()).y + 32 <= 640);
});
