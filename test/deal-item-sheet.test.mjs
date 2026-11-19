import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealItemSheet } from '../js/deal-item-sheet.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Tell Dr. CRE keeps the draft and does not submit', async () => {
 const {window} = new JSDOM('<body></body>'); const {document} = window;
 window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
 let writes = 0; const sheet = mountDealItemSheet({document, read: async () => ({items:[{id:'demo',title:'Demo',status:'open',bullets:[{kind:'status',text:'Earlier history'}]}]}), send: async () => { writes++; }, refresh() {}});
 sheet.open('deal','demo'); await tick(); const input=document.querySelector('textarea'); input.value='Synthetic draft';
 assert.equal(document.querySelector('[type="submit"]').disabled,true);
 assert.match(document.querySelector('form').textContent,/Not submitted\. This control cannot send a request to Dr\. CRE\./);
 document.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})); await tick();
 assert.equal(input.value,'Synthetic draft'); assert.equal(writes,0); assert.match(document.body.textContent,/Earlier history/);
});

test('an open engine item without a version uses the unavailable item state', async () => {
  const { window } = new JSDOM('<body></body>');
  const { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const item = { id: 'example-item', title: 'Review the floor plan', status: 'open' };
  let version;
  const writes = [];
  const sheet = mountDealItemSheet({
    document,
    read: async () => ({
      items: [item],
      next_actions: [{ id: item.id, change_id: version }],
      next_deal_saves: true,
    }),
    send: async (_key, { args }) => { writes.push(args); },
    refresh() {},
  });

  sheet.open('example-deal', item.id);
  await Promise.resolve();
  assert.equal(document.querySelector('[role="status"]').textContent, 'Item unavailable.');
  assert.equal(document.querySelector('[data-complete-item]'), null);
  assert.deepEqual(writes, []);

  version = 0;
  document.querySelector('[data-retry-item]').click();
  await Promise.resolve();
  document.querySelector('[data-complete-item]').click();
  assert.deepEqual(writes, [{ deal: 'example-deal', item_id: item.id, base_version: 0 }]);
});
