import test from 'node:test';
import assert from 'node:assert/strict';
import { relationshipValid, validListPayload, validRecordPayload, parseViewState, viewHref } from '../js/workspace-business-model.js';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

test('W5 validates the complete partnership payload and rejects malformed evidence before rendering', () => {
  const list=directoryFixture('http://demo.example/api/v1/business/vendors');
  assert.equal(validListPayload(list,'vendors'),true);
  const record=directoryFixture(`http://demo.example/api/v1/business/vendors/${list.rows[0].id}`);
  assert.equal(validRecordPayload(record,'vendors'),true);
  const stats=list.rows[0].relationship;
  for(const patch of [{win_rate:2},{deals_worked:-1},{computed_tier:'Trusted'},{recent_entries:{}},{introductions:[{}]},{override:{tier:'Trial',reason:'',recorded_by:'joe',recorded_at:'2026-10-01'}}]) assert.equal(relationshipValid({...stats,...patch}),false,JSON.stringify(patch));
  assert.equal(relationshipValid({...stats,coverage_verified_at:null,deals_worked:null,deals_referred:null,win_rate:null,computed_tier:'Unrated'}),true);
  assert.equal(relationshipValid({...stats,coverage_verified_at:null,override:null}),true);
  assert.equal(validListPayload({...list,rows:list.rows.map(row=>({...row,relationship:{...row.relationship,coverage_verified_at:null,override:null}}))},'vendors'),true);
  assert.equal(validRecordPayload({...record,record:{...record.record,relationship:{...record.record.relationship,coverage_verified_at:null,override:null}}},'vendors'),true);
  assert.equal(validRecordPayload({...record,record:{...record.record,loan_programs:42}},'vendors'),false);
});

test('W5 owner and territory survive canonical navigation; client territory is dropped', () => {
  const vendor=parseViewState('/vendors','?owner=dell&territory=Demo%20North&sort=last_deal_asc').query;
  assert.equal(vendor.owner,'dell');assert.equal(vendor.territory,'Demo North');assert.equal(vendor.sort,'last_deal_asc');
  assert.equal(new URL(viewHref(vendor),'http://demo.example').searchParams.get('territory'),'Demo North');
  assert.equal(parseViewState('/clients','?territory=Demo&owner=other').query.territory,'');
  assert.equal(parseViewState('/clients','?owner=other').query.owner,'all');
});

import { readFileSync } from 'node:fs';
import { openDom } from './jsdom-harness.mjs';
import * as model from '../js/workspace-business-model.js';
import { activityCopy } from '../js/record-activity-model.js';
import { BUSINESS_TIME_ZONE } from '../js/business-date.js';
import { phoneLabel, withoutRecordCodes } from '../js/visual-system.js';
import { updatedLabel } from '../js/auto-refresh.mjs';
import { renderEvidence } from '../js/correspondence.js';

const source = readFileSync(new URL('../js/workspace-business.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../business.html', import.meta.url), 'utf8');

function setup(dataset, locale = 'en-US') {
  const dom = openDom(page, { url: `https://example.test/${dataset}`, runScripts: 'outside-only' });
  const { window } = dom;
  Object.assign(window, model, { activityCopy, updatedLabel, renderEvidence, BUSINESS_TIME_ZONE, phoneLabel, withoutRecordCodes, resolveDealroomBoot: () => ({ mode: 'fixture' }) });
  window.matchMedia = () => Object.assign(new window.EventTarget(), { matches: false });
  // Emulate a browser whose default clock is 24-hour without changing the
  // renderer. Explicit locales and clock options still reach native Intl.
  const nativeLocaleString = window.Date.prototype.toLocaleString;
  window.Date.prototype.toLocaleString = function(locales, options) {
    return nativeLocaleString.call(this, !locales || locales.length === 0 ? locale : locales, options);
  };
  // Execute the page's real renderers, leaving boot/transport reads unstarted.
  window.eval(source.slice(source.indexOf('const EXPIRY_TICK_MS')).replace(/\nstart\(\);\s*$/, '')
    + '\n globalThis.renderers = { view, rowHtml, renderRecordPanel, formatMoment };');
  const app = window.renderers;
  app.view.dataset = dataset;
  app.view.query = model.defaultQuery(dataset);
  const list = directoryFixture(`https://example.test/api/v1/business/${dataset}`);
  const payload = directoryFixture(`https://example.test/api/v1/business/${dataset}/${list.rows[0].id}`);
  return { document: window.document, app, row: list.rows[0], payload };
}

for (const dataset of ['clients', 'vendors']) {
  test(`${dataset}: primary row names the record without an internal reference`, () => {
    const { document, app, row } = setup(dataset);
    document.querySelector('#recordList').innerHTML = app.rowHtml(dataset, row, row.id);
    const link = document.querySelector('.record-row');
    assert.equal(link.querySelector('.row-name').textContent, row.name);
    assert.doesNotMatch(link.textContent, new RegExp(row.ref));
    assert.equal(link.querySelector('.row-ref'), null);
    assert.equal(link.dataset.recordId, row.id, 'exact record identity still drives opening');
    assert.equal(new URL(link.href).searchParams.get('record'), row.id);
    assert.equal(link.getAttribute('aria-current'), 'true');
    assert.match(link.textContent, /Owner: Joe/);
  });

  test(`${dataset}: drawer follows the internal reference visibility for this directory`, () => {
    const { document, app, payload } = setup(dataset);
    app.view.recordId = payload.record.id;
    app.view.record = { status: 'ready', payload };
    app.renderRecordPanel();
    assert.equal(document.querySelector('#recordTitle').textContent, payload.record.name);
    const body = document.querySelector('#recordBody');
    const reference = [...body.querySelectorAll('details')].find(el => el.textContent.includes(payload.record.ref));
    if (dataset === 'vendors') {
      assert.equal(reference, undefined);
      return;
    }
    assert.ok(reference, 'the existing read reference remains accessible in Details');
    assert.equal(reference.querySelector('summary').textContent, 'Details');
    assert.equal(reference.open, false);
    reference.open = true;
    app.renderRecordPanel();
    assert.equal([...body.querySelectorAll('details')].find(el => el.textContent.includes(payload.record.ref)).open, true,
      'refresh preserves the disclosure state');
    for (const details of body.querySelectorAll('details')) details.remove();
    assert.doesNotMatch(body.textContent, new RegExp(payload.record.ref));
  });

  for (const locale of ['en-GB', 'de-DE']) {
    test(`${dataset}: ${locale} defaults cannot put broker timestamps on a 24-hour clock`, () => {
      const { document, app, row, payload } = setup(dataset, locale);
      for (const hour of [0, 9, 12, 17, 23]) {
        const value = new Date(Date.UTC(2026, 9, 1, hour + 5, 7)).toISOString();
        const expected = `${hour % 12 || 12}:07 ${hour < 12 ? 'AM' : 'PM'}`;
        assert.ok(app.formatMoment(value).includes(expected), app.formatMoment(value));
      }
      document.querySelector('#recordList').innerHTML = app.rowHtml(dataset, row, null);
      assert.match(document.querySelector('.row-updated').textContent, /\b(?:AM|PM)\b/);
      if (dataset === 'vendors') {
        assert.match([...document.querySelectorAll('.row-fact')].find(el => el.textContent.includes('Last contacted')).textContent, /\b(?:AM|PM)\b/);
        payload.record.relationship.override = { tier: 'Trial', reason: 'Synthetic review', recorded_by: 'Joe', recorded_at: row.updated_at };
      }
      app.view.recordId = payload.record.id;
      app.view.record = { status: 'ready', payload };
      app.view.activity = { id: payload.record.id, result: { state: 'ready', rows: [{ what: 'Synthetic conversation', when: row.updated_at, kind: 'activity' }] } };
      app.renderRecordPanel();
      assert.match(document.querySelector('.activity-when').textContent, /\b(?:AM|PM)\b/);
      if (dataset === 'vendors') {
        assert.match([...document.querySelectorAll('.relationship-metric strong')].at(-1).textContent, /\b(?:AM|PM)\b/);
        assert.match(document.querySelector('.relationship-section > .note-summary').textContent, /\b(?:AM|PM)\b/);
        assert.match([...document.querySelectorAll('.network-list time')].at(-1).textContent, /\b(?:AM|PM)\b/);
      }
      assert.equal(app.formatMoment('invalid'), 'an unknown time');
    });
  }
}

test('Vendors show recorded facts and keep names, phones and notes readable', () => {
  const { document, app, row, payload } = setup('vendors');
  row.name = payload.record.name = '(TBD: intake contact) (V-SUP-901)';
  row.owner_label = 'Example Owner';
  Object.assign(row.relationship, { computed_tier: 'Trial', win_rate: null, last_contact_note: 'Recovered from CARR calendar history' });
  Object.assign(payload.record, { phone: '+15550102000', intro_notes: row.relationship.last_contact_note });
  document.querySelector('#recordList').innerHTML = app.rowHtml('vendors', row, row.id);
  const link = document.querySelector('.record-row');
  assert.equal(link.querySelector('.row-name').textContent, '(TBD: intake contact)');
  assert.equal(link.querySelector('.row-owner').textContent, 'Owner: Example Owner');
  assert.doesNotMatch(link.textContent, /Trial|CARR|Not recorded|Win rate/);
  assert.match(link.textContent, /Recovered from calendar history/);
  app.view.recordId = payload.record.id;
  app.view.record = { status: 'ready', payload };
  app.renderRecordPanel();
  assert.equal(document.querySelector('#recordTitle').textContent, '(TBD: intake contact)');
  assert.match(document.querySelector('#recordBody').textContent, /\(555\) 010-2000/);
  assert.doesNotMatch(document.querySelector('#recordBody').textContent, /CARR|Relationship level|Proven/);
});

test('Vendor contact dates keep their calendar day while timestamps use Central', () => {
  const { document, app, row, payload } = setup('vendors');
  row.relationship.last_contacted_at = payload.record.relationship.last_contacted_at = '2026-03-08';
  document.querySelector('#recordList').innerHTML = app.rowHtml('vendors', row, row.id);
  assert.equal(document.querySelector('.row-last-contact .fact-value').textContent, 'Mar 8, 2026');
  app.view.recordId = payload.record.id;
  app.view.record = { status: 'ready', payload };
  app.renderRecordPanel();
  assert.equal(document.querySelector('.relationship-metric:last-child strong').textContent, 'Mar 8, 2026');
  assert.match(app.formatMoment('2026-03-08T00:00:00Z'), /^Mar 7, 2026.*6:00 PM$/);
});

test('Vendor badges distinguish unknown workability from recorded false', () => {
  const { document, app, row } = setup('vendors');
  const list = document.querySelector('#recordList');
  row.recorded_disposition_workable = null;
  list.innerHTML = app.rowHtml('vendors', row, row.id);
  assert.equal(list.querySelector('.tone'), null);
  row.recorded_disposition_workable = false;
  list.innerHTML = app.rowHtml('vendors', row, row.id);
  assert.equal(list.querySelector('.tone').textContent, 'Not workable');
});

test('An undated vendor conversation shows the note without a time', () => {
  const { document, app, payload } = setup('vendors');
  const [entry] = payload.record.relationship.recent_entries;
  entry.when = null;
  assert.ok(model.validRecordPayload(payload, 'vendors'));
  app.view.recordId = payload.record.id;
  app.view.record = { status: 'ready', payload };
  app.renderRecordPanel();
  const conversation = document.querySelector('.record-section:has([data-details-key="entry-demo-entry"])');
  assert.equal(conversation.querySelector('.note-summary').textContent, entry.summary);
  assert.equal(conversation.querySelector('time'), null);
});
