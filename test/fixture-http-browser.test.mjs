import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { chromium } from './browser-harness.mjs';

function closeFixture(t, browser, server) {
  t.after(async () => {
    await browser.close();
    await server.close();
  });
}

test('Fixture cleanup releases an unfinished browser response', async t => {
  const server = await startFixture({routes:new Map([['/s8-held-response',{
    body:'<!doctype html><title>Unfinished response</title>',contentType:'text/html',hold:'unfinished',partial:true,
  }]])});
  t.after(() => server.close());
  const browser = await chromium.launch();
  closeFixture(t, browser, server);
  const page = await browser.newPage();
  await page.goto(`${server.origin}/s8-held-response`, { waitUntil: 'commit' });
  assert.equal(await page.evaluate(() => document.readyState), 'loading');
});
