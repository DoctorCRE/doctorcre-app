import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect as baseExpect } from '@playwright/test';
import { buildArtifact } from '../scripts/artifact.mjs';

import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, WAIT_MS } from './browser-harness.mjs';

const expect = baseExpect.configure({ timeout: WAIT_MS });

const root = fileURLToPath(new URL('../', import.meta.url));

test('Calendar opens confirmed dates while another deal is pending and clears them on session expiry', async t => {
  const outDir = await temporaryDirectory('calendar-loading-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  t.after(() => server.close());
  const origin = server.origin;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const status of [200, 401, 502, 503]) await t.test(String(status), async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.clock.install({ time: new Date('2026-10-20T15:00:00Z') });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'doctorcre-app-staging.joe-bookout-carr-us.workers.dev') return route.abort();
      const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
        method: route.request().method(), data: route.request().postData() ?? undefined,
        headers: { 'content-type': 'application/json' },
      });
      return route.fulfill({ response });
    });
    let calendarStatus = 404;
    let failAll = status === 503;
    let slowFails = status === 502;
    await page.route('**/api/engine/calendar/critical-dates', route => route.fulfill({ status: calendarStatus }));
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let releaseLate;
    const late = new Promise(resolve => { releaseLate = resolve; });
    const answer = (route, data) => route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    } } });
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      if (name === 'deal-room-board') return answer(route, { actor: 'joe', deals: [
        { id: 'fast', name: 'Synthetic confirmed deal', owner: 'joe' },
        { id: 'slow', name: 'Synthetic pending deal', owner: 'joe' },
        ...(status === 401 ? [{ id: 'late', name: 'Synthetic late deal', owner: 'joe' }] : []),
      ] });
      if (name !== 'get-deal-room') return route.fallback();
      if (failAll) return route.fulfill({ status: 502 });
      if (args.deal === 'late') await late;
      if (args.deal === 'slow') {
        await held;
        if (status === 401) return route.fulfill({ status, json: { error: 'not_authenticated' } });
        if (slowFails) return route.fulfill({ status: 502 });
      }
      return answer(route, { deal_id: args.deal, critical_dates: [{
        id: args.deal, kind: 'loi_expiry', due_on: '2026-10-20', status: 'open', note: `Synthetic ${args.deal} date`,
      }, ...(args.deal === 'fast' ? [{
        id: 'done', kind: 'rent_start', due_on: '2026-10-20', status: 'done', note: 'Synthetic finished date',
      }] : [])] });
    });
    try {
      await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `calendar-${status}`, reset: true } });
      await page.goto('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/calendar?d=2026-10-01');
      if (status === 503) {
        await expect(page.locator('#dayPanelBody')).toContainText('may be incomplete');
        await expect(page.locator('#dayPanelBody')).not.toContainText('No critical dates');
        return;
      }
      await expect(page.locator('#calGrid .cal-chip')).toHaveCount(1);
      await expect(page.locator('#calGrid')).toHaveAttribute('aria-busy', 'true');
      await page.locator('.cal-day-open[data-select-day="2026-10-20"]').click();
      await expect(page.locator('#dayPanelBody')).toContainText('Synthetic fast date');
      await expect(page.locator('#dayPanelBody')).not.toContainText('Synthetic finished date');
      await mkdir(join(root, 'test-artifacts/calendar-loading'), { recursive: true });
      await page.screenshot({ path: join(root, `test-artifacts/calendar-loading/pending-${status}.png`), fullPage: true });
      release();
      if (status === 200) {
        await expect(page.locator('#calCount')).toHaveText('2 critical dates');
        await expect(page.locator('#calGrid')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('#calAsOf')).toContainText('Updated');
        await expect(page.locator('.cal-day-open[data-select-day="2026-10-20"]')).toBeFocused();
      } else if (status === 502) {
        await expect(page.getByRole('status').filter({ hasText: '1 of 2 deals temporarily unavailable' })).toBeVisible();
        await expect(page.getByRole('main').getByRole('button', { name: /^Refresh/ })).toHaveCount(1);
        await expect(page.locator('#dayPanelBody')).toContainText('Synthetic fast date');
        await expect(page.locator('#dayPanelBody')).toContainText('may be incomplete');
        await page.locator('.cal-day-open[data-select-day="2026-10-21"]').click();
        await expect(page.locator('#dayPanelBody')).toContainText('may be incomplete');
        await expect(page.locator('#dayPanelBody')).not.toContainText('No critical dates');
        await expect(page.locator('#calLive')).toContainText('may be incomplete');
        await page.locator('.cal-day-open[data-select-day="2026-10-20"]').click();
        const updated = await page.locator('#calAsOf').textContent();
        await page.clock.setSystemTime(new Date('2026-10-20T15:01:00Z'));
        calendarStatus = 503;
        await page.locator('#calRefresh').click();
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
        await expect(page.getByRole('status').filter({ hasText: '1 of 2 deals temporarily unavailable' })).toBeVisible();
        await expect(page.locator('#dayPanelBody')).toContainText('Synthetic fast date');
        await expect(page.locator('#calAsOf')).toHaveText(updated);
        calendarStatus = 404;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
        const retriedAt = await page.locator('#calAsOf').textContent();
        assert.notEqual(retriedAt, updated);
        await page.clock.setSystemTime(new Date('2026-10-20T15:02:00Z'));
        failAll = true;
        await page.locator('#calRefresh').click();
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
        await expect(page.getByRole('status').filter({ hasText: '1 of 2 deals temporarily unavailable' })).toBeVisible();
        await expect(page.locator('#dayPanelBody')).toContainText('Synthetic fast date');
        await expect(page.locator('#calAsOf')).toHaveText(retriedAt);
        await page.locator('.cal-day-open[data-select-day="2026-10-21"]').click();
        await expect(page.locator('#dayPanelBody')).toContainText('may be incomplete');
        failAll = false;
        slowFails = false;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(page.locator('#dayPanelBody')).toContainText('Nothing on this day.');
      } else {
        await page.waitForURL('**/public-shell/session-ended.html');
        await expect(page.getByRole('heading',{name:'Session ended'})).toBeVisible();
        await expect(page.locator('.cal-chip')).toHaveCount(0);
        releaseLate();
        await expect(page.locator('body')).not.toContainText('Synthetic fast date', { timeout: 5000 });

      }
    } finally {
      release();
      releaseLate();
      await page.close();
    }
  });
});
