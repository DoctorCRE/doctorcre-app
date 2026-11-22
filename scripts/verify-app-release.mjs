import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function verifyAppRelease(url, sourceCommit, environment, { fetchRelease = fetch, pause = setTimeout, headers } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !['staging', 'production'].includes(environment)) {
    throw new Error('release verification requires a full source SHA and staging or production environment');
  }
  const staging = environment === 'staging';
  for (let attempt = 0; attempt < 12; attempt++) {
    let status;
    let release;
    try {
      const response = await fetchRelease(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        ...(staging && { headers, redirect: 'manual' }),
      });
      status = response.status;
      if (response.ok) release = await response.json();
    } catch {}
    if (staging && [302, 401, 403].includes(status)) throw new Error('Access refused the probe');
    if (release?.service === 'doctorcre-app' && release.source_commit === sourceCommit && release.environment === environment) {
      return Object.fromEntries(['source_commit', 'environment', 'provider_version_id'].map(key => [key, release[key]]));
    }
    if (attempt < 11) await pause(5000);
  }
  throw new Error(`release endpoint did not serve the expected ${environment} source ${sourceCommit} after 12 reads`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: verify-app-release.mjs <release-url> <source-sha> <environment>');
    const [url, sourceCommit, environment] = process.argv.slice(2);
    const staging = environment === 'staging';
    let headers;
    if (staging) {
      const accessHeaders = {
        E2E_STAGING_ACCESS_CLIENT_ID: 'CF-Access-Client-Id',
        E2E_STAGING_ACCESS_CLIENT_SECRET: 'CF-Access-Client-Secret',
      };
      const missing = Object.keys(accessHeaders).filter(name => !process.env[name]?.trim());
      if (missing.length) throw new Error(`Missing staging Access credentials: ${missing.join(', ')}`);
      headers = Object.fromEntries(Object.entries(accessHeaders).map(([name, header]) => [header, process.env[name]]));
    }
    const release = await verifyAppRelease(url, sourceCommit, environment, { headers });
    console.log(JSON.stringify(staging ? { source_commit: sourceCommit, environment } : release));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
