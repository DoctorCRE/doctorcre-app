import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";

const captures = "out/test-artifacts/keyboard-shortcuts";
const server = await (await createQaServer()).start();
const browser = await chromium.launch();
test.after(async () => {
  await browser.close();
  await server.close();
});

type Open = { width?: number; theme?: "light" | "dark"; before?: (page: Page) => Promise<void> };
async function open(t: TestContext, path: string, { width = 1280, theme = "light", before }: Open = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await before?.(page);
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
  ["c", "/", "/calendar"],
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
        "g then cGo to Calendar",
        "g then vGo to Vendors",
        "/Search this page, or open the quick switcher",
        "?Show keyboard shortcuts",
        "⌘/Ctrl + KOpen search",
        "j or ↓Next card (Home, Deals)",
        "k or ↑Previous card (Home, Deals)",
        "EnterOpen the selected card",
        "EDone (Home)",
        "SSnooze (Home)",
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
      // The dialog leaves the accessibility tree before its close handler removes it.
      await page.locator("dialog.keyboard-shortcuts").waitFor({ state: "detached" });
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

test("? lists Go to Calendar", async (t) => {
  const page = await open(t, "/");
  await page.keyboard.press("?");
  const dialog = helpDialog(page);
  await dialog.waitFor();
  const rows = await dialog.getByRole("row").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.equal(rows.includes("g then cGo to Calendar"), true);
});

test("typing in a field never fires a shortcut", async (t) => {
  const page = await open(t, "/leads");
  const field = page.locator("#leadSearch");
  await field.focus();
  await page.keyboard.type("gd/?jk");
  assert.equal(await field.inputValue(), "gd/?jk");
  assert.equal(await field.evaluate((node) => node === document.activeElement), true);
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
  await page.keyboard.type("gd/?jk");
  assert.equal(await note.textContent(), "gd/?jk");
  assert.equal(await note.evaluate((node) => node === document.activeElement), true);
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

const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const isFocused = (locator: Locator) => locator.evaluate((node) => node === document.activeElement);

test("j and k move between Home cards without wrapping, and Enter opens the selected card", async (t) => {
  const page = await open(t, "/");
  const titles = page.locator("[data-inbox-row] h3 a:visible");
  await titles.first().waitFor();
  const names = await titles.allTextContents();
  assert.ok(names.length >= 2, "Home shows at least two cards");
  await page.keyboard.press("j");
  assert.equal(await focused(page), names[0]);
  await page.keyboard.press("j");
  assert.equal(await focused(page), names[1]);
  await page.keyboard.press("k");
  assert.equal(await focused(page), names[0]);
  await page.keyboard.press("k");
  assert.equal(await focused(page), names[0], "k on the first card stays");
  await stays(page, "/");

  const first = titles.first();
  assert.equal(await isFocused(first), true);
  const expanded = await first.getAttribute("aria-expanded");
  const href = await first.getAttribute("href");
  await page.keyboard.press("Enter");
  if (expanded === null) await page.waitForURL((url) => `${url.pathname}${url.search}` === href);
  else
    await page.waitForFunction((name) => {
      const link = Array.from(document.querySelectorAll("[data-inbox-row] h3 a")).find(
        (node) => node.textContent?.trim() === name,
      );
      return link?.getAttribute("aria-expanded") === "true";
    }, names[0]);
});

test("ArrowDown and ArrowUp move between Home cards without wrapping", async (t) => {
  const page = await open(t, "/");
  const titles = page.locator("[data-inbox-row] h3 a:visible");
  await titles.first().waitFor();
  const names = await titles.allTextContents();
  assert.ok(names.length >= 2, "Home shows at least two cards");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), names[0]);
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(page), names[1]);
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(page), names[0]);
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(page), names[0], "ArrowUp on the first card stays");
  await stays(page, "/");
});

test("ArrowDown and ArrowUp are ignored inside a focused text input", async (t) => {
  const page = await open(t, "/");
  await page.locator("[data-inbox-row] h3 a:visible").first().waitFor();
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "shortcutArrowField";
    field.type = "text";
    field.value = "sample";
    document.body.append(field);
  });
  const field = page.locator("#shortcutArrowField");
  await field.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  assert.equal(await field.evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-shortcut-card]"))), false);
  await stays(page, "/");
});

// Synthetic prospects only; no real records.
const prospectRows = ["Example Prospect Alder", "Example Prospect Beech"].map((name, index) => ({
  party_id: `00000000-0000-4000-8000-00000000010${index}`,
  name,
  how_found: "referral",
  owner: null,
  needs_attention: false,
  follow_ups: [],
  latest_note: null,
  change_id: index + 1,
}));

// The seeded board, with the Prospects lane turned on and fed synthetic rows.
async function withProspects(page: Page) {
  await page.route("**/mcp", async (route) => {
    const request = route.request();
    const call = request.method() === "POST" ? request.postDataJSON() : null;
    if (call?.params?.name !== "deal-room-board") return route.continue();
    const response = await route.fetch();
    const envelope = await response.json();
    const content = envelope?.result?.content?.[0];
    if (content?.type === "text")
      content.text = JSON.stringify({ ...JSON.parse(content.text), engine_prospects: true });
    return route.fulfill({ response, json: envelope });
  });
  await page.route("**/api/engine/prospects**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const row = prospectRows.find((prospect) => prospect.party_id === id);
    return route.fulfill({
      json: row ? { ...row, notes: [] } : { prospects: prospectRows, count: prospectRows.length },
    });
  });
}

// Visible board cards, column by column, as data-id lists (empty columns dropped).
const boardColumns = (page: Page) =>
  page.locator("#kanban > section.kanban-column[data-column]").evaluateAll((columns) =>
    columns
      .map((column) =>
        Array.from(column.querySelectorAll<HTMLElement>(".kanban-card"))
          .filter((card) => (card.querySelector(".card-open")?.getClientRects().length ?? 0) > 0)
          .map((card) => card.dataset.id ?? ""),
      )
      .filter((ids) => ids.length > 0),
  );

async function openBoard(t: TestContext) {
  const page = await open(t, "/deals?mode=live", { before: withProspects });
  await page
    .locator("#prospectsLane .card-open")
    .nth(prospectRows.length - 1)
    .waitFor();
  await page.locator("#kanban [data-column] .kanban-card").first().waitFor();
  return page;
}
const tileOpen = (page: Page, id: string) =>
  page.locator(`#kanban [data-column] .kanban-card[data-id="${id}"] .card-open`);

test("j and k walk the Prospects lane then each phase column, and Enter opens the deal", async (t) => {
  const page = await openBoard(t);
  const lane = page.locator("#prospectsLane .card-open");
  const columns = await boardColumns(page);
  assert.ok(columns.length >= 2, "the seeded board fills at least two phase columns");
  const [firstColumn = [], secondColumn = []] = columns;
  const lastId = columns.at(-1)?.at(-1) ?? "";
  const path = pathOf(page);

  await page.keyboard.press("j");
  assert.equal(await isFocused(lane.first()), true, "with nothing selected, j starts at the first card");
  await page.keyboard.press("j");
  assert.equal(await isFocused(lane.last()), true);
  await page.keyboard.press("j");
  assert.equal(await isFocused(tileOpen(page, firstColumn[0] ?? "")), true, "j leaves Prospects for the first phase");
  await page.keyboard.press("k");
  assert.equal(await isFocused(lane.last()), true);

  await tileOpen(page, firstColumn.at(-1) ?? "").focus();
  await page.keyboard.press("j");
  assert.equal(await isFocused(tileOpen(page, secondColumn[0] ?? "")), true, "j crosses into the next phase column");

  await tileOpen(page, lastId).focus();
  await page.keyboard.press("j");
  assert.equal(await isFocused(tileOpen(page, lastId)), true, "j on the last card stays");
  await stays(page, path);
  assert.equal(await page.locator('#kanban [data-lifted="true"]').count(), 0);

  const target = tileOpen(page, firstColumn[0] ?? "");
  const name = (await target.textContent())?.trim() ?? "";
  await target.focus();
  await page.keyboard.press("Enter");
  await page.locator("#main").waitFor({ state: "hidden" });
  await page.waitForFunction((name) => document.getElementById("panelTitle")?.textContent?.trim() === name, name);
  await page.keyboard.press("j");
  assert.equal(
    await page.evaluate(() => Boolean(document.activeElement?.closest("#kanban"))),
    false,
    "board cards behind the deal workspace are out of reach",
  );
});

test("j and k move between rows in the Deals list", async (t) => {
  const page = await openBoard(t);
  await page.locator("#listView").click();
  const rows = page.locator("#kanban .deal-row");
  await rows.nth(1).waitFor();
  const ids = await rows.evaluateAll((nodes) =>
    nodes
      .filter((node) => (node.querySelector(".card-open")?.getClientRects().length ?? 0) > 0)
      .map((node) => node.getAttribute("data-id") ?? ""),
  );
  const rowOpen = (id: string) => page.locator(`#kanban .deal-row[data-id="${id}"] .card-open`);
  await rowOpen(ids[0] ?? "").focus();
  await page.keyboard.press("j");
  assert.equal(await isFocused(rowOpen(ids[1] ?? "")), true);
  await page.keyboard.press("k");
  assert.equal(await isFocused(rowOpen(ids[0] ?? "")), true);
});

test("a lifted card keeps its lift and focus when j or k is pressed", async (t) => {
  const page = await openBoard(t);
  const [column = []] = await boardColumns(page);
  const card = page.locator(`#kanban [data-column] .kanban-card[data-id="${column[0] ?? ""}"]`);
  await card.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /lifted from/.test(document.getElementById("dragLive")?.textContent ?? ""));
  const announced = await page.locator("#dragLive").textContent();
  const target = await page.locator('#kanban [data-drop="true"]').getAttribute("data-column");
  for (const key of ["j", "k"]) {
    await page.keyboard.press(key);
    assert.equal(await isFocused(card), true, `${key} leaves focus on the lifted card`);
    assert.equal(await card.getAttribute("data-lifted"), "true");
    assert.equal(await page.locator('#kanban [data-drop="true"]').getAttribute("data-column"), target);
    assert.equal(await page.locator("#dragLive").textContent(), announced);
  }
  const openControl = card.locator("[data-shortcut-open]");
  await openControl.focus();
  await page.keyboard.press("j");
  assert.equal(await isFocused(openControl), true, "j leaves focus on the lifted card's own open control");
  assert.equal(await card.getAttribute("data-lifted"), "true");
  assert.equal(await page.locator('#kanban [data-drop="true"]').getAttribute("data-column"), target);
  await card.focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('#kanban [data-lifted="true"]').count(), 0);
});

test("ArrowDown and ArrowUp leave a lifted card's own open control alone", async (t) => {
  const page = await openBoard(t);
  const [column = []] = await boardColumns(page);
  const card = page.locator(`#kanban [data-column] .kanban-card[data-id="${column[0] ?? ""}"]`);
  await card.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /lifted from/.test(document.getElementById("dragLive")?.textContent ?? ""));
  const openControl = card.locator("[data-shortcut-open]");
  await openControl.focus();
  for (const key of ["ArrowDown", "ArrowUp"]) {
    await page.keyboard.press(key);
    assert.equal(await isFocused(openControl), true, `${key} leaves focus on the lifted card's open control`);
    assert.equal(await card.getAttribute("data-lifted"), "true");
  }
});

// A key press that bubbles from the focused control; true means something handled it.
const arrowsHandled = (control: Locator) =>
  control.evaluate((node) =>
    ["ArrowDown", "ArrowUp"].map((key) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );

async function keepsArrows(control: Locator, name: string) {
  await control.waitFor();
  await control.focus();
  assert.equal(await isFocused(control), true, `${name} takes focus`);
  assert.deepEqual(await arrowsHandled(control), [false, false], `${name} keeps its arrow keys`);
  assert.equal(await isFocused(control), true, `${name} keeps focus`);
}

test("ArrowDown and ArrowUp stay with the More list, the account menu and an open Home item", async (t) => {
  const page = await open(t, "/");
  await page.locator("[data-inbox-row] h3 a:visible").first().waitFor();
  await page.evaluate(() => {
    const review = document.createElement("div");
    review.className = "home-inline-review";
    review.innerHTML = '<button id="shortcutReviewButton" type="button">Send</button>';
    document.querySelector("[data-inbox-row]")?.append(review);
  });
  await page.locator(".app-shell-more-toggle").click();
  await keepsArrows(page.locator(".app-shell-more-list a").locator("visible=true").first(), "the More list");
  await page.locator("#selfAvatar").click();
  await keepsArrows(
    page.locator("#accountMenu button, #accountMenu a").locator("visible=true").first(),
    "the account menu",
  );
  await keepsArrows(page.locator("#shortcutReviewButton"), "an open Home item");
});

test("ArrowDown and ArrowUp stay with the Today drawer on the Deals board", async (t) => {
  const page = await open(t, "/deals?mode=live", {
    before: async (page) => {
      await withProspects(page);
      await page.addInitScript(() => localStorage.setItem("doctorcre:today:/deals", "open"));
    },
  });
  await page.locator("#kanban [data-column] .kanban-card").first().waitFor();
  await keepsArrows(page.locator("#appToday button, #appToday a").locator("visible=true").first(), "the Today drawer");
});

test("j and k do nothing on a page without cards", async (t) => {
  const page = await open(t, "/leads");
  const home = page.getByRole("navigation", { name: "Primary navigation" }).locator(":scope > a").first();
  await home.focus();
  const prevented = await page.evaluate(() =>
    ["j", "k"].map((key) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  assert.deepEqual(prevented, [false, false]);
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  assert.equal(await isFocused(home), true);
  await stays(page, "/leads");
});

test("j and k do nothing while the shortcut list is open", async (t) => {
  const page = await open(t, "/");
  await page.locator("[data-inbox-row] h3 a:visible").first().waitFor();
  await page.keyboard.press("?");
  const dialog = helpDialog(page);
  await dialog.waitFor();
  const before = await page.evaluate(() => document.activeElement?.outerHTML);
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  assert.equal(await page.evaluate(() => document.activeElement?.outerHTML), before);
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-shortcut-card]"))), false);
  assert.equal(await dialog.isVisible(), true);
});

test("E on a focused Home row sends the Done save", async (t) => {
  const page = await open(t, "/");
  const titles = page.locator("[data-inbox-row] h3 a:visible");
  await titles.first().waitFor();
  const name = (await titles.first().textContent())?.trim() ?? "";
  assert.ok(name, "Home shows a card");
  await page.keyboard.press("j");
  assert.equal(await focused(page), name);
  await page.keyboard.press("e");
  const toast = page.locator(".toast").filter({ hasText: `Marked done: ${name}.` });
  await toast.getByRole("button", { name: "Undo", exact: true }).waitFor();
});

test("S on a focused Home row opens the Snooze menu", async (t) => {
  const page = await open(t, "/");
  const titles = page.locator("[data-inbox-row] h3 a:visible");
  await titles.first().waitFor();
  const name = (await titles.first().textContent())?.trim() ?? "";
  await page.keyboard.press("j");
  assert.equal(await focused(page), name);
  await page.keyboard.press("s");
  const menu = page.getByRole("dialog", { name: "Snooze cards" });
  await menu.waitFor();
  assert.equal(await menu.evaluate((node) => node.matches(":modal")), true);
  assert.equal(
    await menu.evaluate((node) => Boolean(document.activeElement && node.contains(document.activeElement))),
    true,
    "focus is inside the Snooze menu",
  );
});

test("E and S do nothing in a text box or an open item", async (t) => {
  const page = await open(t, "/");
  const titles = page.locator("[data-inbox-row] h3 a:visible");
  await titles.first().waitFor();
  const name = (await titles.first().textContent())?.trim() ?? "";
  const doneToast = () => page.locator(".toast").filter({ hasText: `Marked done: ${name}.` });
  const snooze = () => page.getByRole("dialog", { name: "Snooze cards" });

  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "shortcutHomeField";
    field.type = "text";
    document.body.append(field);
  });
  const field = page.locator("#shortcutHomeField");
  await field.focus();
  await page.keyboard.type("es");
  assert.equal(await field.inputValue(), "es");
  assert.equal(await field.evaluate((node) => node === document.activeElement), true);
  assert.equal(await doneToast().count(), 0);
  assert.equal(await snooze().count(), 0);

  await field.evaluate((node) => node.blur());
  await page.keyboard.press("j");
  assert.equal(await focused(page), name);
  await page.keyboard.press("Enter");
  await page.waitForFunction((title) => {
    const link = Array.from(document.querySelectorAll("[data-inbox-row] h3 a")).find(
      (node) => node.textContent?.trim() === title,
    );
    return link?.getAttribute("aria-expanded") === "true";
  }, name);
  await page.keyboard.press("e");
  await page.keyboard.press("s");
  await page.waitForTimeout(400);
  assert.equal(await doneToast().count(), 0);
  assert.equal(await snooze().count(), 0);
  assert.equal(await page.locator("[data-inbox-row] h3 a:visible").first().getAttribute("aria-expanded"), "true");
});

test("? lists E Done (Home) and S Snooze (Home)", async (t) => {
  const page = await open(t, "/");
  await page.keyboard.press("?");
  const dialog = helpDialog(page);
  await dialog.waitFor();
  const rows = await dialog.getByRole("row").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.equal(rows.includes("EDone (Home)"), true);
  assert.equal(rows.includes("SSnooze (Home)"), true);
});
