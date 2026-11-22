import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);
export const fixtureProducerCommit = '517ecc12c0480d859dd1f4cb270f2a283a853065';
export const homeFixtureCommit = 'c53b791f15d07b4e2c64dfd4aac10f3b03277161';
async function produce(action, run, home = false) {
  const repo = process.env.CARR_JOURNEY_FIXTURE_REPO;
  if (!repo) throw new Error('CARR_JOURNEY_FIXTURE_REPO must name the pinned CARR checkout containing tools/staging-journey-fixtures.py');
  if (!process.env.NEON_API_KEY) throw new Error('NEON_API_KEY must be bound for the staging fixture producer');
  const source = await execute('git', ['-C', repo, 'rev-parse', 'HEAD']);
  const changed = await execute('git', ['-C', repo, 'status', '--porcelain', '--',
    'tools/staging-journey-fixtures.py', 'tools/staging-fixtures.py']);
  if (source.stdout.trim() !== fixtureProducerCommit || changed.stdout.trim()) {
    throw new Error(`CARR fixture producer requires clean commit ${fixtureProducerCommit}`);
  }
  let script = join(repo, 'tools/staging-journey-fixtures.py');
  if (home) {
    const homeRepo = process.env.CARR_HOME_FIXTURE_REPO;
    if (!homeRepo) throw new Error('CARR_HOME_FIXTURE_REPO must name the pinned CARR Home fixture checkout');
    const head = await execute('git', ['-C', homeRepo, 'rev-parse', 'HEAD']);
    const changed = await execute('git', ['-C', homeRepo, 'status', '--porcelain', '--', 'tools/staging-home-fixture.py']);
    if (head.stdout.trim() !== homeFixtureCommit || changed.stdout.trim()) throw new Error(`Home fixture requires clean commit ${homeFixtureCommit}`);
    script = join(homeRepo, 'tools/staging-home-fixture.py');
  }
  const { stdout } = await execute(join(repo, '.venv/bin/python'),
    [script, action, '--run', run],
    { timeout: 180000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(stdout);
  if (value.schema !== 'doctorcre-staging-journey-fixture.v1' || value.run !== run) {
    throw new Error('CARR fixture producer returned a mismatched run or contract');
  }
  return value;
}

export function withHomeFixture(body, producer = (action, run) => produce(action, run, true)) {
  return withJourneyFixture(body, producer);
}

async function cleanupJourney(producer, run) {
  let action = 'cleanup';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const state = await producer(action, run);
      if (state.remaining === 0) return;
      action = 'cleanup';
    } catch {
      action = 'remaining';
    }
  }
  throw new Error(`leftover fixture or unverified cleanup for synthetic run ${run}`);
}

export async function withJourneyFixture(body, producer = produce) {
  const run = randomUUID();
  let result, failure;
  try {
    const fixture = await producer('prepare', run);
    result = await body(fixture);
  } catch (error) {
    failure = error;
    failure.fixtureRun = run;
  }
  try {
    await cleanupJourney(producer, run);
  } catch (error) {
    if (!failure) failure = error;
    else {
      failure.message += `\n${error.message}`;
      failure.cleanupError = error;
    }
    failure.fixtureRun = run;
  }
  if (failure) throw failure;
  return result;
}
