import { defineConfig, devices } from "@playwright/test";
import base from "../../playwright.config.ts";
import { stagingEngineProject } from "./engine-session.ts";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "**/signed-in.spec.ts",
  outputDir: "../../.e2e/playwright-engine",
  // Playwright reports can retain request headers from a failed test step.
  globalSetup: "./engine.global-setup.ts",
  projects: [
    {
      name: stagingEngineProject,
      use: {
        ...devices["Desktop Chrome"],
        trace: "off",
      },
    },
  ],
});
