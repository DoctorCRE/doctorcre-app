import { test, expect } from '@playwright/test';
import { ownedServer as startFixtureServer } from '../../test/fixture-probe.ts';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';

test.use({ baseURL: async ({}, use) => {
  const server = await startFixtureServer();
  try { await use(server.url); } finally { await server.stop(); }
} });

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Vendor layout at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
    await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), dismiss => dismiss.click());
    await page.goto('/vendors?all=true');
    await expect(page.locator('.record-row').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Quiet/ })).toBeVisible();
    await expect(page.locator('.result-heading').getByRole('button', { name: 'Market', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Vendors', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`directory-${width}-${theme}.png`) });
    if (width === 1440) {
      const rows = await page.locator('.record-row').first().boundingBox();
      expect.soft(rows.width).toBeGreaterThan(950);
    } else {
      const completeRows = await page.locator('.record-row').evaluateAll(rows => {
        const bottom = innerHeight;
        return rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= bottom; }).length;
      });
      expect.soft(completeRows).toBeGreaterThanOrEqual(3);
      await expect.soft(page.locator('#pageFooter')).toHaveText('DoctorCRE · Vendors');
    }
    await page.locator('.record-row').first().click();
    // A vendor opens as a card beside the table; on a phone the card covers it as a dialog.
    await expect(page.getByRole(width < 768 ? 'dialog' : 'complementary', { name: 'Demo Partner 01' })).toBeVisible();
    await expect(page.locator('#recordBody')).toContainText('Suggested introductions');
    await expect(page.locator('.record-panel-actions .doc-presence')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`detail-${width}-${theme}.png`) });
    await page.getByRole('button', { name: 'Close record', exact: true }).click();
    if (width === 390) {
      await expect(page.getByText('Filters and sort', { exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Dell', exact: true }).click();
      await expect(page).toHaveURL(/owner=dell/);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page).toHaveURL('/vendors?all=true');
      await page.setViewportSize({ width: 1440, height: 844 });
      await expect(page.getByLabel('Category', { exact: true })).toBeHidden();
    }
  });
}
