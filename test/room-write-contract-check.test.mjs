import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';

test('the app no longer forwards room writes to CARR', async () => {
  const env = { PARTNER_SIGN_IN: 'carr', CARR: { fetch: () => assert.fail('Room write reached CARR') } };
  const response = await worker.fetch(new Request('https://app.example.test/api/room/turn', {
    method: 'POST',
    body: JSON.stringify({ body: 'Synthetic turn' }),
  }), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});
