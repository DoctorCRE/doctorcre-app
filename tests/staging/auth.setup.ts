import { expect, request as requestFactory, test as setup } from "@playwright/test";
import { z } from "zod";
import { stagingStateLoadError } from "./engine-session.ts";

const partner = z.object({ actor: z.object({ slug: z.literal("joe") }) });
const rollbackPartner = partner.extend({ e2e_principal: z.literal("e2e-joe") });
const statePath = "playwright/.auth/staging.json";

setup("authenticate the staging test account", async ({ baseURL, request }) => {
  const storageState = process.env.E2E_ENGINE_STORAGE_STATE;
  if (storageState) {
    if (!baseURL) throw new Error("The staging project requires a staging base URL.");
    const engine = await requestFactory.newContext({ baseURL, storageState }).catch(() => {
      throw stagingStateLoadError();
    });
    try {
      const session = await engine.get("/auth/session", { maxRedirects: 0 });
      expect(session.status()).toBe(200);
      expect(session.headers()["x-doctorcre-partner-sign-in"]).toBe("engine");
      expect(partner.safeParse(await session.json()).success).toBe(true);
      await engine.storageState({ path: statePath });
    } finally {
      await engine.dispose();
    }
    return;
  }
  const secret = process.env.E2E_SESSION_SECRET;
  if (!secret) throw new Error("E2E_SESSION_SECRET must be provided through the environment");

  const response = await request.post("/auth/e2e-session", {
    headers: { authorization: `Bearer ${secret}` },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);

  const session = await request.get("/auth/session");
  expect(session.status()).toBe(200);
  expect(rollbackPartner.safeParse(await session.json()).success).toBe(true);
  await request.storageState({ path: statePath });
});
