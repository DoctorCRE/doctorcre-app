import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';
test('F06 optional business HTTP read preserves authorization status', async () => {
  const client = createLiveClient({fetchImpl:async () => new Response('{}',{status:401})});
  await assert.rejects(client.getPartyRecord({dataset:'clients',id:'demo'}),{status:401});
});
