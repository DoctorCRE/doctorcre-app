import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { requireSafeStagingDiagnostics, requireStagingEngineSession } from "../tests/staging/engine-session.ts";

const storageState = "private-staging-state.json";
const baseURL = "https://staging.example.invalid";

function session(status: number, mode: string | undefined, slug: string) {
  return async () => ({
    get: async () => ({
      status: () => status,
      headers: () => {
        const headers: Record<string, string> = {};
        if (mode) headers["x-doctorcre-partner-sign-in"] = mode;
        return headers;
      },
      json: async () => ({ actor: { slug } }),
    }),
    dispose: async () => {},
  });
}

test("engine staging requires a storage state path before contacting the app", async () => {
  await assert.rejects(
    requireStagingEngineSession({
      storageState: undefined,
      baseURL,
      newContext: async () => assert.fail("contacted the app without a storage state"),
    }),
    /E2E_ENGINE_STORAGE_STATE.*must point to/,
  );
});

test("engine staging names the configuration when its state file cannot be loaded", async () => {
  await assert.rejects(
    requireStagingEngineSession({
      storageState,
      baseURL,
      newContext: async () => {
        throw new Error(`Failed to open ${storageState}`);
      },
    }),
    { message: "Could not load the staging storage state file from E2E_ENGINE_STORAGE_STATE." },
  );
});

test("engine staging refuses expired or revoked state", async () => {
  await assert.rejects(
    requireStagingEngineSession({ storageState, baseURL, newContext: session(401, "engine", "joe") }),
    /missing or expired/,
  );
});

test("engine staging identifies CARR rollback when a 401 lacks the engine marker", async () => {
  await assert.rejects(
    requireStagingEngineSession({ storageState, baseURL, newContext: session(401, undefined, "joe") }),
    /staging is in CARR mode \(rollback\)/i,
  );
});

test("engine staging refuses a session for a different actor", async () => {
  await assert.rejects(
    requireStagingEngineSession({
      storageState,
      baseURL,
      newContext: session(200, "engine", "another-actor"),
    }),
    /expected staging actor/,
  );
});

test("engine staging refuses legacy sign-in even for the expected actor", async () => {
  await assert.rejects(
    requireStagingEngineSession({ storageState, baseURL, newContext: session(200, "carr", "joe") }),
    /expected engine sign-in/,
  );
});

test("engine staging accepts the expected actor in engine mode", async () => {
  await requireStagingEngineSession({
    storageState,
    baseURL,
    newContext: session(200, "engine", "joe"),
  });
});

function runEngineSmoke(t: TestContext, args: string[] = [], debug = "") {
  const scratch = temporaryDirectory("staging-engine-check-", t);
  const privateStatePath = join(scratch, "unreadable-state.json");
  const cli = resolve("node_modules/@playwright/test/cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "--config=tests/staging/playwright.config.ts",
      "--project=staging-engine",
      "--reporter=json",
      "--output",
      join(scratch, "output"),
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEBUG: debug,
        PWDEBUG: "",
        PLAYWRIGHT_JSON_OUTPUT_FILE: "",
        PLAYWRIGHT_JSON_OUTPUT_DIR: "",
        PLAYWRIGHT_JSON_OUTPUT_NAME: "",
        E2E_ENGINE_STORAGE_STATE: privateStatePath,
      },
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 1, "the synthetic run must stop during setup");
  return { output: result.stdout + result.stderr, privateStatePath };
}

test("the JSON reporter omits the staging state path", (t) => {
  const { output, privateStatePath } = runEngineSmoke(t);
  assert.ok(output.includes("Could not load the staging storage state file from E2E_ENGINE_STORAGE_STATE."));
  assert.ok(!output.includes(privateStatePath), "the JSON report disclosed the state path");
});

test("the engine smoke rejects an explicit trace before opening the state file", (t) => {
  const { output } = runEngineSmoke(t, ["--trace=retain-on-failure"]);
  assert.ok(
    output.includes("Turn off Playwright trace, video, and screenshots"),
    "the trace override must be rejected",
  );
});

test("the engine smoke rejects Playwright debug logging before opening the state file", (t) => {
  for (const debug of ["other,pw:channel", "*"]) {
    const { output } = runEngineSmoke(t, [], debug);
    assert.ok(output.includes("Turn off Playwright debug logging"), "Playwright debug logging must be rejected");
  }
});

test("the engine smoke rejects browser debugger attachment before opening the state file", (t) => {
  const { output } = runEngineSmoke(t, ["--debug=cli"]);
  assert.ok(output.includes("Turn off Playwright debug"), "browser debugger attachment must be rejected");
});

test("engine staging refuses configured video, screenshots, and network recordings", () => {
  const refuse = (options: Parameters<typeof requireSafeStagingDiagnostics>[0]) =>
    assert.throws(() => requireSafeStagingDiagnostics(options), /Turn off Playwright trace, video, and screenshots/);
  refuse({ video: "retain-on-failure" });
  refuse({ screenshot: "only-on-failure" });
  refuse({ contextOptions: { recordHar: { path: "synthetic.har" } } });
  refuse({ contextOptions: { recordVideo: { dir: "synthetic-videos" } } });
});
