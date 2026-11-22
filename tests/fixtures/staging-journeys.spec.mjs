import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { temporaryDirectory } from '../../scripts/temp-directory.mjs';
import { rm } from 'node:fs/promises';
import { startWorkerFixture } from '../../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../../scripts/fixture-app-assets.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { detail } from '../../test/fixtures/tour-day.synthetic.mjs';
import { tourDay, itinerary } from '../staging/journey-flows.mjs';

export const fixture = {
  tour: { id: detail.id, name: 'Synthetic staging QA accepted tour', route_id: detail.routes[0].id,
    property_ids: detail.stops.map(stop => stop.property_id), stop_ids: detail.stops.map(stop => stop.id),
    property_names: detail.stops.map(stop => stop.property_name) },
};

export async function localFixture(browser) {
  const tour = structuredClone(detail);
  Object.assign(tour, { name: fixture.tour.name, route_version_id: fixture.tour.route_id, route_version_state: 'accepted',
    accepted_route_version: 1 });
  tour.stops.forEach(stop => { stop.locked_appointment = false; });
  tour.routes[0].acceptance_digest = 'sha256:' + 'a'.repeat(64);
  const assets = await appAssetSnapshot();
  const server = await startWorkerFixture({ assets, env:{ APP_ENV:'staging', CARR:{fetch:async req => {
    const url = new URL(req.url);
    const json = (body, status = 200) => Response.json(body,{status});
    if (url.pathname === '/api/tours/detail') return json({ data: tour, csrf_token: 'synthetic' });
    if (url.pathname === '/api/tours/library') return json({ data: { tours: [{ id: tour.id, name: tour.name, status: 'active' }] }, csrf_token: 'synthetic' });
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
    if (url.pathname === '/mcp') return json({ result: { content: [{ type: 'text', text: '{"ok":true,"deals":[],"items":[],"notifications":[],"state":"unavailable"}' }] } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return json({});
    return new Response(null);
  }}} });
  const origin = server.origin;
  const context = await browser.newContext({ baseURL: origin });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let contextClosed = false, closing;
  context.once('close', () => { contextClosed = true; });
  const close = () => closing ??= (async () => {
    try {
      if (!contextClosed) await context.close();
    } catch (error) {
      if (!/(?:^|: )Target page, context or browser has been closed(?:\n|$)/.test(error.message)) throw error;
    } finally {
      await server.close();
    }
  })();
  return { page: await context.newPage(), server, close };
}

for (const [name, flow] of Object.entries({ tourDay, itinerary })) {
  test(`staging acceptance logic against synthetic HTTP fixtures: ${name}`, async ({ browser }) => {
    const local = await localFixture(browser);
    try { await flow(local.page, fixture); } finally { await local.close(); }
  });
}

test('Fixture cleanup releases its server when context disposal fails', async ({ browser }) => {
  const local = await localFixture(browser);
  const context = local.page.context();
  const close = context.close.bind(context);
  const failure = new Error('synthetic context disposal failure');
  context.close = async () => { throw failure; };
  try {
    await assert.rejects(local.close(), failure);
    await assert.rejects(fetch(local.server.origin), TypeError, 'server disposal must survive context disposal failure');
  } finally {
    context.close = close;
    await close();
    await local.server.close();
  }
});

test('Fixture cleanup tolerates an already closed context and repeated disposal', async ({ browser }) => {
  const local = await localFixture(browser);
  await local.page.context().close();
  await Promise.all([local.close(), local.close()]);
  await assert.rejects(fetch(local.server.origin), TypeError);
});

for (const connected of [true, false]) {
  test(`Fixture cleanup preserves HAR failure after context closes with browser connected=${connected}`, async ({ browser }, testInfo) => {
    const blocker = testInfo.outputPath('har-blocker');
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(blocker, 'This file prevents creating the HAR directory.');
    const local = await localFixture({
      newContext: options => browser.newContext({ ...options, recordHar: { path: `${blocker}/journey.har` } }),
      isConnected: () => connected,
    });
    const context = local.page.context();
    let closed = false;
    context.once('close', () => { closed = true; });
    try {
      await assert.rejects(local.close(), error => {
        assert.equal(closed, true, 'the real context close event precedes the HAR error');
        assert.match(error.message, /EEXIST|ENOTDIR/);
        return true;
      });
      await assert.rejects(fetch(local.server.origin), TypeError);
      await assert.rejects(local.close(), /EEXIST|ENOTDIR/);
    } finally {
      await local.server.close();
    }
  });
}

test('Fixture cleanup tolerates a target closing during disposal', async ({ browser }) => {
  const local = await localFixture(browser);
  const context = local.page.context();
  const close = context.close.bind(context);
  context.close = async () => {
    await close();
    await context.newPage();
  };
  await Promise.all([local.close(), local.close()]);
  await assert.rejects(fetch(local.server.origin), TypeError);
});


test('Journey fixture refuses outside-root file URLs and raw encoded traversal', async ({ browser }) => {
  const directory = temporaryDirectory('/tmp/WR622.S20.J7-path-probe-');
  const marker = `${directory}/outside.txt`;
  const sentinel = 'SYNTHETIC_OUTSIDE_ROOT_WR622_S20_J7';
  await writeFile(marker, sentinel);
  const local = await localFixture(browser);
  try {
    for (const path of [`/file://${marker}`, `/..%2f${marker.slice(1)}`, `/../${marker.slice(1)}`,
      `/..%252f${marker.slice(1)}`, `/file%3a%2f%2f${marker}`, `/..%5c${marker.slice(1)}`]) {
      const result = await new Promise((resolve, reject) => {
        get(local.server.origin, { path }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
          response.on('error', reject);
        }).on('error', reject);
      });
      assert.ok([400, 404].includes(result.status), `${path}: ${result.status}`);
      assert.equal(result.body.includes(sentinel), false, path);
      console.log(`outside-root probe ${path}: ${result.status}, sentinel=false`);
    }
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});
