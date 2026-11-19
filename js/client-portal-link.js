import { escapeText as esc } from './change-receipts.mjs';
import { sessionFetch } from './private-session.js';
import { uuidv4 } from './uuid.js';

export function renderClientPortalLink(url, grantDeal) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
  const label = 'Client website<span class="sr-only"> (opens in a new tab)</span>';
  return grantDeal
    ? `<button class="client-portal-link" type="button" data-open-client-website="${esc(grantDeal)}">${label}</button>`
    : `<a class="client-portal-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

const websitePath = deal => `/api/engine/deals/${encodeURIComponent(deal)}/client-website`;
const requestWebsite = (path, body) => sessionFetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10_000),
});

export async function openEngineClientWebsite(deal) {
  const tab = window.open('', '_blank');
  if (!tab) return 'Allow pop-ups for DoctorCRE and try again.';
  tab.opener = null;
  tab.document.body.textContent = 'Opening client website…';
  try {
    const response = await requestWebsite(websitePath(deal) + '/open', {});
    const { url } = await response.json();
    if (response.ok && typeof url === 'string'
        && /^https:\/\/share\.doctorcre\.com\/[a-z0-9][a-z0-9-]{0,62}\/\?grant=[\da-f-]{36}$/.test(url)) {
      tab.location.replace(url);
      return null;
    }
  } catch { /* Close the waiting tab if it cannot open the site. */ }
  tab.close();
  return 'Could not open the client website. Refresh the deal and try again.';
}

const setupRefusals = new Map([
  ['portal_slug_taken', 'That website name is already taken. Choose another name.'],
  ['portal_password_differs', 'Enter the existing website password and try again.'],
  ['portal_deal_already_registered', 'This deal already has a client website. Refresh the deal to see it.'],
  ['portal_deal_not_found', 'The deal needs a current client before you can set up a website.'],
  ['invalid_field_value', 'Check the website name and password and try again.'],
  ['not_found', 'Website setup is unavailable. Refresh the deal and try again.'],
]);

export async function saveEngineClientWebsite(deal, slug, password) {
  try {
    const response = await requestWebsite(websitePath(deal), { slug, password, idempotency_key: uuidv4() });
    const result = await response.json();
    if (response.ok && result?.ok === true && result.deal_id === deal) return null;
    if (setupRefusals.has(result?.error)) return setupRefusals.get(result.error);
  } catch { /* A lost response can follow a successful save. */ }
  return 'Could not confirm that the website was saved. Refresh the deal before trying again.';
}
