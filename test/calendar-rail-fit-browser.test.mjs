import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { scenario } from './browser-scenario.mjs';

describe('test/calendar-rail-fit-browser.test.mjs', () => {

const NOW = new Date('2026-11-03T10:00:00-06:00');
let outDir;
before(async () => { outDir = temporaryDirectory('calendar-fit-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });

for (const theme of ['light', 'dark']) for (const count of [0, 1, 2, 3, 6]) test(`Calendar rail fits ${count} meetings in ${theme}`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: NOW });
  const { page, now } = run;
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/api/engine/home/today', route => route.fulfill({ json: {
    ok: true, schema_version: 'home-today.v1', today: '2026-11-03', viewer: 'joe',
    reminders: { state: 'empty', late: [], upcoming: [] },
    meetings: { state: count ? 'ready' : 'empty', items: Array.from({ length: count }, (_, i) => ({
      title: `Synthetic meeting ${i + 1} with the practice team to review the upcoming office requirements`,
      start: new Date(now.getTime() + 3600000 * (i + 1)).toISOString(),
      end: new Date(now.getTime() + 3600000 * (i + 2)).toISOString(),
    })) },
  } }));
  for (const [width, height] of [[1024, 700], [1024, 768], [1280, 720], [1280, 800], [1440, 900], [390, 844], [1024, 700]]) {
    await page.setViewportSize({ width, height });
    if (!page.url().startsWith(run.origin)) await run.open('/invoices?mode=live');
    if (width === 390) await page.getByRole('button', { name: 'Today sidebar' }).click();
    const rail = page.getByRole('complementary', { name: 'Today' });
    if (!count) await rail.getByText('No meetings today.').waitFor();
    else await rail.locator('.calendar-panel-meeting').last().waitFor();
    assert.equal(await rail.locator('.calendar-panel-meeting').count(), count);
    assert.ok(await rail.evaluate(node => node.scrollWidth <= node.clientWidth), `Today fits at ${width}x${height}`);
    if (count === 3) await page.screenshot({ path: `${run.outputDir}/calendar-${width}x${height}-${theme}.png`, animations: 'disabled', fullPage: true });
  }
});

});
