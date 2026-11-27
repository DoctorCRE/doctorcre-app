import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";

const server = await startFixtureServer();
test.after(() => server.stop());

const actionNames = ["New deal", "Ask Doc", "Go to Calendar", "Go to Home"] as const;

async function optionLabels(switcher: import("playwright").Locator) {
  return switcher
    .getByRole("option")
    .evaluateAll((options) => options.map((option) => (option.textContent ?? "").replace(/\s+/g, " ").trim()));
}

async function readyResults(switcher: import("playwright").Locator) {
  await switcher
    .getByRole("status")
    .filter({ hasText: /result/ })
    .waitFor();
}

async function activeLabel(switcher: import("playwright").Locator, input: import("playwright").Locator) {
  const id = await input.getAttribute("aria-activedescendant");
  if (!id) return "";
  return switcher.locator(`#${id}`).evaluate((option) => (option.textContent ?? "").replace(/\s+/g, " ").trim());
}

async function highlightOption(
  input: import("playwright").Locator,
  switcher: import("playwright").Locator,
  name: string,
) {
  await readyResults(switcher);
  await switcher.getByRole("option", { name, exact: true }).waitFor();
  const count = await switcher.getByRole("option").count();
  for (let step = 0; step < count; step++) {
    if ((await activeLabel(switcher, input)) === name) return;
    await input.press("ArrowDown");
  }
  assert.equal(await activeLabel(switcher, input), name);
}

async function openSwitcher(page: import("playwright").Page) {
  await page.getByRole("button", { name: "Quick switcher" }).click();
  const switcher = page.getByRole("dialog", { name: "Quick switcher" });
  await switcher.getByRole("combobox", { name: "Jump to" }).waitFor();
  return switcher;
}

for (const theme of ["light", "dark"] as const) {
  test(`the empty switcher lists the Actions group in ${theme} mode`, async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.addInitScript((theme) => {
        localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
      }, theme);
      await page.goto(server.url);
      const switcher = await openSwitcher(page);
      await switcher.getByRole("heading", { name: "Actions", exact: true }).waitFor();
      await readyResults(switcher);
      const names = await optionLabels(switcher);
      const mode = theme === "dark" ? "Light mode" : "Dark mode";
      const start = names.indexOf("New deal");
      assert.ok(start >= 0, "New deal is listed");
      assert.deepEqual(names.slice(start), [...actionNames, mode]);
      for (const name of [...actionNames, mode]) {
        assert.equal(await switcher.getByRole("option", { name, exact: true }).count(), 1);
      }
    } finally {
      await browser.close();
    }
  });
}

test('typing "cal" shows Go to Calendar after matching records', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "doctorcre.visual-preferences",
        JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
      );
    });
    await page.goto(server.url);
    const switcher = await openSwitcher(page);
    const input = switcher.getByRole("combobox", { name: "Jump to" });
    await input.fill("cal");
    await switcher.getByRole("option", { name: "Go to Calendar", exact: true }).waitFor();
    await readyResults(switcher);
    const names = await optionLabels(switcher);
    const actionAt = names.indexOf("Go to Calendar");
    const recordAt = names.findIndex((name) => name !== "Go to Calendar" && /cal/i.test(name));
    assert.ok(actionAt >= 0, `Go to Calendar missing from ${JSON.stringify(names)}`);
    assert.ok(recordAt >= 0, "a calendar record also matches");
    assert.ok(recordAt < actionAt, "records stay first when both match");
    assert.equal(await switcher.getByRole("heading", { name: "Actions", exact: true }).count(), 1);
  } finally {
    await browser.close();
  }
});

test("Enter on Go to Calendar opens /calendar", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "doctorcre.visual-preferences",
        JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
      );
    });
    await page.goto(server.url);
    const switcher = await openSwitcher(page);
    const input = switcher.getByRole("combobox", { name: "Jump to" });
    await input.fill("cal");
    await highlightOption(input, switcher, "Go to Calendar");
    await input.press("Enter");
    await page.waitForURL("**/calendar");
    assert.match(new URL(page.url()).pathname, /^\/calendar$/);
  } finally {
    await browser.close();
  }
});

test("the mode action flips the theme without a reload", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "doctorcre.visual-preferences",
        JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
      );
    });
    await page.goto(server.url);
    await page.locator("html[data-theme=light]").waitFor();
    const switcher = await openSwitcher(page);
    const input = switcher.getByRole("combobox", { name: "Jump to" });
    await switcher.getByRole("option", { name: "Dark mode", exact: true }).waitFor();
    await page.evaluate(() => {
      Reflect.set(window, "__switcherThemeMarker", "kept");
    });
    await input.fill("dark mode");
    await switcher.getByRole("option", { name: "Dark mode", exact: true }).waitFor();
    await readyResults(switcher);
    assert.equal(await switcher.getByRole("option").count(), 1);
    await input.press("Enter");
    await switcher.waitFor({ state: "detached" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.evaluate(() => Reflect.get(window, "__switcherThemeMarker")), "kept");
    assert.match(new URL(page.url()).pathname, /^\/$/);
  } finally {
    await browser.close();
  }
});
