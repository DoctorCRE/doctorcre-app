import assert from "node:assert/strict";
import test from "node:test";
import { requireStagingEngineSession } from "../tests/staging/engine-session.ts";

const storageState = "private-staging-state.json";
const baseURL = "https://staging.example.invalid";

function session(status: number, mode: string, slug: string) {
  return async () => ({
    get: async () => ({
      status: () => status,
      headers: () => ({ "x-doctorcre-partner-sign-in": mode }),
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
