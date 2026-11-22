import { parse as parseYaml } from 'yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = () => parseYaml(readFileSync(new URL('../.github/workflows/staging-e2e.yml', import.meta.url), 'utf8'));

test('signed-in staging runs only on manual dispatch with the staging environment secret', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(Object.keys(events).sort(), ['workflow_dispatch']);
  assert.equal(document.permissions.contents, 'read');
  const job = document.jobs.staging;
  assert.equal(job.environment, 'staging');
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
  const run = job.steps.find(step => step.run?.includes('playwright test'));
  assert.match(run.run, /--project=chromium/);
  assert.match(run.run, /--retries=1/);
  assert.equal(run.env.ENGINE_STORAGE_STATE, '${{ secrets.E2E_ENGINE_STORAGE_STATE }}');
  assert.equal(run.env.E2E_ENGINE_STORAGE_STATE, 'playwright/.auth/engine.json');
  assert.equal(run['continue-on-error'], undefined);
  assert.ok(job.steps.some(step => step.if?.includes('!cancelled()') && step.run?.includes('staging-summary.mjs')));
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(upload.if, /failure\(\)/);
  assert.equal(upload.with['include-hidden-files'], true);
  assert.match(upload.with.path, /playwright-report/);
  assert.match(upload.with.path, /\.e2e\/playwright/);
  assert.doesNotMatch(upload.with.path, /\.auth/);
});

test('staging journeys use the staging engine jobs credentials', () => {
  const run = workflow().jobs.staging.steps.find(step => step.id === 'playwright');
  assert.equal(run.env.E2E_ENGINE_JOBS_CLIENT_ID, '${{ secrets.E2E_ENGINE_JOBS_CLIENT_ID }}');
  assert.equal(run.env.E2E_ENGINE_JOBS_CLIENT_SECRET, '${{ secrets.E2E_ENGINE_JOBS_CLIENT_SECRET }}');
  assert.equal(run.env.NEON_API_KEY, undefined);
});

test('staging deploys the tested commit before signed-in journeys and keeps the deploy secret out of build steps', () => {
  const document = workflow();
  const job = document.jobs.staging;
  assert.equal(document.concurrency.group, 'signed-in-staging');
  assert.equal(document.concurrency['cancel-in-progress'], true);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  const build = job.steps.findIndex(step => step.run === 'npm run build');
  const deploy = job.steps.findIndex(step => step.run?.includes('npm run release:staging'));
  const readback = job.steps.findIndex(step => step.run?.includes('scripts/verify-app-release.mjs'));
  const journeys = job.steps.findIndex(step => step.id === 'playwright');
  assert.ok(build >= 0 && build < deploy && deploy < readback && readback < journeys);
  assert.equal(job.steps[build].env.DOCTORCRE_SOURCE_COMMIT, '${{ github.sha }}');
  assert.match(job.steps[deploy].run, /--source-sha "\$SOURCE_COMMIT"/);
  assert.equal(job.steps[deploy].env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  for (const [index, step] of job.steps.entries()) {
    if (index !== deploy) assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
  }
});
