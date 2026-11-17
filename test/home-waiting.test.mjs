import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const fixtureBundle = await build({ entryPoints: ['src/ui/home/fixture.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { fixtureInboxRpc } = await import(`data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].contents).toString('base64')}`);
test('v5 unsupported falls back through every legacy version only for unknown_tool', async () => {
  for (const supported of ['v5', 'v4', 'v3', 'v2']) {
    const calls = []; const rpc = fixtureInboxRpc();
    const client = api.createInboxClient(async (name, args) => {
      calls.push(name);
      return name === `read-home-inbox-${supported}` ? rpc(name, args) : { error: 'unknown_tool' };
    });
    const snapshot = await client.read();
    assert.equal(snapshot.schema_version, `home-inbox.${supported}`);
    assert.deepEqual(calls, ['v5', 'v4', 'v3', 'v2'].slice(0, ['v5', 'v4', 'v3', 'v2'].indexOf(supported) + 1).map(v => `read-home-inbox-${v}`));
  }
});
test('malformed v5 waiting identity never falls back to a legacy read', async () => {
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v5', {});
  for (const fields of [{ waiting_version: undefined }, { waiting_on: undefined }, { waiting_version: -1 }]) {
    const calls = [];
    const client = api.createInboxClient(async name => { calls.push(name); return { ...snapshot, items: [{ ...snapshot.items[0], ...fields }] }; });
    await assert.rejects(client.read(), /Waiting/);
    assert.deepEqual(calls, ['read-home-inbox-v5']);
  }
});
test('pinned inbox contract uses the registered v5 read and matching fixture', async () => {
  const { readCarrInterface } = await import('../scripts/carr-interface.mjs');
  const contract = await readCarrInterface();
  assert.equal(contract.home_inbox_contract.read, 'read-home-inbox-v5');
  assert.equal(contract.home_inbox_contract.schema_version, 'home-inbox.v5');
  assert.ok(contract.mcp_operations.includes(contract.home_inbox_contract.read));
  const snapshot = await fixtureInboxRpc()(contract.home_inbox_contract.read, {});
  assert.equal(api.parseSnapshot(snapshot).schema_version, contract.home_inbox_contract.schema_version);
  assert.ok(snapshot.items.every(item => Number.isSafeInteger(item.waiting_version)));
});
