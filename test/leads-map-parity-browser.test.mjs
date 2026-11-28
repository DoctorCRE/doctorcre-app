import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { workspace, lead, id } from './leads-workspace-fixture.mjs';

test('lead tasks defer map assets until keyboard reveal and retain filters', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const requests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/maplibre|leads-territory\.geojson|leads-market-locations\.json/.test(path)) requests.push(path);
  });
  await routeLeads(page);
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  await page.locator('#marketFilter').selectOption('Mobile, AL');
  const ids = () => page.locator('#leadBoard .lead-card').evaluateAll(nodes => nodes.map(node => node.dataset.leadId));
  const before = await ids();
  assert.deepEqual(requests, [], 'opening and filtering leads must not request map assets');
  await page.getByRole('button', { name: 'Show territory', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.market-marker').first().waitFor();
  assert.equal(await page.getByText('Recorded territory conditions').count(), 0);
  assert.equal(await page.locator('#marketFilter').inputValue(), 'Mobile, AL');
  assert.deepEqual(await ids(), before);
  assert.equal(requests.filter(path => path.endsWith('leads-territory.geojson')).length, 1);
  assert.equal(requests.filter(path => path.endsWith('leads-market-locations.json')).length, 1);
  assert.ok(requests.some(path => path.endsWith('maplibre-gl.mjs')));
  const canvas = await page.locator('#territoryMap canvas').elementHandle();
  await page.locator('#marketFilter').selectOption('');
  await page.locator('#refreshBoard').click();
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  assert.equal(await canvas.evaluate(node => node.isConnected), true);
  assert.equal(requests.filter(path => path.endsWith('leads-territory.geojson')).length, 1);
});

test('phone territory markers appear only after the Census map is painted', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await routeLeads(page);
  const source = await readFile(new URL('../js/leads-territory-map.js', import.meta.url), 'utf8');
  // Observe the real renderer through its public read methods without changing its scheduling.
  await page.route('**/js/leads-territory-map.js', route => route.fulfill({ contentType: 'text/javascript',
    body: source.replace('const markers = new Map();', 'globalThis.territoryRenderer = map; const markers = new Map();') }));
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor({ state: 'attached' });
  const painted = await page.evaluate(() => ({ loaded: territoryRenderer.loaded(),
    land: territoryRenderer.queryRenderedFeatures({ layers: ['land'] }).length }));
  assert.equal(painted.loaded, true, 'a DOM marker must not claim that an unpainted map is ready');
  assert.ok(painted.land > 0, 'the Gulf states are painted before the first marker is exposed');
});

for (const width of [1440, 390]) for (const reversed of [false, true])
test(`shared market location membership is order independent at ${width}px (reversed=${reversed})`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1, { market: { id: 'example-market', name: 'Synthetic shared market' } }),
    lead(2, { market: { id: 'example-market', name: 'Synthetic shared market' }, city: null, state: null })];
  if (reversed) board.leads.reverse();
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  const located = await page.locator('.market-marker').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.dataset.leadIds)));
  assert.deepEqual(located, [id(1)], 'only the located lead belongs to a marker');
  assert.equal(await page.locator('[data-market="Synthetic shared market"] b').innerText(), '2');
  assert.deepEqual(await page.locator('#leadBoard .lead-card').evaluateAll(nodes => nodes.map(node => node.dataset.leadId).sort()), [id(1), id(2)]);
  assert.equal(await page.locator('.market-marker b').innerText(), '1');
});

for (const width of [1440, 390]) test(`a lead served with a city and no state shows on the map with its city's count at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [1, 2].map(n => lead(n, { city: 'Crestview', state: null })) };
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  const marker = page.locator('.market-marker');
  await marker.waitFor();
  assert.deepEqual(await marker.evaluate(node => [node.querySelector('span')?.textContent, node.querySelector('b').textContent]), ['Crestview', '2']);
});

test('phone All stages count describes the destination membership', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, hasTouch: true, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [lead(1), lead(2, { stage: 'qualified' }), lead(3, { stage: 'engaged' })] };
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  await page.locator('#stageFilter').selectOption('new');
  const label = await page.locator('#stageFilter option[value=""]').innerText();
  await page.locator('#stageFilter').selectOption('');
  const count = await page.locator('.lead-card:visible').count();
  assert.equal(count, 3);
  assert.equal(label, `All stages · ${count}`);
});

for (const width of [1440, 390]) test(`map marker and board select the same lead and retain an unlocated lead at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1), lead(2, { city: 'Synthetic Unlocated' })];
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  await page.locator('.market-marker').click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(1));
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 1);
  await page.locator('#closeDetail').click();
  if (process.env.LEADS_MAP_SCREENSHOT_DIR) {
    await mkdir(process.env.LEADS_MAP_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.LEADS_MAP_SCREENSHOT_DIR}/leads-map-${width}.png`, fullPage: true });
  }
  await page.locator(`.lead-card[data-lead-id="${id(2)}"]`).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(2));
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 0);
});

for (const width of [1440, 390]) test(`all stage view has identical visible map and list membership at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1), lead(2, { stage: 'qualified', city: 'Mobile', state: 'AL' })];
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  assert.equal(await page.locator('.lead-card:visible').count(), 2);
});

const exposeRenderer = page => page.route('**/maplibre-gl.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
  export * from './maplibre-gl.mjs?provider';
  import { Map as ProviderMap } from './maplibre-gl.mjs?provider';
  export class Map extends ProviderMap {
    constructor(options) { super(options); globalThis.leadsRenderer = this; }
    fitBounds(bounds, options) {
      globalThis.leadsInitialBounds ??= bounds.toArray ? bounds.toArray() : bounds;
      return super.fitBounds(bounds, options);
    }
  }
` }));
const territoryMarkets = ['Mobile', 'Daphne', 'Fairhope', 'Orange Beach', 'Gulf Shores', 'Dothan', 'Pensacola', 'Pace', 'Milton', 'Gulf Breeze',
  'Navarre', 'Crestview', 'Niceville', 'Fort Walton Beach', 'Destin', 'Miramar Beach', 'Freeport', 'Panama City Beach', 'Panama City', 'Tallahassee'];
async function territoryFrame(page) {
  const places = JSON.parse(await readFile(new URL('../data/leads-market-locations.json', import.meta.url), 'utf8'));
  const points = territoryMarkets.map(name => places.find(place => place.name === name && ['AL', 'FL'].includes(place.state)).position);
  return page.evaluate(points => ({ bounds: leadsRenderer.getBounds().toArray(), zoom: leadsRenderer.getZoom(),
    places: points.map(point => { const p = leadsRenderer.project(point); return { x: p.x, y: p.y }; }),
    width: leadsRenderer.getContainer().clientWidth, height: leadsRenderer.getContainer().clientHeight }), points);
}
const territoryMarkers = page => page.locator('.market-marker').evaluateAll(nodes => nodes.map(node => ({
  name: node.querySelector('span')?.textContent ?? null, count: node.querySelector('b').textContent,
  leads: JSON.parse(node.dataset.leadIds).length, label: node.getAttribute('aria-label') })).sort((a, b) => a.leads - b.leads));
const nearbyCities = () => ({ ...workspace(), leads: [lead(1, { city: 'Daphne', state: 'AL' }), lead(2, { city: 'Daphne', state: 'AL' }),
  lead(3, { city: 'Fairhope', state: 'AL' }), lead(4, { city: 'Dothan', state: 'AL' })] });

for (const width of [1440, 390]) test(`touching markers merge into one count and a lone marker shows its place name at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await routeLeads(page, { getBoard: nearbyCities });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  assert.deepEqual(await territoryMarkers(page), [
    { name: 'Dothan', count: '1', leads: 1, label: 'Dothan, AL: 1 leads' },
    { name: null, count: '3', leads: 3, label: 'Zoom to markets · Daphne, AL: 2 · Fairhope, AL: 1' }]);
});

for (const width of [1440, 390]) test(`a resize refits the whole territory but keeps a partner's zoom at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await routeLeads(page, { getBoard: nearbyCities });
  await exposeRenderer(page);
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  const resize = async size => {
    await page.evaluate(() => { globalThis.leadsResized = leadsRenderer.once('resize'); });
    await page.setViewportSize(size);
    await page.evaluate(() => leadsResized);
  };
  const opening = await territoryFrame(page);
  await resize({ width: width - 60, height: 1000 });
  const narrowed = await territoryFrame(page);
  assert.notEqual(narrowed.width, opening.width, 'the map frame changed size');
  assert.ok(narrowed.places.every(p => p.x >= 0 && p.x <= narrowed.width && p.y >= 0 && p.y <= narrowed.height), JSON.stringify(narrowed));
  await page.getByRole('button', { name: /^Zoom to markets/ }).click();
  await page.locator('.market-marker:has(span)').first().waitFor();
  const zoomed = await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() }));
  assert.ok(zoomed.zoom > narrowed.zoom + 2, JSON.stringify(zoomed));
  await resize({ width, height: 1000 });
  assert.deepEqual(await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() })), zoomed);
});

const matrixBoard = () => ({ ...workspace(), leads: [
  lead(1), lead(2, { stage: 'qualified', owner: 'example-partner', city: 'Mobile', state: 'AL' }),
  lead(3, { stage: 'outreach_active', owner: 'other' }),
  lead(4, { stage: 'engaged', owner: 'example-partner', city: 'Synthetic Unlocated' }),
  lead(5, { stage: 'nurture_drip', owner: 'other' }),
  lead(6, { stage: 'opportunity', owner: 'example-partner', city: 'Mobile', state: 'AL' }),
  lead(7, { stage: 'archived', owner: 'other', city: 'Synthetic Unlocated' }),
  lead(8, { stage: 'closed_lost', city: 'Mobile', state: 'AL' }),
  lead(9, { suppressed: true }), lead(10, { client_id: id(900) }),
  lead(11, { stage: 'closed_won' }), lead(12, { merged_into: id(1) }),
  lead(13, { deleted_at: '2026-10-01T16:00:00Z' }), lead(14, { do_not_contact: true }),
  lead(15, { city: null, state: null }), lead(16, { city: 'Westlake' }),
] });
const all = [1,2,3,4,5,6,7,8,15,16];
const stageCases = [['',[1,2,3,4,5,6,8,15,16]], ['new',[1,15,16]], ['qualified',[2]],
  ['outreach_active',[3]], ['engaged',[4]], ['nurture_drip',[5,8]], ['opportunity',[6]], ['archived',[7]]];
const ownerCases = [['',all], ['example-partner',[2,4,6]], ['other',[3,5,7]]];
const marketCases = [['',all], ['Pensacola, FL',[1,3,5]], ['Mobile, AL',[2,6,8]],
  ['Synthetic Unlocated, FL',[4,7]], ['Leads without a market',[15]], ['Westlake, FL',[16]]];
const searchCases = [['',all], [' EXAMPLE 1 ',[1,15,16]], ['Dental',all], ['Mobile',[2,6,8]], ['zzzero',[]]];
const cases = stageCases.flatMap(([stage, stageIds]) => ownerCases.flatMap(([owner, ownerIds]) =>
  marketCases.flatMap(([market, marketIds]) => searchCases.map(([search, searchIds]) => ({
    stage, owner, market, search,
    expected: stageIds.filter(n => ownerIds.includes(n) && marketIds.includes(n) && searchIds.includes(n)).map(id).sort(),
  })))));

for (const width of [1440, 390]) test(`market counts, map markers and board IDs match all ${cases.length} filter combinations at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await routeLeads(page, { getBoard: matrixBoard, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  const canvas = await page.locator('#territoryMap canvas').elementHandle();
  const results = await page.evaluate(cases => {
    const $ = id => document.getElementById(id);
    const set = (id, value, type = 'change') => { $(id).value = value; $(id).dispatchEvent(new Event(type)); };
    const ids = selector => [...document.querySelectorAll(selector)].map(node => node.dataset.leadId).sort();
    return cases.map(filters => {
      set('stageFilter', filters.stage);
      set('ownerFilter', filters.owner);
      set('marketFilter', filters.market);
      set('leadSearch', filters.search, 'input');
      const cards = [...document.querySelectorAll('.lead-card')].filter(node => node.getBoundingClientRect().width > 0);
      const marketCount = [...document.querySelectorAll('#marketCounts b')].reduce((n, node) => n + Number(node.textContent), 0);
      const markers = [...document.querySelectorAll('.market-marker')];
      const located = markers.flatMap(node => JSON.parse(node.dataset.leadIds));
      const selected = cards[0]?.dataset.leadId;
      cards[0]?.click();
      const boardHighlight = ids('.lead-card[data-selected="true"]');
      const markerHighlight = [...document.querySelectorAll('.market-marker[aria-pressed="true"]')]
        .flatMap(node => JSON.parse(node.dataset.leadIds)).includes(selected);
      $('leadDetail').close();
      return { list: cards.map(node => node.dataset.leadId).sort(), located: located.sort(),
        marketCount, boardHighlight, markerHighlight, selected, summary: $('leadCount').textContent };
    });
  }, cases);
  for (let n = 0; n < cases.length; n++) {
    const result = results[n], expected = cases[n].expected, context = JSON.stringify(cases[n]);
    assert.deepEqual(result.list, expected, `visible list ${context}`);
    const knownLocations = [1,2,3,5,6,8,16].map(id);
    assert.deepEqual(result.located, expected.filter(value => knownLocations.includes(value)), context);
    assert.equal(result.marketCount, expected.length, context);
    assert.match(result.summary, new RegExp(`^${expected.length} leads?$`), context);
    const highlight = result.selected ? [result.selected] : [];
    assert.deepEqual(result.boardHighlight, highlight, context);
    assert.equal(result.markerHighlight, Boolean(result.selected && result.located.includes(result.selected)), context);
  }
  assert.ok(await canvas.evaluate(node => node.isConnected), 'filtering preserves the renderer');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
});

for (const width of [1440,390]) test(`marker selection survives matching filters and clears when excluded at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = matrixBoard();
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  await page.locator('#stageFilter').selectOption('qualified', { force: true });
  await page.getByRole('button', { name: 'Mobile, AL: 1 leads', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('#detailTitle').innerText(), 'Dr. Example 2');
  await page.locator('#closeDetail').click();
  await page.locator('#stageFilter').selectOption('', { force: true });
  await page.locator('#ownerFilter').selectOption('example-partner', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(2));
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 1);
  await page.locator('#ownerFilter').selectOption('other', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').count(), 0);
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 0);
  await page.locator('#ownerFilter').selectOption('', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').count(), 0, 'cleared selection does not resurrect');
  await page.locator('#stageFilter').selectOption('qualified', { force: true });
  assert.equal(await page.locator('.lead-card:visible').count(), 1);
});

for (const width of [1440, 390]) test(`Leads opens on all of the partners' markets, Mobile to Tallahassee and down the coast, at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await routeLeads(page);
  await exposeRenderer(page);
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor({ state: 'attached' });
  assert.deepEqual(await page.evaluate(() => leadsInitialBounds), [[-88.107853, 30.233151], [-84.252272, 31.233698]]);
  const frame = await territoryFrame(page);
  assert.ok(frame.places.every(p => p.x >= 20 && p.x <= frame.width - 20 && p.y >= 20 && p.y <= frame.height - 20), JSON.stringify(frame));
  assert.ok(frame.bounds[1][1] < 34, 'the working frame does not default to northern Alabama and Georgia');
  const canvas = await page.locator('#territoryMap canvas').elementHandle();
  const camera = await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() }));
  await page.locator('#specialtyFilter').selectOption('Dental');
  await page.locator('#marketFilter').selectOption('Mobile, AL');
  await page.locator('#marketFilter').selectOption('');
  await page.locator('#specialtyFilter').selectOption('');
  await page.locator('#refreshBoard').click();
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  assert.equal(await canvas.evaluate(node => node.isConnected), true);
  assert.deepEqual(await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() })), camera);
  await page.evaluate(() => leadsRenderer.jumpTo({ center: [-87.2, 30.38], zoom: 8.5 }));
  const targets = await page.locator('.market-marker').evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  assert.ok(targets.every((a, index) => targets.slice(index + 1).every(b =>
    a.right + 4 <= b.left || b.right + 4 <= a.left || a.bottom + 4 <= b.top || b.bottom + 4 <= a.top)),
    `map marker targets keep separation at intermediate zoom: ${JSON.stringify(targets)}`);
  await page.evaluate(camera => leadsRenderer.jumpTo(camera), camera);
  if (process.env.UI_SCREENSHOT_DIR) for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
    await page.locator('.territory').screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/leads-${width}-${theme}.png` });
  }
});
