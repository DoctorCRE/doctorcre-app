import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { emailSubject as reactSubject, emailPlaceholderText as reactText } from '../src/ui/home/email-subject.ts';
import { emailSubject as classicSubject, emailPlaceholderText as classicText, loadEvidence, renderEvidence, renderCorrespondence } from '../js/correspondence.js';

test('latest email threads keep email classification and message times in newest-first order', async () => {
  const view = await loadEvidence({ email_threads: [
    { subject: 'Older email', latest_message_at: '2026-12-01T12:00:00Z' },
    { subject: 'Newer email', latest_message_at: '2026-12-02T12:00:00Z' },
  ] });
  assert.deepEqual(view.threads.items.map(item => item.title), ['Newer email', 'Older email']);
  const doc = new JSDOM(renderEvidence(view)).window.document;
  const rows = [...doc.querySelectorAll('[data-kind="thread"]')];
  assert.deepEqual(rows.map(row => row.querySelector('summary span').textContent), ['Newer email', 'Older email']);
  assert.ok(rows.every(row => row.querySelector('p').textContent === 'Email'));
  assert.equal(rows[0].querySelector('time').textContent, 'Dec 2, 6:00 AM');
});

test('missing email thread coverage stays unavailable without reading a mailbox', async () => {
  const view = await loadEvidence({});
  assert.equal(view.threads.state, 'unavailable');
  assert.equal(view.threads.count, null);
});

test('email snapshots distinguish empty coverage and escape missing or untrusted subjects', async () => {
  const empty = await loadEvidence({ email_threads: [] });
  assert.equal(empty.threads.count, 0);
  assert.match(renderEvidence(empty), /No email threads/);
  const view = await loadEvidence({ email_threads: [
    { subject: '<img src=x onerror=alert(1)>', latest_message_at: '2026-12-01T12:00:00Z' },
    { subject: '', latest_message_at: '2026-12-02T12:00:00Z' },
  ] });
  const html = renderEvidence(view);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(view.threads.items[0].title, '(No subject)');
});

test('email snapshots preserve meeting ordering, provenance checks and escaping', async () => {
  const meeting = { id:'demo-meeting', source:'Demo calendar', kind:'meeting', summary:'<b>Demo meeting</b>', occurred_at:'2026-12-01T12:00:00Z' };
  const view = await loadEvidence({ email_threads: [], activities:[meeting, {...meeting, id:'demo-newer', occurred_at:'2026-12-02T12:00:00Z'}] });
  assert.deepEqual(view.meetings.items.map(item => item.id), ['demo-newer', 'demo-meeting']);
  assert.doesNotMatch(renderEvidence(view), /<b>/);
  assert.match(renderEvidence(view), /&lt;b&gt;/);
  assert.equal((await loadEvidence({activities:[{...meeting,source:null}]})).meetings.state, 'unavailable');
});

test('a deal with no meetings says so plainly instead of unavailable', async () => {
  const view = await loadEvidence({ email_threads: [], activities: [{ id:'demo-note', kind:'note', source:'stated', summary:'Demo note', occurred_at:'2026-12-01T12:00:00Z' }] });
  assert.deepEqual(view.meetings, { state: 'ready', count: 0, items: [] });
  const html = renderEvidence(view);
  assert.match(html, /No meetings/);
  assert.doesNotMatch(html, /unavailable/);
});

test('an unreadable read shows unavailable with Refresh deal, which re-reads the deal', async () => {
  const doc = new JSDOM(renderEvidence(await loadEvidence({}))).window.document;
  const groups = [...doc.querySelectorAll('[data-evidence-group]')];
  assert.deepEqual(groups.map(group => group.querySelector('h4').textContent), ['Email threads unavailable', 'Meetings unavailable']);
  assert.ok(groups.every(group => group.querySelector('button[data-refresh-detail]')?.textContent === 'Refresh deal'));
});

test('filed correspondence uses clear empty and missing subject wording', () => {
  assert.match(renderCorrespondence([]), /No emails or meetings filed to this deal yet\./);
  assert.match(renderCorrespondence([], 2), /No emails or meetings filed yet\. 2 emails are waiting to be filed on Overview\./);
  assert.match(renderCorrespondence([], 1), /1 email is waiting to be filed on Overview\./);
  assert.doesNotMatch(renderCorrespondence([{kind: 'meeting'}], 1), /waiting to be filed/);
  const doc = new JSDOM(renderCorrespondence([{kind: 'email', subject: '', sender: 'Demo sender', happened_at: '2026-12-01T12:00:00Z'}])).window.document;
  assert.equal(doc.querySelector('li b').textContent, '(No subject)');
  const supplied = new JSDOM(renderCorrespondence([{kind: 'email', subject: '(no subject)'}])).window.document;
  assert.equal(supplied.querySelector('li b').textContent, '(No subject)');
});

test('email subject formatters agree on missing subjects and preserve real subjects', () => {
  for (const format of [classicSubject, reactSubject]) {
    for (const value of [null, undefined, '', '  ', 'no subject', '(no subject)', '(NO SUBJECT)']) assert.equal(format(value), '(No subject)');
    assert.equal(format('  Example subject  '), 'Example subject');
  }
  for (const format of [classicText, reactText]) assert.equal(format('Reply (no subject)'), 'Reply (No subject)');
});
