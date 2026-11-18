import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { createInvoiceFixture, invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
import worker from '../src/worker.js';
const root = new URL('../', import.meta.url), today = '2026-10-02';
async function open(t, { width = 1440, reducedMotion = 'no-preference', query = '', home = false, receipt = 'ok', engine } = {}) {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'UTC', reducedMotion });
  await page.clock.install({ time: new Date(today + 'T17:00:00Z') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const data = invoiceTrackerFixture(today); let failed = false, denied = false, reads = 0, writes = 0; const attempts = [];
  const routes = (await import("../js/routes.js")).routeContract.routes;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrf_token:'synthetic-session', actor: { slug: 'joe', display_name: 'Demo Partner' } }) });
    if (url.pathname === '/mcp') {
      const req = route.request().postDataJSON().params; let response = {};
      if (engine && ['read-invoice-tracker', 'record-commission-receipt'].includes(req.name)) {
        const answer = await worker.fetch(new Request(url, {
          method: 'POST', headers: await route.request().allHeaders(), body: route.request().postData(),
        }), {
          ENGINE_ROUTING: { get: async key => key === 'invoices-from-engine' ? 'on' : null },
          ENGINE: { fetch: engine },
          CARR: { fetch: () => assert.fail('The invoice request fell back to CARR') },
        });
        return route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: await answer.text() });
      }
      if (req.name === 'read-invoice-tracker') {
        reads++; if (denied) return route.fulfill({ status: 401, body: '' }); if (failed) return route.fulfill({ status: 503, body: '' }); response = data;
      } else if (req.name === 'record-commission-receipt') {
        writes++; attempts.push(structuredClone(req.arguments));
        if (receipt === 'hung') return;
        if (receipt === 'pending') return route.fulfill({ status: 502, body: '' });
        if (receipt === 'conflict') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { isError: true, content: [{ text: JSON.stringify({ error: 'version_conflict' }) }] } }) });
        const row = data.entries.find(row => row.commission_id === req.arguments.commission_id); row.status = 'received'; row.received_on = req.arguments.received_on; row.base_version++;
        if (receipt === 'uncertain') return route.fulfill({ status: 502, body: '' }); response = { ok: true, id: row.commission_id, base_version: row.base_version, received_on: row.received_on };
      } else if (req.name === 'deal-room-board') response = { actor: 'joe', deals: [] };
      else if (req.name === 'lead-board') response = { leads: [] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(response) }] } }) });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${home ? 'review-workflows' : 'invoices'}?mode=live${query}`);
  await page.waitForFunction(home ? () => document.querySelector('#homeInvoices a[data-home-key]') : () => document.querySelector('[data-invoice]'));
  return { page, errors, attempts, setReceipt(value) { receipt = value; }, get reads() { return reads; }, get writes() { return writes; }, setFailed(value) { failed = value; }, setDenied(value) { denied = value; }, update(fn) { fn(data); } };
}
for (const width of [1440, 390, 320]) test(`invoice layout and wide detail at ${width}px`, async t => {
  const { page, errors } = await open(t, { width }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#appMainSlot .app-layout-page-tools #invoiceSearch').count(), 1);
  assert.equal(await page.locator('#invoiceAging strong').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().height<30)),true,'ordinary aging amounts stay on one line');
  await page.locator('[data-invoice]').first().click(); await page.waitForFunction(() => document.querySelector('#invoiceDetail').open);
  assert.equal(await page.getByRole('link', { name: 'Open deal', exact: true }).getAttribute('href'), '/deals?deal=demo-invoice-deal-4');
  const box = await page.locator('#invoiceDetail').boundingBox(); assert.ok(box.width <= width); if (width === 1440) assert.ok(box.width > 850);
  await page.locator('#invoiceOriginal summary').click();
  await mkdir(new URL('out/test-artifacts/w15/', root), { recursive: true }); await page.screenshot({ path: new URL(`out/test-artifacts/w15/detail-${width}.png`, root).pathname });
  await page.locator('#closeInvoiceDetail').click(); assert.ok(await page.locator('[data-invoice]').first().evaluate(node => node === document.activeElement));
  await page.screenshot({ path: new URL(`out/test-artifacts/w15/invoices-${width}.png`, root).pathname });
  await page.locator('[data-status="awaiting"]').click(); assert.equal(await page.locator('[data-invoice]').count(), 1); await page.locator('[data-invoice]').click(); assert.match(await page.locator('#invoiceDetailFacts').innerText(), /Awaiting invoice/); assert.equal(await page.locator('#invoicePayment').isVisible(), false);
  await page.locator('#closeInvoiceDetail').click(); await page.locator('[data-status="unpaid"]').click(); await page.locator('[data-invoice]').first().click(); await page.locator('#invoicePaidDate').fill('2026-10-01'); await page.locator('#markInvoicePaid').click(); await page.waitForFunction(() => /Paid/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.equal(await page.locator('#invoicePayment').isVisible(), false); assert.deepEqual(errors, []);
});
test('filters, aging and automatic refresh preserve drafts and recover failed data', async t => {
  const h = await open(t), page = h.page;
  await page.locator('#invoiceSearch').fill('Cedar'); await page.locator('[data-invoice]').click(); await page.locator('#invoicePaidDate').fill('2026-09-30'); await page.locator('#invoiceOriginal summary').click();
  h.update(data => { data.entries.find(row => row.name === 'Demo Cedar Expansion').gross_amount = '10000'; }); const reads = h.reads; await page.clock.runFor(61000); await page.waitForFunction(() => /10,000/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.ok(h.reads > reads); assert.equal(await page.locator('#invoicePaidDate').inputValue(), '2026-09-30'); assert.equal(await page.locator('#invoiceOriginal').getAttribute('open'), '');
  await page.locator('#closeInvoiceDetail').click(); await page.locator('#clearInvoiceFilters').click(); await page.locator('#invoiceAging [data-age="2"]').click(); assert.equal(await page.locator('[data-invoice]').count(), 1); assert.match(await page.locator('[data-invoice]').innerText(), /Bay/); await page.locator('#allAges').click(); assert.equal(await page.locator('[data-invoice]').count(), 4);
  h.setFailed(true); await page.locator('#refreshInvoices').click(); await page.waitForFunction(() => !document.querySelector('#invoiceNotice').hidden); assert.equal(await page.locator('[data-invoice]').count(), 4); assert.match(await page.locator('#invoiceUpdated').innerText(), /Updated/);
  h.setFailed(false); await page.clock.runFor(61000); await page.waitForFunction(() => document.querySelector('#invoiceNotice').hidden); assert.deepEqual(h.errors, []);
});
test('uncertain receipt reconciles without another write; conflict keeps the draft', async t => {
  const h = await open(t, { receipt: 'uncertain' }); await h.page.locator('[data-invoice]').first().click(); await h.page.locator('#markInvoicePaid').click(); await h.page.waitForFunction(() => /Paid/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.equal(h.writes, 1);
  const c = await open(t, { receipt: 'conflict' }); await c.page.locator('[data-invoice]').first().click(); await c.page.locator('#invoicePaidDate').fill('2026-09-30'); await c.page.locator('#markInvoicePaid').click(); await c.page.waitForFunction(() => /Invoice changed/.test(document.querySelector('#invoicePaymentNotice').textContent)); assert.equal(await c.page.locator('#invoicePaidDate').inputValue(), '2026-09-30'); assert.equal(c.writes, 1); assert.equal(await c.page.locator('#markInvoicePaid').isDisabled(), false);
});
test('Mark paid clears the pending attempt when the engine refuses its fields', async t => {
  const data = invoiceTrackerFixture(today);
  const { page } = await open(t, { engine: async request => request.method === 'GET'
    ? Response.json(data)
    : Response.json({ error: 'invalid_field_value', fields: ['received_on'] }, { status: 400 }) });
  await page.locator('[data-invoice]').first().click();
  await page.locator('#invoicePaidDate').fill('2026-09-30');
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.waitForFunction(() => {
    const notice = document.getElementById('invoicePaymentNotice');
    return !notice.hidden && notice.textContent !== 'Confirming payment…';
  });
  assert.equal(await page.locator('#invoicePaymentNotice').innerText(), 'Check the payment details and try again.');
  assert.equal(await page.locator('#invoicePaidDate').isEnabled(), true);
  assert.equal(await page.locator('#invoicePaidDate').inputValue(), '2026-09-30');
});
test('Home attention shares invoice identity, scope and refreshed paid state', async t => {
  const h = await open(t, { home: true }), page = h.page; assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 3);
  await page.locator('[data-scope="mine"]').click(); assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 2);
  h.update(data => { for (const row of data.entries) if (row.owner === 'joe' && row.status === 'invoiced') { row.status = 'received'; row.received_on = today; } });
  await page.clock.runFor(61000); await page.waitForFunction(() => document.querySelector('#homeInvoices').hidden); await page.locator('[data-scope="team"]').click(); assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 1); assert.deepEqual(h.errors, []);
  await page.screenshot({ path: new URL('out/test-artifacts/w15/home-attention-1440.png', root).pathname });
});
test('pending receipt confirmations remain attached to each invoice across popup changes', async t => {
  const h = await open(t, { receipt: 'pending' }), page = h.page;
  const invoices = page.locator('[data-invoice]');
  const first = await invoices.nth(0).getAttribute('data-invoice');
  await invoices.nth(0).click(); await page.locator('#markInvoicePaid').click();
  await page.locator('#invoicePaymentNotice').getByText('Payment confirmation pending.', { exact: true }).waitFor();
  await page.locator('#closeInvoiceDetail').click(); await invoices.nth(1).click(); await page.locator('#markInvoicePaid').click();
  await page.locator('#invoicePaymentNotice').getByText('Payment confirmation pending.', { exact: true }).waitFor();
  await page.locator('#closeInvoiceDetail').click(); await invoices.nth(0).click();
  assert.equal(await page.locator('#markInvoicePaid').innerText(), 'Retry payment');
  h.update(data => { data.entries.find(row => row.commission_id === first).gross_amount = '9401'; });
  await page.clock.runFor(61000); await page.waitForFunction(() => /9,401/.test(document.querySelector('#invoiceDetailFacts').textContent));
  assert.equal(h.writes, 2);
  h.update(data => { const row = data.entries.find(row => row.commission_id === first); row.status = 'received'; row.received_on = today; });
  await page.clock.runFor(61000); await page.waitForFunction(() => document.querySelector('#invoicePayment').hidden);
  await page.locator('#closeInvoiceDetail').click(); await page.locator('[data-invoice]').filter({ hasText: 'Demo Bay' }).click();
  assert.equal(await page.locator('#markInvoicePaid').innerText(), 'Retry payment'); assert.equal(h.writes, 2);
});
test('deep link, reduced motion and authentication loss keep the screen contract', async t => {
  const h = await open(t, { width: 390, reducedMotion: 'reduce', query: '&invoice=00000000-0000-4000-8000-000000000002' }); await h.page.waitForFunction(() => document.querySelector('#invoiceDetail').open); assert.equal(await h.page.locator('#invoiceDetailTitle').innerText(), 'Demo Oak Purchase');
  await h.page.locator('#closeInvoiceDetail').click(); assert.equal(await h.page.locator('.invoice-row.overdue .invoice-state').first().evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  await h.page.screenshot({ path: new URL('out/test-artifacts/w15/reduced-motion-390.png', root).pathname }); h.setDenied(true); await h.page.locator('#refreshInvoices').click(); await h.page.waitForURL('**/public-shell/session-ended.html'); assert.equal(await h.page.locator('[data-invoice]').count(), 0); assert.deepEqual(h.errors, []);
});
for (const width of [1440, 390]) test(`Home invoice attention fits ${width}px`, async t => {
  const h = await open(t, { home: true, width });
  const overflow = await h.page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>({id:node.id,cls:String(node.className),right:node.getBoundingClientRect().right})).slice(0,12)}));
  assert.ok(overflow.scroll<=overflow.width, JSON.stringify(overflow));
  await h.page.screenshot({ path: new URL(`out/test-artifacts/w15/home-attention-${width}.png`, root).pathname });
  assert.deepEqual(h.errors, []);
});

test('status controls reconcile unpaid aging before showing Paid or Awaiting invoice',async t=>{
 const {page}=await open(t);
 for(const status of ['paid','awaiting']){
  await page.locator('#invoiceAging [data-age="3"]').click();await page.locator(`[data-status="${status}"]`).click();
  assert.equal(await page.locator('[data-invoice]').count(),1);assert.equal(await page.locator('#invoiceFiltered').innerText(),'');
 }
});
test('owner scope survives an empty snapshot result',async t=>{
 const h=await open(t);await h.page.locator('#invoiceOwner').selectOption('dell');
 h.update(data=>{data.entries=data.entries.filter(row=>row.owner!=='dell');});await h.page.locator('#refreshInvoices').click();
 await h.page.waitForFunction(()=>document.querySelector('#invoiceRows').textContent.includes('No invoices match'));
 assert.equal(await h.page.locator('#invoiceOwner').inputValue(),'dell');assert.equal(await h.page.locator('[data-invoice]').count(),0);
});
test('unknown aging amounts remain visible without a quantitative fill',async t=>{
 const h=await open(t);h.update(data=>{data.entries=[{...data.entries[5],invoiced_on:'2026-09-25'}, {...data.entries[1],gross_amount:'0'}];});
 await h.page.locator('#refreshInvoices').click();await h.page.waitForFunction(()=>document.querySelectorAll('[data-invoice]').length===2);
 const unknown=h.page.locator('#invoiceAging [data-age="0"]');assert.match(await unknown.innerText(),/—/);assert.match(await unknown.innerText(),/1 amount pending/);
 assert.equal(await unknown.locator('.age-fill').getAttribute('width'),'0');
 assert.match(await h.page.locator('#invoiceAging [data-age="1"]').innerText(),/\$0.00/);
});
test('payment uncertainty offers explicit immutable replay across close, polling and reload',async t=>{
 const h=await open(t,{receipt:'pending'}),page=h.page;const key=await page.locator('[data-invoice]').first().getAttribute('data-invoice');
 await page.locator('[data-invoice]').first().click();await page.locator('#invoicePaidDate').fill('2026-09-30');await page.locator('#markInvoicePaid').click();
 await page.waitForFunction(()=>document.querySelector('#markInvoicePaid').textContent==='Retry payment');
 await page.locator('#closeInvoiceDetail').click();await page.locator(`[data-invoice="${key}"]`).click();assert.equal(await page.locator('#invoicePaidDate').inputValue(),'2026-09-30');
 await page.clock.runFor(93000);assert.equal(h.writes,1);assert.equal(await page.locator('#markInvoicePaid').isEnabled(),true);
 await page.reload();await page.locator(`[data-invoice="${key}"]`).click();assert.equal(await page.locator('#invoicePaidDate').inputValue(),'2026-09-30');assert.equal(await page.locator('#invoicePaidDate').isDisabled(),true);
 h.setReceipt('ok');await page.locator('#markInvoicePaid').click();await page.waitForFunction(()=>document.querySelector('#invoicePayment').hidden);
 assert.equal(h.writes,2);assert.deepEqual(h.attempts[1],h.attempts[0]);assert.deepEqual(h.errors,[]);
});
test('with the engine switch on, retry displays one payment with its date', async t => {
  const fixture = createInvoiceFixture({ today: () => today });
  const before = await fixture.getInvoiceTracker();
  const attempts = [];
  const engine = async request => {
    if (request.method === 'GET') return Response.json(attempts.length < 2 ? before : await fixture.getInvoiceTracker());
    assert.equal(new URL(request.url).pathname, '/api/engine/invoices/mark-paid');
    assert.equal(request.headers.get('x-carr-csrf'), 'synthetic-session');
    const args = await request.json();
    attempts.push(args);
    const receipt = await fixture.markInvoicePaid(args);
    return attempts.length === 1 ? new Response(null, { status: 502 }) : Response.json({ ...receipt, replayed: true });
  };
  const { page, errors } = await open(t, { engine });
  assert.equal(await page.locator('[data-invoice]').count(), before.entries.length);
  for (const row of before.entries) {
    const invoice = page.locator('[data-invoice]').filter({ has: page.getByText(row.name, { exact: true }) });
    await invoice.click();
    assert.equal(await page.locator('#invoiceDetailTitle').innerText(), row.name);
    assert.equal(await page.getByRole('button', { name: 'Mark paid' }).isVisible(), row.status === 'invoiced');
    await page.getByRole('button', { name: 'Close invoice' }).click();
  }
  const invoice = page.locator('[data-invoice]').filter({ hasText: 'Demo Cedar Expansion' });
  await invoice.click();
  await page.locator('#invoicePaidDate').fill('2026-09-30');
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.getByRole('button', { name: 'Retry payment' }).click();
  await page.locator('.invoice-status-value').getByText('Paid', { exact: true }).waitFor();
  assert.equal(await page.locator('#invoiceTimeline time[datetime="2026-09-30"]').innerText(), 'Sep 30, 2026');
  assert.equal(await page.locator('#invoicePayment').isVisible(), false);
  assert.equal(await page.locator('[data-invoice]').count(), before.entries.length);
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  const saved = (await fixture.getInvoiceTracker()).entries.find(row => row.commission_id === attempts[0].commission_id);
  assert.equal(saved.base_version, attempts[0].base_version + 1);
  assert.equal(saved.received_on, '2026-09-30');
  assert.deepEqual(errors, []);
  const evidence = new URL('out/test-artifacts/w15/', root);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: new URL('engine-payment.png', evidence).pathname });
});
test('hung payment becomes recoverable after the write deadline without an automatic write',async t=>{
 const h=await open(t,{receipt:'hung'});await h.page.locator('[data-invoice]').first().click();await h.page.locator('#markInvoicePaid').click();
 await h.page.clock.runFor(11000);await h.page.waitForFunction(()=>document.querySelector('#markInvoicePaid').textContent==='Retry payment');
 assert.equal(h.writes,1);assert.equal(await h.page.locator('#markInvoicePaid').isEnabled(),true);
});
test('phone focus survives automatic invoice removal and filtered-out row repaint',async t=>{
 const h=await open(t,{width:320}),page=h.page;
 await page.locator('[data-invoice]').first().click();h.update(data=>{data.entries=data.entries.filter(row=>row.name!=='Demo Cedar Expansion');});
 await page.clock.runFor(61000);await page.waitForFunction(()=>!document.querySelector('#invoiceDetail').open);
 assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#refreshInvoices')),true);
 await page.locator('[data-invoice]').first().focus();await page.evaluate(()=>{const input=document.querySelector('#invoiceSearch');input.value='no match';input.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#refreshInvoices')),true);
});
test('large and aggregate currency values fit 320px with unavailable web fonts',async t=>{
 const h=await open(t,{width:320}),page=h.page;
 for(const amount of ['1000000','10000000','999999999999.99']){
  h.update(data=>{for(const row of data.entries)if(row.commission_id)row.gross_amount=amount;});await page.locator('#refreshInvoices').click();
  await page.waitForFunction(value=>document.querySelector('.row-money').textContent.includes(Number(value).toLocaleString('en-US',{maximumFractionDigits:2})),amount);
  const check=async()=>page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('.invoice-total strong,.invoice-age strong,.row-money,.invoice-detail-facts strong')].filter(node=>node.getClientRects().length&&node.scrollWidth>node.clientWidth+1).map(node=>node.textContent)}));
  let result=await check();assert.equal(result.scroll<=result.width,true,JSON.stringify(result));assert.deepEqual(result.offenders,[]);
  await page.locator('[data-invoice]').first().click();result=await check();assert.deepEqual(result.offenders,[]);await page.locator('#closeInvoiceDetail').click();
 }
});
