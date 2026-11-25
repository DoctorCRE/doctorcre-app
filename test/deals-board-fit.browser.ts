import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const phases = ["pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing"];
const names = [
  "Example Practitioner, DMD",
  "Example Northfield — Riverbend Purchase",
  "Example Imaging Partners – Second Office",
  "Example Dermatology Group",
  "Example Orthodontics – North / 5 Corners",
];
const deals = Array.from({ length: 70 }, (_, n) => ({
  id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
  name: `${names[n % names.length]} ${n + 1}`,
  owner: n % 2 ? "joe" : "dell",
  phase: phases[n % phases.length],
  operating_state: "active",
  attention: n % 5 === 0,
  open_actions: [
    {
      id: `step-${n}`,
      description: "Call the landlord about the lease draft",
      owner: n % 2 ? "joe" : "dell",
      due_on: n % 3 ? "2026-11-02" : "2027-01-15",
    },
  ],
}));
const prospects = Array.from({ length: 12 }, (_, n) => ({
  party_id: `00000000-0000-4000-9000-${String(n + 1).padStart(12, "0")}`,
  name: `Example Prospect Practice ${n + 1}`,
  how_found: "referral",
  owner: n % 3 ? "joe" : null,
  needs_attention: n % 4 === 0,
  follow_ups: [],
  latest_note: null,
  change_id: 1,
}));

const accounts = Array.from({ length: 9 }, (_, n) => ({
  account_client_id: `00000000-0000-4000-a000-${String(n + 1).padStart(12, "0")}`,
  account_name: `Example National Dental Partners ${n + 1}`,
  account_owner: n % 2 ? "joe" : "dell",
  open_deals: 12 - n,
  overdue_deals: n % 3,
  parked_deals: n % 2,
}));

async function openBoard(page: Page, view: "board" | "list" | "national" = "board") {
  const session = { actor: { slug: "joe" }, csrf_token: "synthetic-joe" };
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname.endsWith("/prospects")
          ? Response.json({ count: prospects.length, prospects })
          : Response.json({
              schema_version: "local-deals-board.v2",
              actor: "joe",
              deals,
              closed_deals: [],
              lost_deals: [],
              accounts,
            }),
    },
  };
  const server = await startWorkerFixture({ assets: await appAssetSnapshot(), env });
  await page.route(/\/(mcp|api\/engine\/.*)$/, async (route) => {
    const request = route.request();
    const body = request.postData();
    const reply = await worker.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(body === null ? {} : { body }),
      }),
      env,
    );
    await route.fulfill({
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: Buffer.from(await reply.arrayBuffer()),
    });
  });
  await page.goto(`${server.origin}/deals?mode=live&view=${view}`);
  await page
    .locator(
      { list: ".deal-list .kanban-card", board: ".kanban-column[data-column] .kanban-card", national: ".account-card" }[
        view
      ],
    )
    .first()
    .waitFor();
  if (view !== "national") await page.locator("#prospectsLane h3").waitFor();
  return server;
}

// Words in deal names and phase names that the browser split across two lines.
const splitWords = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".kanban-card .card-open, .kanban-column > h3 button > span")].flatMap((element) =>
      [...(element.textContent ?? "").matchAll(/\S+/g)].flatMap((word) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let offset = 0, node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (word.index >= offset && word.index < offset + length) {
            range.setStart(node, word.index - offset);
            range.setEnd(node, Math.min(length, word.index - offset + word[0].length));
          }
          offset += length;
        }
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1 ? [word[0]] : [];
      }),
    ),
  );

const phaseLines = (page: Page) =>
  page
    .locator(".kanban-column > h3 button")
    .evaluateAll((buttons) =>
      buttons.map((button) => [
        button.getAttribute("aria-label"),
        [...button.children].every(
          (part) => part.getBoundingClientRect().height < 1.8 * Number.parseFloat(getComputedStyle(part).fontSize),
        ),
      ]),
    );

const todayState = (page: Page) => page.locator(".app-layout").getAttribute("data-today");
const sidewaysFit = (page: Page) =>
  page.evaluate(() => ({
    board:
      (document.getElementById("kanban")?.scrollWidth ?? 0) <= (document.getElementById("kanban")?.clientWidth ?? 0),
    page: document.documentElement.scrollWidth <= innerWidth,
  }));

test("an open Today panel stays open and the board scrolls sideways inside itself", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  t.after(() => context.close());
  await context.addInitScript(() => localStorage.setItem("doctorcre:today:/deals", "open"));
  const page = await context.newPage();
  const server = await openBoard(page);
  t.after(() => server.close());
  assert.equal(await todayState(page), "open", "the partner's own choice is remembered");
  assert.equal((await sidewaysFit(page)).page, true, "the page itself never scrolls sideways");
  await page.locator("#appTodayToggle").click();
  assert.equal(await page.evaluate(() => localStorage.getItem("doctorcre:today:/deals")), "closed");
});

test("the Deals board keeps deals in reach on a phone and fits one screen on laptops", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const shots = "out/test-artifacts/deals-board-fit";
  await mkdir(shots, { recursive: true });

  for (const [width, height] of [
    [390, 844],
    [1200, 800],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const)
    for (const theme of ["light", "dark"] as const)
      await t.test(`${width} ${theme}`, async (t) => {
        const context = await browser.newContext({ viewport: { width, height } });
        t.after(() => context.close());
        await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        const page = await context.newPage();
        const server = await openBoard(page);
        t.after(() => server.close());
        await page.screenshot({ path: `${shots}/board-${width}-${theme}.png` });

        assert.deepEqual(await splitWords(page), [], "no deal or phase name breaks inside a word");
        assert.equal(
          await page.locator(".kanban-column[data-column] .kanban-card time").count(),
          0,
          "a deal card shows no due date or late count",
        );
        if (width > 760) {
          const headers = await page
            .locator("#prospectsLane > h3, .kanban-column[data-column] > h3")
            .evaluateAll((headers) =>
              headers.map((header) => {
                const count = header.querySelector("small");
                const name = document.createRange();
                name.setStart(header, 0);
                if (count) name.setEndBefore(count);
                const gap = count ? count.getBoundingClientRect().left - name.getBoundingClientRect().right : 0;
                return { bottom: Math.round(header.getBoundingClientRect().bottom), countFollowsName: gap <= 16 };
              }),
            );
          assert.equal(
            new Set(headers.map((h) => h.bottom)).size,
            1,
            "the Prospects header shares the phase headers' line",
          );
          if (width >= 1280)
            assert.deepEqual(
              await page.locator(".kanban-column[data-column] .kanban-card").evaluateAll((cards) =>
                cards.flatMap((card) => {
                  const badge = card.querySelector(".deal-board-badge")?.getBoundingClientRect();
                  const owner = card.querySelector(".owner")?.getBoundingClientRect();
                  return badge && owner && owner.top > badge.bottom ? [card.getAttribute("aria-label")] : [];
                }),
              ),
              [],
              "the badge and the owner share one row",
            );
          assert.ok(
            headers.every((h) => h.countFollowsName),
            "each count sits right after its name, Prospects as the phases",
          );
        }
        assert.ok(
          (await phaseLines(page)).every(([, oneLine]) => oneLine),
          "each phase name and count sit on one line",
        );
        if (width > 760) {
          assert.equal(await todayState(page), "closed", "Today starts collapsed on the Deals board");
          assert.deepEqual(await sidewaysFit(page), { board: true, page: true }, "nothing scrolls sideways");
          assert.equal(
            await page
              .locator('.kanban-column[data-column="pending"] > h3 button > span')
              .evaluate((name) => name.scrollWidth <= name.clientWidth),
            true,
            "Prospective Client shows in full",
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
            true,
            "the board fits the screen without page scrolling",
          );
          const column = page.locator('.kanban-column[data-column="pending"]');
          const bottom = await column.evaluate((column) => {
            column.scrollTop = column.scrollHeight;
            return Math.round(column.getBoundingClientRect().bottom);
          });
          assert.ok(bottom <= height, "a full column ends on screen");
          assert.ok(await column.evaluate((column) => column.scrollTop > 0), "a full column scrolls inside itself");
          assert.equal(await column.locator("h3").isVisible(), true, "its phase name stays in view");
          return;
        }

        const lanes = await page
          .locator(".kanban > .kanban-column")
          .evaluateAll((lanes) =>
            lanes.map((lane) => [lane.id || lane.dataset.column, lane.getBoundingClientRect().top]),
          );
        const sorted = [...lanes].sort((a, b) => Number(a[1]) - Number(b[1])).map(([name]) => name);
        assert.equal(sorted.at(-1), "prospectsLane", "the Prospects lane comes after the deal phases");
        const board = await page
          .locator("#kanban")
          .evaluate((board) => ({ scrolls: board.scrollHeight > board.clientHeight + 1 }));
        assert.equal(board.scrolls, false, "the board scrolls with the page, not in its own box");
        const card = await page.locator(".kanban-column[data-column] .kanban-card").first().boundingBox();
        const nav = await page.locator("#appShell").boundingBox();
        assert.ok(card && nav && card.y + card.height <= nav.y, "the first deal is whole on the first screen");
      });
});

test("the board scrolls with no visible bar and a faint thumb shows only while a column scrolls", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const server = await openBoard(page);
  t.after(() => server.close());
  const column = page.locator('.kanban-column[data-column="pending"]');
  assert.deepEqual(
    await page
      .locator("#kanban, .kanban-column[data-column]")
      .evaluateAll((scrollers) => [...new Set(scrollers.map((s) => getComputedStyle(s).scrollbarWidth))]),
    ["none"],
    "neither the board nor a column draws a scroll bar",
  );
  assert.equal(await page.locator(".scroll-thumb").count(), 0, "no thumb before scrolling");

  const box = await column.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  const thumb = page.locator(".scroll-thumb");
  await thumb.waitFor();
  assert.ok(await column.evaluate((c) => c.scrollTop > 0), "the wheel scrolls the column");
  const shown = await thumb.boundingBox();
  assert.ok(shown && shown.width <= 4, "the thumb is thin");
  assert.ok(shown.x >= box.x && shown.x + shown.width <= box.x + box.width, "the thumb sits on its column");
  assert.ok(shown.y >= box.y && shown.y + shown.height <= box.y + box.height + 1, "the thumb stays inside its column");
  const alpha = await thumb.evaluate((t) =>
    Number(/[\d.]+(?=\)$)/.exec(getComputedStyle(t).backgroundColor)?.[0] ?? 1),
  );
  assert.ok(alpha <= 0.3, `the thumb is faint (${alpha})`);
  await thumb.waitFor({ state: "detached" });
});

test("a sideways board scroll shows no thumb", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const server = await openBoard(page);
  t.after(() => server.close());
  const board = page.locator("#kanban");
  // A short window leaves the board itself scrolling both ways; a fixed height stands in for it.
  await board.evaluate((k) => {
    k.style.flex = "none";
    k.style.height = "240px";
  });
  const scroll = (axis: "scrollLeft" | "scrollTop") =>
    board.evaluate(
      (k, axis) =>
        new Promise<number>((resolve) => {
          k.addEventListener("scroll", () => resolve(k[axis]), { once: true });
          k[axis] = 60;
        }),
      axis,
    );
  assert.ok((await scroll("scrollLeft")) > 0, "the board moved sideways");
  assert.equal(await page.locator(".scroll-thumb").count(), 0, "no up-and-down thumb for a sideways scroll");
  assert.ok((await scroll("scrollTop")) > 0, "the board moved down");
  assert.equal(await page.locator(".scroll-thumb").count(), 1, "moving down still shows the thumb");
});

test("with reduced motion the thumb holds, then leaves without fading", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.addInitScript(() =>
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" })),
  );
  const page = await context.newPage();
  const server = await openBoard(page);
  t.after(() => server.close());
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  const box = await page.locator('.kanban-column[data-column="pending"]').boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  const thumb = page.locator(".scroll-thumb");
  await thumb.waitFor();
  await mkdir("out/test-artifacts/deals-board-fit", { recursive: true });
  await page.screenshot({ path: "out/test-artifacts/deals-board-fit/thumb-light-reduced.png" });
  const opacities = await thumb.evaluate((t) =>
    t
      .getAnimations()
      .flatMap(({ effect }) =>
        effect instanceof KeyframeEffect ? effect.getKeyframes().map((k) => Number(k.opacity ?? 1)) : [],
      ),
  );
  assert.ok(opacities.length > 0 && opacities.every((o) => o === 1), `the thumb never fades (${opacities})`);
  await thumb.waitFor({ state: "detached" });
});

test("the Deals list and the Prospects lane never cover each other", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const shots = "out/test-artifacts/deals-list-fit";
  await mkdir(shots, { recursive: true });

  for (const [width, height, today] of [
    [390, 844, "closed"],
    [1280, 800, "closed"],
    [1280, 800, "open"],
    [1440, 900, "closed"],
    [1440, 900, "open"],
  ] as const)
    await t.test(`${width} Today ${today}`, async (t) => {
      const context = await browser.newContext({ viewport: { width, height } });
      t.after(() => context.close());
      await context.addInitScript((today) => localStorage.setItem("doctorcre:today:/deals", today), today);
      const page = await context.newPage();
      const server = await openBoard(page, "list");
      t.after(() => server.close());
      await page.screenshot({ path: `${shots}/list-${width}-today-${today}.png` });

      const covered = await page.evaluate(() => {
        const lane = document.getElementById("prospectsLane")?.getBoundingClientRect();
        return [...document.querySelectorAll(".deal-list .kanban-card")].flatMap((row) => {
          const box = row.getBoundingClientRect();
          return lane && box.bottom > lane.top && box.top < lane.bottom ? [row.textContent?.trim().slice(0, 40)] : [];
        });
      });
      assert.deepEqual(covered, [], "no deal row sits under the Prospects lane");
      if (width > 760) {
        const row = page.locator(".deal-list .kanban-card").first();
        const size = (selector: string) =>
          row.locator(selector).evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
        assert.ok(
          (await size(".deal-list-next-step")) < (await size(".work-card-title")),
          "the next step is caption text under the deal's name size",
        );
        assert.ok(((await row.boundingBox())?.height ?? 99) <= 64, "a list row is at most 64px tall");
      }
      const lane = page.locator("#prospectsLane");
      await lane.scrollIntoViewIfNeeded();
      assert.equal(
        await lane.evaluate((lane) => lane.scrollHeight <= lane.clientHeight + 1),
        true,
        "the Prospects lane shows whole after the last deal",
      );
      assert.equal(await page.getByRole("button", { name: "Add prospect" }).isVisible(), true);
      await page.screenshot({ path: `${shots}/list-${width}-today-${today}-prospects.png` });
      if (width > 760)
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
          true,
          "the list fits the screen without page scrolling",
        );
    });
});

// Controls and the labels and stamps a partner taps, by name, when shorter than a 44px touch target.
const shortTargets = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, label, [tabindex='0']")].flatMap((node) => {
      const box = node.getBoundingClientRect();
      return node.checkVisibility() && box.height > 0 && box.height < 44 ? [node.textContent?.trim()] : [];
    }),
  );

test("on a phone National Accounts names itself once and every tap target is full size", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  const page = await context.newPage();
  const server = await openBoard(page, "national");
  t.after(() => server.close());
  await page.locator("#syncStatus", { hasText: "Updated" }).waitFor();
  await page.screenshot({ path: "out/test-artifacts/deals-board-fit/national-390.png" });
  const names = await page.evaluate(
    () =>
      [...document.querySelectorAll("body *")].filter(
        (node) =>
          node.checkVisibility() &&
          node.getBoundingClientRect().width > 1 &&
          [...node.childNodes].some(
            (child) => child.nodeType === 3 && /^\s*National( Accounts)?\s*$/.test(child.textContent ?? ""),
          ),
      ).length,
  );
  assert.equal(names, 1, "the page names itself once");
  assert.deepEqual(await shortTargets(page), [], "the list's controls and Updated are full touch targets");
  await page.getByRole("button", { name: "Add national account" }).click();
  assert.deepEqual(await shortTargets(page), [], "the form's labels are full touch targets");
  await page.keyboard.press("Escape");
  await page.locator(".account-card").first().click();
  await page.locator("#dealFilter").waitFor();
  assert.deepEqual(await shortTargets(page), [], "an account's Show label is a full touch target");
});
