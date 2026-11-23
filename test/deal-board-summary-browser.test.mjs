import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { inspectPhoneAccessibility } from '../scripts/phone-accessibility.ts';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

for (const width of [320, 390, 1280, 1440]) for (const theme of ['light', 'dark']) for (const national of [false, true]) {
  test(`${national ? 'National Accounts' : 'Local Deals'} renders board records at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    await page.clock.setFixedTime(new Date('2026-10-29T15:00:00Z'));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    const completed = 'Sent the signed sample lease and the revised floor plan to the lender, confirmed the delivery date with the site manager, and filed the full set of documents for the next review.';
    await page.route('**/data/board-seed.json', async route => {
      const seed = await (await route.fetch()).json();
      const deal = seed.deals.find(deal => deal.id === (national ? 'd01' : 'd14'));
      Object.assign(deal, { next_step: '', next_date: null, email_actions: [
        { id: 'summary-action', status: 'open', owner: 'dell', description: 'Review the sample lease terms and confirm the remaining details with the lender before arranging the property tour', due_on: '2026-10-30' },
        { id: 'summary-done', status: 'done', description: completed, completed_at: '2026-10-28T12:00:00Z' },
      ] });
      seed.history = { ...seed.history, [deal.id]: [{ id: 'summary-last', summary: 'Sent the sample proposal for review', recorded_at: '2026-10-22T12:00:00Z' }] };
      await route.fulfill({ json: seed });
    });
    await page.goto(`${server.origin}/deals?mode=fixture${national ? '&view=national' : ''}`);
    if (national) await page.locator('.account-card').first().click();
    const card = national ? page.locator('#rows tr[data-deal-id="d01"]') : page.locator('.kanban-card[data-id="d14"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    if (!national) {
      const name = 'Demo Surgical Practice';
      assert.equal(await card.getByRole('button', { name, exact: true }).count(), 1);
      assert.equal((await card.innerText()).replace(/\s+/g, ' '), `${name} J Owner: Joe`);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const headings = await page.locator('.kanban-column > h3 [data-collapse-stage]:visible').evaluateAll(headers => headers.map(header => {
        const [name, count] = [...header.children].map(child => child.getBoundingClientRect());
        return Math.abs(name.y + name.height / 2 - count.y - count.height / 2) < 1
          && count.right <= header.getBoundingClientRect().right
          && header.scrollWidth <= header.clientWidth;
      }));
      assert.ok(headings.length && headings.every(Boolean), 'each phase keeps its name and count together');
      if (width === 390) {
        const audit = await inspectPhoneAccessibility(page);
        assert.deepEqual(audit.small.filter(target => target.selector.startsWith('#kanban')), []);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if ([390, 1440].includes(width)) {
        const dir = 'test-artifacts/board-cards/after';
        await mkdir(dir, { recursive: true });
        await page.screenshot({ path: `${dir}/local-deals-${width}-${theme}.png` });
      }
      return;
    }
    const next = card.getByText('Review the sample lease terms and confirm the remaining details with the lender before arranging the property tour', { exact: true });
    assert.ok(await next.evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth));
    if (width === 390) {
      const last = card.getByText(completed, { exact: true });
      assert.equal(await last.isVisible(), true);
      assert.ok(await last.evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth),
        'the full completed step fits in the Last row');
    }
    const facts = card.locator('.deal-summary-facts').first();
    assert.match(await facts.innerText(), /Fri Oct 30 · Dell/);
    const spaced = await card.locator('.deal-summary-facts').evaluateAll(nodes => nodes.filter(node => node.textContent.includes('·')).map(node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0);
      range.setEnd(node.firstChild, 1);
      return { text: node.textContent, space: range.getBoundingClientRect().width };
    }));
    assert.ok(spaced.length > 0, 'a dated summary line is rendered');
    for (const fact of spaced) {
      assert.match(fact.text, /^ · /, 'the dot keeps a space before it');
      assert.ok(fact.space > 1, 'the space before the dot is rendered, not collapsed');
    }
    const visible = await card.locator('.deal-summary-facts').evaluateAll(nodes => nodes.every(node => {
      const box = node.getBoundingClientRect();
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (['hidden', 'clip'].includes(style.overflow)) {
          const clip = ancestor.getBoundingClientRect();
          if (box.right > clip.right + 1 || box.bottom > clip.bottom + 1) return false;
        }
      }
      return box.width > 0 && box.right <= innerWidth;
    }));
    assert.equal(visible, true, 'summary facts fit beside the step text');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if ([390, 1440].includes(width)) {
      const dir = 'out/test-artifacts/deal-board-summary';
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${national ? 'national-accounts' : 'local-deals'}-${width}-${theme}.png` });
    }
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Board badge explains attention and labels parked deals at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const touch = width === 390;
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: touch, reducedMotion: 'reduce' });
    const press = control => touch ? control.tap() : control.click();
    await page.clock.setFixedTime(new Date('2026-10-29T15:00:00Z'));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/data/board-seed.json', async route => {
      const seed = await (await route.fetch()).json();
      const deal = seed.deals.find(deal => deal.id === 'd14');
      Object.assign(deal, { attention: true, next_step: 'Send the sample plans', next_date: '2026-10-28' });
      seed.deals.push({ ...deal, id: 'sample-client-paused', name: 'Example Parked Practice', operating_state: 'parked', parking_reason: 'client_paused' });
      await route.fulfill({ json: seed });
    });
    await page.goto(`${server.origin}/deals?mode=fixture`);
    const card = page.locator('#kanban article[data-id="d14"]');
    const name = card.getByRole('button', { name: 'Demo Surgical Practice', exact: true });
    const badge = card.getByRole('button', { name: 'Needs attention: Flagged by a partner. Step 1 day late', exact: true });
    const reason = card.getByText('Flagged by a partner. Step 1 day late', { exact: true });
    const parked = page.getByRole('button', { name: 'Parked', exact: true });
    await card.waitFor();
    await press(parked);
    const otherCard = page.locator('#kanban article[data-id="d06"]');
    await otherCard.waitFor();
    const screenshots = 'test-artifacts/board-attention/after';
    await mkdir(screenshots, { recursive: true });
    await otherCard.evaluate(card => card.scrollIntoView({ block: 'center' }));
    await otherCard.screenshot({ path: `${screenshots}/parked-${width}-${theme}.png` });
    assert.ok(await otherCard.getByText('Parked', { exact: true }).isVisible(), 'Other is shown as Parked');
    assert.ok(await page.locator('#kanban article[data-id="sample-client-paused"]').getByText('Client paused', { exact: true }).isVisible());

    assert.equal(await reason.isVisible(), false);
    assert.equal(await badge.count(), 1, 'the attention badge is an operable button');
    await press(badge);
    assert.equal(await badge.getAttribute('aria-expanded'), 'true');
    assert.ok(await reason.isVisible());
    await card.screenshot({ path: `${screenshots}/attention-${width}-${theme}.png` });
    assert.equal(await page.locator('#recordPanel').isVisible(), false);
    await press(page.locator('#boardLive'));
    assert.equal(await reason.isVisible(), false);
    await name.focus();
    await page.keyboard.press('Tab');
    assert.ok(await badge.evaluate(button => button === document.activeElement));
    assert.ok(await reason.isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await reason.isVisible(), false);
    assert.ok(await badge.evaluate(button => button === document.activeElement));
    if (touch) {
      const target = await badge.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44);
      const audit = await inspectPhoneAccessibility(page);
      assert.deepEqual(audit.small.filter(target => target.selector.startsWith('#kanban')), []);
    }
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await press(badge);
    assert.ok(await reason.isVisible());
    await press(name);
    await page.locator('#recordPanel').getByRole('heading', { name: 'Demo Surgical Practice', exact: true }).waitFor();
  });
}

test('search from National Accounts keeps dates visible on local deals', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().click();
  await page.locator('#search').fill('Demo Surgical');
  const row = page.locator('#rows tr[data-deal-id="d14"]');
  await row.waitFor();
  assert.equal(await row.locator('.due').isVisible(), true, 'local results retain their date column');
});
