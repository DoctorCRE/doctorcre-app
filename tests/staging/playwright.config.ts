import { defineConfig, devices } from "@playwright/test";
import base from "../../playwright.config.ts";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "**/signed-in.spec.ts",
  outputDir: "../../.e2e/playwright-engine",
  // Playwright reports can retain request headers from a failed test step.
  globalSetup: "./engine.global-setup.ts",
  projects: [
    {
      name: "staging-engine",
      use: {
        ...devices["Desktop Chrome"],
        storageState: process.env.E2E_ENGINE_STORAGE_STATE,
        trace: "off",
      },
    },
  ],
});
