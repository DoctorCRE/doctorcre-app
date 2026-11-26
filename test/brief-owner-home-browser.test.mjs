import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium, animationsSettled } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { controlFloor } from "./control-floor.ts";

let outDir, server;
before(async () => {
  outDir = await temporaryDirectory('doctorcre-brief-home-');
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  server = await fixtureServer({ root: join(outDir, 'site') });
});
after(async () => {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`built Leads owner buttons read Both, Joe and Dell and fit at ${width}px in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
      ok: true, schema_version: 'home-today.v1', today: '2026-10-01', viewer: 'joe',
      partners: [{ slug: 'joe', name: 'Joe Example' }, { slug: 'dell', name: 'Dell Samplewright' }],
      meetings: { state: 'empty', items: [] },
      reminders: { state: 'empty', late: [], upcoming: [] },
    } }));
    await page.goto(server.origin + '/leads');
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
    await animationsSettled(page);
    const buttons = page.getByRole('group', { name: 'Reminders for' }).getByRole('button');
    await buttons.first().waitFor();
    const targets = await buttons.evaluateAll(nodes => nodes.map(node => {
      const { width, height } = node.getBoundingClientRect();
      return { label: node.textContent, width, height, fits: node.scrollWidth <= node.clientWidth };
    }));
    assert.deepEqual(targets.map(target => target.label), ['Both', 'Joe', 'Dell']);
    for (const target of targets) assert.ok(target.fits && target.width >= 44 && target.height >= controlFloor(width),
      `${target.label}: ${target.width}x${target.height}`);
  });
}
