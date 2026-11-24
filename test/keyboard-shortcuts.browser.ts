import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";

const captures = "out/test-artifacts/keyboard-shortcuts";
const server = await (await createQaServer()).start();
const browser = await chromium.launch();
test.after(async () => {
  await browser.close();
  await server.close();
});

type Open = { width?: number; theme?: "light" | "dark" };
async function open(t: TestContext, path: string, { width = 1280, theme = "light" }: Open = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await page.addInitScript((theme) => {
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } }),
    );
  }, theme);
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: `shortcuts-${width}-${theme}`, viewer: "joe", reset: true },
  });
  await page.goto(`${server.origin}${path}`);
  await page.locator(".quick-switcher-toggle").waitFor();
  return page;
}

const pathOf = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};
const helpDialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const switcher = (page: Page) => page.getByRole("dialog", { name: "Quick switcher" });

async function stays(page: Page, path: string) {
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await page.waitForTimeout(400);
  assert.deepEqual(navigations, []);
  assert.equal(pathOf(page), path);
}

for (const [key, from, to] of [
  ["h", "/leads", "/"],
  ["d", "/", "/deals"],
  ["l", "/", "/leads"],
  ["v", "/", "/vendors"],
] as const)
  test(`g ${key} goes from ${from} to ${to}`, async (t) => {
    const page = await open(t, from);
    await page.keyboard.press("g");
    await page.keyboard.press(key);
    await page.waitForURL((url) => url.origin === server.origin && url.pathname === to);
  });

test("g x h and a timed-out g do not navigate", async (t) => {
  const page = await open(t, "/leads");
  await page.keyboard.press("g");
  await page.keyboard.press("x");
  await page.keyboard.press("h");
  await stays(page, "/leads");
  await page.keyboard.press("g");
  await page.waitForTimeout(1100);
  await page.keyboard.press("h");
  await stays(page, "/leads");
});

test("'/' on Home opens the quick switcher", async (t) => {
  const page = await open(t, "/");
  await page.keyboard.press("/");
  const jump = switcher(page).getByRole("combobox", { name: "Jump to" });
  await jump.waitFor();
  assert.equal(await jump.evaluate((node) => node === document.activeElement), true);
  assert.equal(await jump.inputValue(), "");
});

test("'/' on the national accounts page focuses its search", async (t) => {
  const page = await open(t, "/deals?view=national");
  await page.locator("#accountGrid [data-account]").first().waitFor();
  await page.keyboard.press("/");
  assert.equal(await page.locator("#search").evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.locator("#search").inputValue(), "");
  assert.equal(await switcher(page).count(), 0);
});

async function contrast(page: Page): Promise<number> {
  return helpDialog(page).evaluate((dialog) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("no canvas");
    const luminance = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = Array.from(context.getImageData(0, 0, 1, 1).data).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(dialog);
    const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  });
}

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`'?' lists shortcuts at ${width}px in ${theme} and Escape restores focus`, async (t) => {
      const page = await open(t, "/", { width, theme });
      await page.keyboard.press("?");
      const dialog = helpDialog(page);
      await dialog.waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await dialog.getByRole("heading", { level: 2, name: "Keyboard shortcuts" }).isVisible(), true);
      const rows = dialog.getByRole("row");
      assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.textContent)), [
        "g then hGo to Home",
        "g then dGo to Deals",
        "g then lGo to Leads",
        "g then vGo to Vendors",
        "/Search this page, or open the quick switcher",
        "?Show keyboard shortcuts",
        "⌘/Ctrl + Alt + KOpen the quick switcher",
      ]);
      assert.equal(await dialog.locator("tr td:first-child kbd").first().textContent(), "g");
      assert.equal(await dialog.evaluate((node) => node.matches(":modal")), true);
      assert.ok((await contrast(page)) >= 4.5, "help text is readable against its surface");
      assert.equal(
        await dialog.evaluate(
          (node) => node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      await mkdir(captures, { recursive: true });
      await page.screenshot({ path: `${captures}/help-${width}-${theme}.png` });
      await page.keyboard.press("?");
      assert.equal(await page.locator("dialog.keyboard-shortcuts").count(), 1);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.locator("dialog.keyboard-shortcuts").count(), 0);
      assert.equal(
        await page.locator(".quick-switcher-toggle").evaluate((node) => node === document.activeElement),
        true,
        "focus falls back to the Search toggle when nothing was focused",
      );
    });

test("closing the shortcut list returns focus to the element that had it", async (t) => {
  const page = await open(t, "/");
  const home = page.getByRole("navigation", { name: "Primary navigation" }).locator(":scope > a").first();
  await home.focus();
  await page.keyboard.press("?");
  await helpDialog(page).getByRole("button", { name: "Close keyboard shortcuts" }).click();
  await helpDialog(page).waitFor({ state: "detached" });
  assert.equal(await home.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("?");
  await page.keyboard.press("Escape");
  await helpDialog(page).waitFor({ state: "detached" });
  assert.equal(await home.evaluate((node) => node === document.activeElement), true);
});

test("typing in a field never fires a shortcut", async (t) => {
  const page = await open(t, "/leads");
  const field = page.locator("#leadSearch");
  await field.focus();
  await page.keyboard.type("gd/?");
  assert.equal(await field.inputValue(), "gd/?");
  await stays(page, "/leads");
  assert.equal(await page.locator("dialog[open]").count(), 0);

  await page.evaluate(() => {
    const note = document.createElement("div");
    note.id = "shortcutNote";
    note.contentEditable = "true";
    note.textContent = "";
    document.body.append(note);
  });
  const note = page.locator("#shortcutNote");
  await note.focus();
  await page.keyboard.type("gd/?");
  assert.equal(await note.textContent(), "gd/?");
  await stays(page, "/leads");
  assert.equal(await page.locator("dialog[open]").count(), 0);
});

test("composing and Ctrl+'/' are not handled", async (t) => {
  const page = await open(t, "/");
  const prevented = await page.evaluate(() =>
    [
      { key: "/", isComposing: true },
      { key: "/", keyCode: 229 },
      { key: "/", ctrlKey: true },
      { key: "?", shiftKey: true, isComposing: true },
    ].map((init) => {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  assert.deepEqual(prevented, [false, false, false, false]);
  await page.waitForTimeout(200);
  assert.equal(await page.locator("dialog[open]").count(), 0);
});

const endSession = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));

test("a pending g does not survive the end of the session", async (t) => {
  const page = await open(t, "/");
  await page.keyboard.press("g");
  await endSession(page);
  await page.keyboard.press("d");
  await stays(page, "/");
});

test("no shortcut fires after the session ends", async (t) => {
  const page = await open(t, "/");
  await page.keyboard.press("?");
  await helpDialog(page).waitFor();
  await endSession(page);
  assert.equal(await page.locator("dialog.keyboard-shortcuts").count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector("dialog:modal") === null), true);
  const prevented = await page.evaluate(() =>
    ["/", "?"].map((key) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  assert.deepEqual(prevented, [false, false]);
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await stays(page, "/");
  assert.equal(await page.locator("dialog[open]").count(), 0);
});
