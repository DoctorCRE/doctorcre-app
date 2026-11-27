import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";

const server = await startFixtureServer();
test.after(() => server.stop());

const actionNames = ["New deal", "Ask Doc"] as const;

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
      await switcher.getByRole("group", { name: "Actions", exact: true }).waitFor();
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

test("typing Calendar shows the page once, with no action beside it", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.goto(server.url);
    const switcher = await openSwitcher(page);
    await switcher.getByRole("combobox", { name: "Jump to" }).fill("Calendar");
    await readyResults(switcher);
    assert.equal(await switcher.getByRole("option", { name: /Calendar/ }).count(), 1);
    assert.equal(await switcher.getByRole("group", { name: "Actions", exact: true }).count(), 0);
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

const addDealFlag = "doctorcre.quick-switcher.open-add-deal";

async function seenPreferences(page: import("playwright").Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
    );
  });
}

async function axeViolations(page: import("playwright").Page) {
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const ids: string[] = await page.evaluate(
    "axe.run(document).then((result) => result.violations.map((violation) => violation.id))",
  );
  return ids;
}

test("the switcher passes axe with the Actions group shown and with no matches", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.goto(server.url);
    const switcher = await openSwitcher(page);
    await switcher.getByRole("group", { name: "Actions", exact: true }).waitFor();
    await readyResults(switcher);
    assert.deepEqual(await axeViolations(page), [], "actions shown");
    await switcher.getByRole("combobox", { name: "Jump to" }).fill("zzzzqqqq");
    await switcher.getByText("No matches. Try a deal, contact or page name.").waitFor();
    assert.deepEqual(await axeViolations(page), [], "empty state");
  } finally {
    await browser.close();
  }
});

async function chooseNewDeal(page: import("playwright").Page) {
  const switcher = await openSwitcher(page);
  const input = switcher.getByRole("combobox", { name: "Jump to" });
  await input.fill("new deal");
  await highlightOption(input, switcher, "New deal");
  await input.press("Enter");
}

test("New deal on /deals opens Add deal at once", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.goto(`${server.url}/deals`);
    await page.locator("#addDealOpen").waitFor();
    await chooseNewDeal(page);
    await page.locator("#addDealDialog[open]").waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), addDealFlag), null);
  } finally {
    await browser.close();
  }
});

test("New deal from Home opens Add deal once, and reload or Back does not reopen it", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.goto(server.url);
    await chooseNewDeal(page);
    await page.waitForURL("**/deals");
    await page.locator("#addDealDialog[open]").waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), addDealFlag), null);
    await page.reload();
    await page.locator("#addDealOpen").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#addDealDialog[open]").count(), 0, "reload does not reopen");
    await page.goBack();
    await page.goForward();
    await page.locator("#addDealOpen").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#addDealDialog[open]").count(), 0, "Back and forward do not reopen");
  } finally {
    await browser.close();
  }
});

test("a request left in storage is cleared by boot even when the board never loads", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.route("**/board-seed.json", (route) => route.abort());
    await page.addInitScript((key) => sessionStorage.setItem(key, "1"), addDealFlag);
    await page.goto(`${server.url}/deals`);
    await page.locator("#addDealOpen").waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), addDealFlag), null);
  } finally {
    await browser.close();
  }
});

test("a signed-out session drops a pending New deal request", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await seenPreferences(page);
    await page.goto(server.url);
    const switcher = await openSwitcher(page);
    const input = switcher.getByRole("combobox", { name: "Jump to" });
    await highlightOption(input, switcher, "New deal");
    await page.evaluate((key) => {
      sessionStorage.setItem(key, "1");
      window.dispatchEvent(new Event("doctorcre-session-invalidated"));
    }, addDealFlag);
    await switcher.waitFor({ state: "detached" });
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), addDealFlag), null);
  } finally {
    await browser.close();
  }
});
