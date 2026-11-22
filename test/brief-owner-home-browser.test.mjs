import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium, animationsSettled } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

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
  test(`built Leads owner chips keep 44px targets at ${width}px in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
      ok: true, schema_version: 'home-today.v1', today: '2026-10-01', viewer: 'joe',
      partners: [{ slug: 'joe', name: 'Joe' }, { slug: 'dell', name: 'Dell' }],
      meetings: { state: 'empty', items: [] },
      reminders: { state: 'empty', late: [], upcoming: [] },
    } }));
    await page.goto(server.origin + '/leads');
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    if (width === 390) await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
    await animationsSettled(page);
    const chips = page.locator('#appTodayOwners .chip');
    await chips.first().waitFor();
    const targets = await chips.evaluateAll(nodes => nodes.map(node => {
      const { width, height } = node.getBoundingClientRect();
      return { label: node.textContent, width, height };
    }));
    assert.equal(targets.length, 3);
    for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44,
      `${target.label}: ${target.width}x${target.height}`);
    assert.equal(await chips.first().evaluate(node =>
      getComputedStyle(node).borderRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius-round').trim()), true);
  });
}
