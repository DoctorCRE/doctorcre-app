import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('going offline clears health during a pending refresh and reconnect reads again', async ({ page, context }) => {
  let todayReads = 0;
  let releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  await page.clock.install();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/connection-fixture') return route.fulfill({ contentType: 'text/html', body:
      '<header id="shell"></header><main><h1>Connection fixture</h1></main><script type="module">import {mountAppLayout} from "/js/app-layout.js";mountAppLayout(document,document.querySelector("#shell"),"/search");</script>' });
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}});
    if (url.pathname === '/api/engine/home/today') {
      if (++todayReads === 1) await pendingRead;
      return route.fulfill({ json: { ok: true, schema_version: 'home-today.v1', today: '2026-11-01',
        viewer: 'joe', meetings: { state: 'empty', items: [] }, reminders: { state: 'empty', late: [], upcoming: [] } } });
    }
    try { return route.fulfill({ body: await readFile(new URL(`../../${url.pathname.slice(1)}`, import.meta.url)), contentType: 'text/javascript' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const firstRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/engine/home/today');
  await page.goto('http://localhost/connection-fixture?mode=live');
  const connection = page.locator('#appConnection');
  await firstRead;
  await expect(connection).toBeHidden();
  try {
    await context.setOffline(true);
    await expect(connection).toHaveText('Connection unavailable');
    await expect(page.locator('#appScheduleSlot')).toHaveText('Meetings unavailable while offline.');
    await expect(page.getByRole('button', { name: 'Retry Today', exact: true })).toBeVisible();
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/engine/home/today');
    releaseRead();
    await (await response).finished();
    await expect(connection).toBeVisible();
    await expect(page.locator('#appScheduleSlot')).toHaveText('Meetings unavailable while offline.');
  } finally {
    releaseRead();
    await context.setOffline(false);
  }
  await expect.poll(() => todayReads).toBe(2);
  await expect(connection).toBeHidden();
  await expect(page.locator('#appScheduleSlot')).toHaveText('No meetings today.');
});
