import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDoctorcreRequest } from '../src/worker.js';

const path = '/a/al1_bGQ6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx';
test('action links use the partner Home gate and retain their exact sign-in destination', async () => {
  for (const status of [200, 302, 403, 503]) {
    let gatePath, asset;
    const response = await handleDoctorcreRequest(new Request(`https://app.doctorcre.com${path}`), {
      CARR: { fetch: async request => {
        gatePath = new URL(request.url).pathname;
        return new Response(null, {status, headers: status === 302 ? {location:'/auth/login?return_to=%2Fleads'} : {}});
      } },
      ASSETS: { fetch: async request => { asset = new URL(request.url).pathname; return new Response('page'); } },
    });
    assert.equal(gatePath, '/');
    assert.equal(response.status, status);
    assert.equal(asset, status === 200 ? '/action-link.html' : undefined);
    if (status === 302) assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'), path);
  }
});

test('linked drafts keep Leads selected in the shared navigation', async () => {
  const { activeDestination } = await import('../js/navigation.js');
  assert.equal(activeDestination(path), '/leads');
});

test('retired action links show the unavailable page after the Home gate', async () => {
  for (const kind of ['cr', 'fe']) {
    const ref = `al1_${Buffer.from(`${kind}:11111111-1111-4111-8111-111111111111:1`).toString('base64url')}`;
    const response = await handleDoctorcreRequest(new Request(`https://app.doctorcre.com/a/${ref}`), {
      CARR: { fetch: async () => new Response(null, {status: 200}) },
      ASSETS: { fetch: async () => new Response('legacy page') },
    });
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /This link is no longer available/);
    assert.match(html, /href="\/"/);
  }
});

test('unknown and malformed refs retain the legacy route', async () => {
  for (const ref of ['unknown', 'al1_Y3I6invalid', `al1_${Buffer.from('xx:11111111-1111-4111-8111-111111111111:1').toString('base64url')}`]) {
    const response = await handleDoctorcreRequest(new Request(`https://app.doctorcre.com/a/${ref}`), {
      CARR: { fetch: async () => new Response(null, {status: 200}) },
      ASSETS: { fetch: async () => new Response('legacy page') },
    });
    assert.equal(await response.text(), 'legacy page');
  }
});
