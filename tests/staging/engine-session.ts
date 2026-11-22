import type { APIRequestContext, APIResponse, FullProject } from "@playwright/test";
import { z } from "zod";

const stagingIdentity = z.object({ actor: z.object({ slug: z.literal("joe") }) });

export const stagingEngineProject = "staging-engine";

type Diagnostics = Pick<FullProject["use"], "trace" | "video" | "screenshot" | "contextOptions">;

export function requireSafeStagingDiagnostics(
  { trace, video, screenshot, contextOptions }: Diagnostics,
  args: readonly string[] = [],
) {
  const records = [trace, video, screenshot].some((option) => option !== undefined && option !== "off");
  if (records || contextOptions?.recordHar || contextOptions?.recordVideo) {
    throw new Error("Turn off Playwright trace, video, and screenshots for the engine staging smoke.");
  }
  const playwrightDebug = process.env.DEBUG?.split(/[\s,]+/).some((scope) => /^(?:pw:|(?:p(?:w)?)?\*)/.test(scope));
  const inspector = process.env.PWDEBUG;
  const interactive = args.some((arg) => /^--(?:debug|ui(?:-host|-port)?)(?:=|$)/.test(arg));
  if (playwrightDebug || interactive || (inspector && inspector !== "0" && inspector !== "false")) {
    throw new Error("Turn off Playwright debug logging and interactive debugging for the engine staging smoke.");
  }
}

export function requireStagingStatePath(path: string | undefined) {
  if (!path?.trim()) throw new Error("E2E_ENGINE_STORAGE_STATE must point to an approved staging storage state file.");
  return path;
}

export function stagingStateLoadError() {
  return new Error("Could not load the staging storage state file from E2E_ENGINE_STORAGE_STATE.");
}

type SessionRequest = Pick<APIRequestContext, "dispose"> & {
  get: (...args: Parameters<APIRequestContext["get"]>) => Promise<Pick<APIResponse, "status" | "headers" | "json">>;
};

export async function requireStagingEngineSession({
  storageState,
  baseURL,
  newContext,
}: {
  storageState: string | undefined;
  baseURL: string | undefined;
  newContext: (options: { storageState: string; baseURL: string }) => Promise<SessionRequest>;
}) {
  const statePath = requireStagingStatePath(storageState);
  if (!baseURL) throw new Error("The engine staging project requires a staging base URL.");

  const request = await newContext({ storageState: statePath, baseURL }).catch(() => {
    throw stagingStateLoadError();
  });
  try {
    const response = await request
      .get("/auth/session", {
        headers: { accept: "application/json" },
        maxRedirects: 0,
        timeout: 10_000,
      })
      .catch(() => {
        throw new Error("Could not reach the staging session check.");
      });
    const status = response.status();
    const mode = response.headers()["x-doctorcre-partner-sign-in"];
    if (status === 401) {
      if (mode !== "engine") throw new Error("Staging is in CARR mode (rollback).");
      throw new Error("The staging engine session is missing or expired. Supply fresh staging storage state.");
    }
    if (status !== 200) throw new Error(`The staging session check returned HTTP ${status}.`);
    if (mode !== "engine") throw new Error("The staging session check expected engine sign-in.");
    const identity: unknown = await response.json().catch(() => undefined);
    if (!stagingIdentity.safeParse(identity).success)
      throw new Error("The engine session does not identify the expected staging actor (joe).");
  } finally {
    await request.dispose();
  }
}
