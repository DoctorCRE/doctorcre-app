import { expect } from 'e2e';
import { reproTest } from './support.mjs';

const test = reproTest();
test('QA-005 the Opportunity card can be opened above the phone controls', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/leads');
  await expect(browser.locator('#leadBoard')).toHaveAttribute('aria-busy', 'false');
  await screen.getByLabel('Board stage', { exact: true }).selectOption({ value: 'opportunity' });
  const opener = screen.getByRole('button', 'Dr. Demo 12', { exact: true });
  await expect(opener).toBeVisible();
  await opener.scrollIntoView();
  const unobstructed = await browser.evaluate(() => {
    const button = document.querySelector('#leadBoard .lead-open');
    if (!button) return false;
    const { left, top, width, height } = button.getBoundingClientRect();
    return width >= 44 && height >= 44 && document.elementFromPoint(left + width / 2, top + height / 2) === button;
  });
  expect(unobstructed).toBe(true);
  await opener.click();
  await expect(browser.locator('#detailTitle')).toHaveText('Dr. Demo 12');
});
