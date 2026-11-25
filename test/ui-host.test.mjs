// Workspace slice S1: the React node host moves a page's original node into a
// React-managed container. Nothing is cloned or re-rendered, so identity,
// listeners, drafts and ids survive the move ("nothing reloads when it moves").
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

const UI_BUNDLE = '/js/ui-zoom.generated.js';

async function hostInDom() {
  const dom = new JSDOM('<main id="slot"><p id="before"></p><section id="panel"><input id="draft"><button id="act">Act</button></section><p id="after"></p></main>');
  // React DOM reads the browser globals when its module evaluates.
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { hostNode } = await import(`../js/ui-host.generated.js?jsdom=${Math.random()}`);
  return { document: dom.window.document, hostNode, close: () => dom.window.close() };
}

test('the host moves the original node: same object, listener, draft and id', async t => {
  const { document, hostNode, close } = await hostInDom();
  t.after(() => { close(); delete globalThis.window; delete globalThis.document; });
  const panel = document.getElementById('panel');
  let clicks = 0;
  panel.querySelector('#act').addEventListener('click', () => clicks++);
  panel.querySelector('#draft').value = 'unsaved draft';

  const root = hostNode(panel);

  const host = document.querySelector('[data-node-host]');
  assert.ok(host, 'the React container is mounted');
  assert.equal(host.firstElementChild, panel, 'the hosted node is the original object, not a copy');
  assert.equal(document.getElementById('panel'), panel);
  assert.equal(document.querySelectorAll('#panel, #draft, #act').length, 3, 'no duplicate ids');
  assert.equal(panel.querySelector('#draft').value, 'unsaved draft', 'the draft survives the move');
  panel.querySelector('#act').click();
  assert.equal(clicks, 1, 'the listener bound before the move still fires');
  assert.equal(host.closest('#slot'), document.getElementById('slot'), 'the host stands where the node stood');

  root.unmount();
  assert.equal(document.querySelector('[data-node-host]'), null);
  assert.equal(document.getElementById('before').nextElementSibling?.nextElementSibling, panel, 'unmount puts the node back in place');
  assert.equal(panel.nextElementSibling, document.getElementById('after'));
  panel.querySelector('#act').click();
  assert.equal(clicks, 2);
});

async function openInvoices(t, search, width = 1280) {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const bundleRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === UI_BUNDLE) bundleRequests.push(request.url()); });
  await page.addInitScript(() => localStorage.setItem('doctorcre:today:/invoices', 'open'));
  await page.goto(`${server.origin}/invoices${search}`);
  await page.locator('[data-invoice]').first().waitFor();
  return { page, bundleRequests };
}

test('with ?ui=react a partner can use the stage workspace without losing the page or phone layout', async t => {
  const { page, bundleRequests } = await openInvoices(t, '?ui=react');
  await page.locator('#appLayout .workspace-shell').waitFor();
  await page.locator('#invoiceSearch').waitFor({ state: 'visible' });
  assert.equal(bundleRequests.length, 1);
  assert.equal(await page.locator('#appLayout .workspace-group').count(), 2);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#appSidebar').hidden);
  assert.equal(await page.locator('#appLayout .workspace-group').count(), 3);
  assert.equal(await page.locator('#appLayout .invoice-workspace').count(), 1);
  await page.evaluate(() => {
    window.workspacePageNodes = ['#appSidebar', '.app-layout-center', '#appToday', '.invoice-workspace']
      .map(selector => [selector, document.querySelector(selector)]);
  });

  const divider = page.getByRole('separator', { name: 'Resize panels', exact: true }).first();
  const sidebarWidth = () => page.locator('#appSidebar').evaluate(node => node.getBoundingClientRect().width);
  const beforeResize = await sidebarWidth();
  await page.locator('#invoiceSearch').fill('synthetic workspace draft');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await sidebarWidth() > beforeResize + 20);
  assert.equal(await page.locator('#invoiceSearch').inputValue(), 'synthetic workspace draft');
  assert.equal(await page.evaluate(() => window.workspacePageNodes
    .every(([selector, node]) => node === document.querySelector(selector))), true);

  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#appSidebar').hidden);
  assert.equal(await page.locator('#appLayout .workspace-group').count(), 2);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#appSidebar').hidden);
  assert.equal(await page.locator('#appLayout .workspace-group').count(), 3);
  assert.equal(await page.evaluate(() => window.workspacePageNodes
    .every(([selector, node]) => node === document.querySelector(selector))), true);
  assert.ok(await page.locator('#invoiceSearch').isVisible());

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#appLayout .workspace-shell').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#appLayout').evaluate(node => [...node.children].some(child => child.id === 'appSidebar')), true);
  assert.equal(await page.locator('#appLayout .app-layout-center .invoice-workspace').count(), 1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#appLayout .workspace-shell').waitFor();
  assert.equal(await page.locator('#appLayout .workspace-group').count(), 3);
});

test('the React workspace flag does not load for an unrecognized fixture actor', async t => {
  const { page, bundleRequests } = await openInvoices(t, '?actor=guest&ui=react');
  assert.equal(await page.locator('.workspace-shell, [data-node-host]').count(), 0);
  assert.deepEqual(bundleRequests, []);
});

test('the React workspace keeps the touch layout on a phone', async t => {
  const { page } = await openInvoices(t, '?ui=react', 390);
  assert.equal(await page.locator('#appLayout .workspace-shell').count(), 0);
  assert.equal(await page.locator('#appLayout .app-layout-center .invoice-workspace').count(), 1);
  assert.ok(await page.locator('#appShell').isVisible());
});

test('without the flag the Invoices page keeps the classic workspace', async t => {
  const { page, bundleRequests } = await openInvoices(t, '');
  assert.equal(await page.locator('[data-node-host]').count(), 0);
  assert.equal(await page.locator('#appMainSlot .invoice-workspace').count(), 1);
  assert.deepEqual(bundleRequests, []);
});
