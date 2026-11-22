import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFixture } from '../scripts/fixture-http.mjs';
import { verifyAppRelease } from '../scripts/verify-app-release.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const identity = { service: 'doctorcre-app', source_commit: sha, environment: 'staging', provider_version_id: 'synthetic-version' };

test('release readback waits for the exact deployed source and environment', async () => {
  const replies = [new Error('not yet reachable'), { ...identity, source_commit: 'f'.repeat(40) }, identity];
  const pauses = [];
  const result = await verifyAppRelease('https://staging.example/app-release', sha, 'staging', {
    fetchRelease: async (url, options) => {
      assert.equal(url, 'https://staging.example/app-release');
      assert.equal(options.cache, 'no-store');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return Response.json(reply);
    },
    pause: async milliseconds => pauses.push(milliseconds),
  });
  assert.deepEqual(result, { source_commit: sha, environment: 'staging', provider_version_id: 'synthetic-version' });
  assert.deepEqual(pauses, [5000, 5000]);
});

test('release readback refuses wrong source, wrong environment and malformed responses after the bounded reads', async () => {
  for (const reply of [{ ...identity, source_commit: 'f'.repeat(40) }, { ...identity, environment: 'production' }, {}]) {
    let reads = 0;
    await assert.rejects(verifyAppRelease('https://staging.example/app-release', sha, 'staging', {
      fetchRelease: async () => { reads++; return Response.json(reply); },
      pause: async () => {},
    }), /did not serve the expected staging source/);
    assert.equal(reads, 12);
  }
});

const run = promisify(execFile);
const probe = fileURLToPath(new URL('../scripts/verify-app-release.mjs', import.meta.url));
const accessEnv = {
  E2E_STAGING_ACCESS_CLIENT_ID: 'synthetic-access-id',
  E2E_STAGING_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
};

const releasePath = '/release';
const releaseResponse = release => ({ contentType: 'application/json', body: JSON.stringify(release) });

async function serveRelease(t, routes) {
  const fixture = await startFixture({ routes: new Map(routes) });
  t.after(fixture.close);
  return { fixture, url: fixture.origin + releasePath };
}

function stagingProbe(url, credentials = accessEnv) {
  return run(process.execPath, [probe, url, sha, 'staging'], {
    env: { ...process.env, ...credentials },
    timeout: 5000,
  });
}

test('staging probe sends the service-token pair from its environment', async t => {
  const { fixture, url } = await serveRelease(t, [[releasePath, releaseResponse(identity)]]);
  const { stdout, stderr } = await stagingProbe(url);
  const received = fixture.requests.map(({ headers }) => [headers['cf-access-client-id'], headers['cf-access-client-secret']]);
  assert.deepEqual(received, [Object.values(accessEnv)]);
  assert.equal(JSON.parse(stdout).source_commit, sha);
  for (const value of Object.values(accessEnv)) assert.ok(!`${stdout}${stderr}`.includes(value));
});

test('staging probe refuses an Access redirect without visiting its destination or logging credentials', async t => {
  const { fixture, url } = await serveRelease(t, [
    [releasePath, { status: 302, headers: { location: '/login' }, body: Object.values(accessEnv).join(' ') }],
    ['/login', releaseResponse(identity)],
  ]);
  for (const credentials of [
    { E2E_STAGING_ACCESS_CLIENT_ID: '', E2E_STAGING_ACCESS_CLIENT_SECRET: '' },
    accessEnv,
  ]) {
    await assert.rejects(stagingProbe(url, credentials), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.trim(), 'Access refused the probe');
      return true;
    });
  }
  assert.deepEqual(fixture.requests.map(({ path }) => path), [releasePath, releasePath]);
});

test('staging probe reports Access authorization failures immediately', async t => {
  for (const status of [401, 403]) {
    const { url } = await serveRelease(t, [[releasePath, { status }]]);
    await assert.rejects(
      verifyAppRelease(url, sha, 'staging', { pause: () => assert.fail('unexpected retry after an Access refusal') }),
      { message: 'Access refused the probe' },
    );
  }
});

test('staging probe rejects an HTTP release response with the wrong SHA', async t => {
  const { url } = await serveRelease(t, [[releasePath, releaseResponse({ ...identity, source_commit: 'f'.repeat(40) })]]);
  await assert.rejects(verifyAppRelease(url, sha, 'staging', { pause: async () => {} }),
    /did not serve the expected staging source/);
});
