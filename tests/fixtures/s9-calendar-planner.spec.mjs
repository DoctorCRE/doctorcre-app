import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath("route.png"), fullPage: true });
});

async function assets(page) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['http://localhost', 'https://app.doctorcre.com'].includes(url.origin)) return route.abort();
    if (url.pathname === '/auth/session') return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-fixture'}});
    if (url.pathname === '/api/engine/calendar/critical-dates') return route.fulfill({ json: {
      schema_version: 'calendar-critical-dates.v1',
      critical_dates: [{
        id: 'synthetic-date',
        deal_id: 'synthetic-deal',
        deal_name: 'Synthetic dental office',
        kind: 'Option notice',
        due_on: '2026-10-20',
        done: false,
      }],
    } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { data: { tours: [], clients: [] }, actor: { slug: 'joe' }, csrf_token: 'synthetic-fixture', items: [], counts: {} } });
    const file = url.pathname === '/calendar' ? 'calendar.html' : url.pathname === '/tours' ? 'tours/index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL('../../' + file, import.meta.url));
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Calendar event names read in full at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.clock.install({ time: new Date('2026-10-18T12:00:00Z') });
  await assets(page);
  await page.goto('https://app.doctorcre.com/calendar?view=month&d=2026-10-18');
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  const label = page.locator('.cal-chip-label').filter({ hasText: 'Option notice' });
  await expect(label).toBeVisible();
  expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth && getComputedStyle(node).whiteSpace !== 'nowrap')).toBe(true);
  await page.locator('.cal-chip').filter({ hasText: 'Option notice' }).click();
  await expect(page.locator('#dayPanelBody')).toContainText('Option notice');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
