import { expect, request, test as setup } from "@playwright/test";
import { z } from "zod";
import { requireSafeStagingDiagnostics, stagingStateLoadError } from "./engine-session.ts";

const partner = z.object({ actor: z.object({ slug: z.literal("joe") }) });
const rollbackPartner = partner.extend({ e2e_principal: z.literal("e2e-joe") });

setup("authenticate the staging test account", async ({ baseURL }, testInfo) => {
  requireSafeStagingDiagnostics(testInfo.project.use, testInfo.config.argv);
  if (!baseURL) throw new Error("The staging project requires a staging base URL.");
  const storageState = process.env.E2E_ENGINE_STORAGE_STATE;
  const secret = process.env.E2E_SESSION_SECRET;
  if (!storageState && !secret) throw new Error("Set E2E_ENGINE_STORAGE_STATE or E2E_SESSION_SECRET.");
  const sessionRequest = await request.newContext({ baseURL, ...(storageState ? { storageState } : {}) }).catch(() => {
    throw stagingStateLoadError();
  });
  try {
    if (!storageState) {
      const response = await sessionRequest
        .post("/auth/e2e-session", {
          headers: { authorization: `Bearer ${secret}` },
          maxRedirects: 0,
        })
        .catch(() => {
          throw new Error("Could not reach the staging sign-in.");
        });
      expect(response.status()).toBe(200);
    }
    const session = await sessionRequest.get("/auth/session", { maxRedirects: 0 }).catch(() => {
      throw new Error("Could not reach the staging session check.");
    });
    expect(session.status()).toBe(200);
    if (storageState && session.headers()["x-doctorcre-partner-sign-in"] !== "engine")
      throw new Error("The staging session check expected engine sign-in.");
    const identity = storageState ? partner : rollbackPartner;
    expect(identity.safeParse(await session.json().catch(() => undefined)).success).toBe(true);
    await sessionRequest.storageState({ path: "playwright/.auth/staging.json" }).catch(() => {
      throw new Error("Could not save the staging session state.");
    });
  } finally {
    await sessionRequest.dispose();
  }
});
