import { newestFirst } from './change-receipts.mjs';
import { sourceTime } from './email-source-line.js';
import { meetingEvidence, unavailableEvidence } from './correspondence-model.js';
export const emailSubject = value => {
  const subject = value?.trim();
  return !subject || /^(?:\(no subject\)|no subject)$/i.test(subject) ? '(No subject)' : subject;
};
export const emailPlaceholderText = value => value.replace(/\(no subject\)/gi, '(No subject)');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const GROUPS = [
  { key: 'threads', title: 'Email threads', none: 'No email threads', kind: 'thread', label: 'Email' },
  { key: 'meetings', title: 'Meetings', none: 'No meetings', kind: 'meeting', label: 'Meeting' },
];

function evidenceGroup({ key, title, none, kind, label }, state) {
  if (state.state === 'refused') return `<div class="evidence-group" data-evidence-group="${key}" data-state="refused"><h4>${title} unavailable</h4><a href="/auth/login">Sign in</a></div>`;
  if (state.state === 'loading') return `<div class="evidence-group" data-evidence-group="${key}" data-state="loading"><h4>${title} loading…</h4></div>`;
  if (state.state !== 'ready') return `<div class="evidence-group" data-evidence-group="${key}" data-state="${esc(state.state)}"><h4>${title} unavailable</h4><button class="btn" type="button" data-refresh-detail>Refresh deal</button></div>`;
  if (!state.items?.length) return `<div class="evidence-group" data-evidence-group="${key}"><h4>${title}</h4><p>${none}</p></div>`;
  return `<div class="evidence-group" data-evidence-group="${key}"><h4>${title}</h4><ol class="evidence-timeline">${state.items.map(item => `<li class="evidence-item" data-kind="${kind}"><details><summary><span>${esc(item.title)}</span><time datetime="${esc(item.when)}">${esc(sourceTime(item.when))}</time></summary><p>${label}</p></details></li>`).join('')}</ol></div>`;
}
export function renderEvidence(view = {}) {
  const groups = GROUPS.filter(group => view[group.key]?.state);
  return groups.length ? `<section class="correspondence-evidence" aria-label="Evidence"><h3>Evidence</h3>${groups.map(group => evidenceGroup(group, view[group.key])).join('')}</section>` : '';
}
export async function loadEvidence(detail = {}) {
  const meetings = meetingEvidence(detail.activities);
  if (!Array.isArray(detail.email_threads)) return { threads: unavailableEvidence(), meetings };
  const items = newestFirst(detail.email_threads.map(row => ({ title: emailSubject(row.subject), when: row.latest_message_at })), item => item.when);
  return { threads: { state: 'ready', count: items.length, items }, meetings };
}

export function renderCorrespondence(entries, waitingEmails = 0) {
  const heading = '<h3>Emails and meetings</h3>';
  if (!Array.isArray(entries)) return `${heading}<p>Emails and meetings unavailable.</p><button class="btn" type="button" data-refresh-detail>Retry emails and meetings</button>`;
  if (!entries.length) return waitingEmails
    ? `${heading}<p>No emails or meetings filed yet. ${waitingEmails} email${waitingEmails === 1 ? ' is' : 's are'} waiting to be filed on Overview.</p>`
    : `${heading}<p>No emails or meetings filed to this deal yet.</p>`;
  return `<section class="correspondence-evidence" aria-label="Emails and meetings">${heading}
    <ol class="evidence-timeline" role="list">${entries.map(entry => {
      const meeting = entry.kind === 'meeting';
      const title = meeting ? entry.title?.trim() || 'Untitled meeting' : emailSubject(entry.subject);
      const context = meeting ? 'Meeting' : `Email · ${entry.sender_name || entry.sender || 'Unknown sender'}`;
      return `<li class="evidence-item"><b${meeting ? ' class="meeting-caption"' : ''}>${esc(title)}</b>
        <div class="evidence-source">${esc(context)}</div>
        <time datetime="${esc(entry.happened_at)}">${esc(sourceTime(entry.happened_at))}</time></li>`;
    }).join('')}</ol></section>`;
}
