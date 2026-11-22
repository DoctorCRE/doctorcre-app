import { type FullConfig, request } from "@playwright/test";
import { requireStagingEngineSession } from "./engine-session.ts";

export default async function verifyEngineSession(config: FullConfig) {
  await requireStagingEngineSession({
    baseURL: config.projects[0]?.use.baseURL,
    storageState: process.env.E2E_ENGINE_STORAGE_STATE,
    newContext: (options) => request.newContext(options),
  });
}
