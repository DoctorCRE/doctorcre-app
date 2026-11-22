import { type FullConfig, request } from "@playwright/test";
import { requireSafeStagingDiagnostics, requireStagingEngineSession } from "./engine-session.ts";

export default async function verifyEngineSession(config: FullConfig) {
  const project = config.projects[0];
  if (!project) throw new Error("The engine staging project is missing.");
  requireSafeStagingDiagnostics(project.use, config.argv);
  await requireStagingEngineSession({
    baseURL: project.use.baseURL,
    storageState: process.env.E2E_ENGINE_STORAGE_STATE,
    newContext: (options) => request.newContext(options),
  });
}
