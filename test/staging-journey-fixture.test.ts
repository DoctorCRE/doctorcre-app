import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { withJourneyFixture } from "../tests/staging/journey-fixture.ts";

const env = {
  E2E_ENGINE_JOBS_CLIENT_ID: "test-id",
  E2E_ENGINE_JOBS_CLIENT_SECRET: "test-secret",
};
const id = (n: number) => `01000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prepared = {
  deal_id: id(1),
  deal_name: "Example deal",
  home_item_id: `next_action:${id(2)}`,
  next_step_id: id(2),
  tour_id: id(3),
  property_id: id(4),
  notes: ["First note", "Second note"],
};

type Reply = (runId: string) => Response;
type Call = { url: string; action: string | undefined; run_id: string; request: RequestInit };

function engine({ prepare, cleanup }: { prepare?: Reply; cleanup?: Reply } = {}) {
  const calls: Call[] = [];
  async function fetch(url: string, request: RequestInit) {
    const action = new URL(url).pathname.split("/").at(-1);
    assert.ok(typeof request.body === "string");
    const body: unknown = JSON.parse(request.body);
    assert.ok(typeof body === "object" && body !== null && "run_id" in body && typeof body.run_id === "string");
    const { run_id } = body;
    calls.push({ url: String(url), action, run_id, request });
    if (action === "prepare")
      return prepare ? prepare(run_id) : Response.json({ ...prepared, run_id }, { status: 201 });
    return cleanup ? cleanup(run_id) : Response.json({ run_id, remaining: 0 });
  }
  return { calls, fetch, env };
}

test("passes an engine fixture to the journey and cleans up that run", async () => {
  const jobs = engine();
  const answer = await withJourneyFixture((fixture) => {
    assert.equal(fixture.deal_id, prepared.deal_id);
    assert.equal(fixture.home_item_id, prepared.home_item_id);
    assert.deepEqual(fixture.notes, prepared.notes);
    return "journey complete";
  }, jobs);
  assert.equal(answer, "journey complete");
  assert.deepEqual(
    jobs.calls.map((call) => call.action),
    ["prepare", "cleanup"],
  );
  const [prepare, cleanup] = jobs.calls;
  assert.ok(prepare && cleanup);
  assert.match(prepare.run_id, /^[0-9a-f-]{36}$/);
  assert.equal(cleanup.run_id, prepare.run_id);
  for (const { url, action, request } of jobs.calls) {
    assert.equal(
      url,
      `https://doctorcre-engine-staging.joe-bookout-carr-us.workers.dev/jobs/sign-in-rehearsal/${action}`,
    );
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    const headers = new Headers(request.headers);
    assert.equal(headers.get("CF-Access-Client-Id"), env.E2E_ENGINE_JOBS_CLIENT_ID);
    assert.equal(headers.get("CF-Access-Client-Secret"), env.E2E_ENGINE_JOBS_CLIENT_SECRET);
    assert.equal(headers.get("Engine-Job"), "sign-in-rehearsal");
    assert.equal(headers.get("Engine-For-User"), action === "prepare" ? "joe" : null);
  }
});

test("missing staging credentials prevent a request", async () => {
  await assert.rejects(
    withJourneyFixture(() => assert.fail(), { env: {}, fetch: () => assert.fail() }),
    /E2E_ENGINE_JOBS_CLIENT_ID/,
  );
});

test("cleanup repeats the same run when its response is lost and preserves the browser failure", async () => {
  let cleanups = 0;
  const jobs = engine({
    cleanup(run_id) {
      if (++cleanups === 1) throw new Error("Lost cleanup response");
      return Response.json({ run_id, remaining: 0 });
    },
  });
  const failure = new Error("Browser assertion");
  await assert.rejects(
    withJourneyFixture(() => {
      throw failure;
    }, jobs),
    (error) => error === failure,
  );
  assert.deepEqual(
    jobs.calls.map((call) => call.action),
    ["prepare", "cleanup", "cleanup"],
  );
  assert.equal(new Set(jobs.calls.map((call) => call.run_id)).size, 1);
});

test("a lost prepare response still triggers cleanup before the test fails", async () => {
  const jobs = engine({
    prepare() {
      throw new Error("Lost prepare response");
    },
  });
  await assert.rejects(
    withJourneyFixture(() => assert.fail(), jobs),
    /prepare request failed/,
  );
  assert.deepEqual(
    jobs.calls.map((call) => call.action),
    ["prepare", "cleanup"],
  );
});

test("a mismatched prepare response never reaches the journey", async () => {
  const jobs = engine({ prepare: () => Response.json({ ...prepared, run_id: id(5) }, { status: 201 }) });
  await assert.rejects(
    withJourneyFixture(() => assert.fail(), jobs),
    /Invalid prepare response/,
  );
  assert.deepEqual(
    jobs.calls.map((call) => call.action),
    ["prepare", "cleanup"],
  );
});

test("unverified cleanup reports the run and the original journey failure", async () => {
  const jobs = engine({ cleanup: (run_id) => Response.json({ run_id, remaining: 1 }) });
  const failure = new Error("Browser assertion");
  await assert.rejects(
    withJourneyFixture(() => {
      throw failure;
    }, jobs),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.ok(error.message.includes(failure.message));
      const first = jobs.calls[0];
      assert.ok(first && error.message.includes(first.run_id));
      return true;
    },
  );
  assert.equal(jobs.calls.length, 4);
});

test("Playwright cleans the prepared run after the journey times out", (t) => {
  const scratch = temporaryDirectory("staging-fixture-timeout-", t);
  const calls = join(scratch, "calls.log");
  const spec = join(scratch, "timeout.spec.mjs");
  const config = join(scratch, "playwright.config.mjs");
  writeFileSync(config, 'export default {testDir: ".", outputDir: "./output", timeout: 500, reporter: "line"};');
  writeFileSync(
    spec,
    `
    import { appendFileSync } from "node:fs";
    import { journeyTest as test } from ${JSON.stringify(resolve("tests/staging/journey-fixture.ts"))};
    const options = {
      env: ${JSON.stringify(env)},
      fetch: async (url, request) => {
        const { run_id } = JSON.parse(request.body);
        const action = new URL(url).pathname.split("/").at(-1);
        appendFileSync(${JSON.stringify(calls)}, action + " " + run_id + "\\n");
        return action === "prepare"
          ? Response.json({ ...${JSON.stringify(prepared)}, run_id }, { status: 201 })
          : Response.json({ run_id, remaining: 0 });
      },
    };
    test.use({ journeyFixtureOptions: options });
    test("stalled journey", async ({ rehearsal }) => {
      if (!rehearsal.deal_id) throw new Error("fixture unavailable");
      await new Promise(() => {});
    });
  `,
  );
  const cli = resolve("node_modules/@playwright/test/cli.js");
  const result = spawnSync(process.execPath, [cli, "test", "--config", config], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Test timeout of 500ms exceeded/);
  const actions = readFileSync(calls, "utf8").trim().split("\n");
  const [prepare = ""] = actions;
  assert.ok(prepare.startsWith("prepare "));
  assert.deepEqual(actions, [prepare, `cleanup ${prepare.slice("prepare ".length)}`]);
});
