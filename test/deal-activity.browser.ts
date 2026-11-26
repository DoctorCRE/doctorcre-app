import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import type { Locator } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const shots = "out/test-artifacts/deal-activity";
const dealId = "00000000-0000-4000-8000-00000000d161";
const now = "2026-11-18T15:00:00Z";
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };
const signed = [
  "The lease is signed.",
  "",
  "Pat Example",
  "Example Realty Group",
  "555-010-0100 (o)",
  "examplerealty.com",
  "",
  "From: Sam Example",
  "Sent: Monday",
  "To: Pat Example",
  "Subject: Lease",
  "",
  "Is it signed?",
].join("\n");

function many() {
  return {
    id: dealId,
    deal_id: dealId,
    name: "Example Activity Deal",
    phase: "legal",
    owner: "joe",
    seen: 1,
    email_follow_ups: [],
    correspondence: [
      {
        kind: "email",
        activity_id: "mail-1",
        subject: "Example suite floor plan",
        sender_name: "Example Broker",
        happened_at: "2026-11-17T21:00:00Z",
      },
      { kind: "meeting", activity_id: "meet-1", title: "Property tour", happened_at: "2026-11-16T18:00:00Z" },
    ],
    thread: [
      { id: "note-1", kind: "note", text: "Tour plans confirmed", actor: "dell", created_at: "2026-11-17T20:00:00Z" },
    ],
    activities: [
      {
        id: "mail-1",
        kind: "email",
        summary: "Quoted body that must not be a second row",
        occurred_at: "2026-11-17T21:00:00Z",
      },
      {
        id: "raw-mail",
        kind: "email",
        actor: "agent",
        sender: "Pat Example <pat@example.com>",
        summary: signed,
        occurred_at: "2026-11-15T16:00:00Z",
      },
      { id: "call-1", kind: "call", actor: "joe", summary: "Called the landlord", occurred_at: "2026-11-15T15:00:00Z" },
    ],
    documents: [{ id: "file", name: "Example plan.pdf", actor: "mail_capture", prepared_at: "2026-11-16T14:00:00Z" }],
    events: [
      {
        id: "move",
        verb: "move-phase",
        field: "phase",
        new_value: "legal",
        actor: "agent",
        recorded_at: "2026-11-18T01:00:00Z",
      },
    ],
    imported_deal_history: [
      {
        id: "old-1",
        imported: true,
        actor: "joe",
        verb: "new-deal",
        field: null,
        new_value: { deal_type: "lease", reason: "Renewal" },
        recorded_at: "2025-01-06T00:00:00Z",
      },
    ],
    next_actions: [
      {
        id: "step",
        description: "Check the floor plan",
        status: "open",
        actor: "joe",
        updated_at: "2026-11-17T18:00:00Z",
      },
      {
        id: "done-step",
        description: "Send the sample plan",
        status: "done",
        actor: "joe",
        due_on: "2026-11-24",
        updated_at: "2026-11-17T18:30:00Z",
      },
    ],
    critical_dates: [
      {
        id: "due",
        kind: "due_diligence",
        status: "open",
        due_on: "2026-11-19",
        actor: "joe",
        updated_at: "2026-11-17T19:00:00Z",
      },
    ],
  };
}

function none() {
  const thread: { id: string; kind: string; text: string; actor: string; created_at: string }[] = [];
  return {
    id: dealId,
    deal_id: dealId,
    name: "Example Empty Deal",
    phase: "research",
    owner: "joe",
    seen: 1,
    email_follow_ups: [],
    correspondence: [],
    thread,
  };
}

async function revealActivity(activity: Locator) {
  await activity.evaluate((node: HTMLElement) => {
    const cover = Math.max(
      0,
      ...[...document.querySelectorAll(".app-layout-topbar, .app-layout-tabbar, .workspace-header")].map(
        (bar: Element) => bar.getBoundingClientRect().bottom,
      ),
    );
    let scroller = node.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const top = node.getBoundingClientRect().top;
    if (top >= cover + 1) return;
    if (scroller) scroller.scrollTop += top - cover;
    else window.scrollBy(0, top - cover);
  });
}

async function chipVisible(activity: Locator, name: string) {
  return activity.getByRole("button", { name, exact: true }).evaluate((node: HTMLElement) => {
    const box = node.getBoundingClientRect();
    if (box.width < 8 || box.height < 8 || box.bottom < 0 || box.top > window.innerHeight) return false;
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12));
    return Boolean(hit && (hit === node || node.contains(hit)));
  });
}

test("a deal's Activity is one filtered history, and an empty one says nothing is recorded", async (t) => {
  const notes: { id: string; kind: string; text: string; actor: string; created_at: string }[] = [];
  let variant: "many" | "none" | "saved" = "many";
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { CARR: { fetch: async () => Response.json(session) }, ENGINE_ROUTING: { get: async () => "on" } },
  });
  t.after(() => server.close());
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/engine/activities") {
          const body = await request.json();
          assert.equal(body.kind, "note");
          assert.equal(body.summary, "Called the example clinic");
          const id = "00000000-0000-4000-8000-00000000d162";
          notes.push({ id, kind: "note", text: body.summary, actor: "joe", created_at: body.happened_at });
          return Response.json({ activity_id: id }, { status: 201 });
        }
        if (path === `/api/engine/deals/${dealId}`)
          return Response.json(variant === "many" ? many() : { ...none(), thread: variant === "saved" ? notes : [] });
        if (path === "/api/engine/deals") {
          const deal = variant === "many" ? many() : none();
          return Response.json({ schema_version: "local-deals-board.v2", actor: "joe", deals: [deal] });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(shots, { recursive: true });

  for (const [width, height] of [
    [1440, 772],
    [1280, 640],
    [500, 900],
  ] as const)
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      t.after(() => context.close());
      await context.addInitScript((choice) => {
        localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: choice }));
      }, theme);
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(now));
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

      variant = "many";
      await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
      await page.getByRole("tab", { name: "Activity" }).click();
      const panel = page.getByRole("tabpanel", { name: "Activity" });
      const activity = panel.locator(".deal-activity");
      await activity.getByRole("heading", { name: "Activity", exact: true }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.deepEqual(await page.getByRole("tab").allTextContents(), [
        "Overview",
        "Activity",
        "Tours",
        "Documents",
        "Client portal",
      ]);
      assert.equal(await panel.getByText("Dated events", { exact: true }).count(), 0);
      assert.equal(await panel.getByText("Phase timeline", { exact: true }).count(), 0);
      assert.equal(await panel.getByRole("region", { name: "History from the old system" }).count(), 0);
      assert.equal(await panel.getByText("Check the floor plan", { exact: true }).count(), 0);
      assert.equal(await panel.getByText("Due diligence", { exact: false }).count(), 0);
      const noteTop = await activity.locator("#activityNoteForm").evaluate((node) => node.getBoundingClientRect().top);
      const filterTop = await activity.locator(".chip-bar").evaluate((node) => node.getBoundingClientRect().top);
      assert.ok(noteTop < filterTop, `note box sits above filter chips at ${width}`);
      const titles = () => activity.locator(".activity-row:not([hidden]) .activity-title").allTextContents();
      const shown = await titles();
      for (const title of [
        "Moved to Legal",
        "Example suite floor plan",
        "Tour plans confirmed",
        "Send the sample plan · Done · Due Nov 24, 2026",
        "Property tour",
        "Example plan.pdf",
        "Called the landlord",
        "The lease is signed. Pat Example",
      ]) {
        assert.equal(shown.filter((text) => text === title).length, 1, title);
      }
      assert.equal(shown.filter((text) => text.startsWith("Opened the deal")).length, 1);
      assert.equal(shown.includes("Quoted body that must not be a second row"), false);
      assert.deepEqual(await activity.locator("h3").allTextContents(), [
        "This week",
        "Earlier in November",
        "January 2025",
      ]);
      assert.equal(await activity.locator(".activity-row :is(button, a)").count(), 0);
      await activity.getByRole("button", { name: "Emails", exact: true }).click();
      assert.deepEqual(await titles(), ["Example suite floor plan", "The lease is signed. Pat Example"]);
      await activity.getByRole("button", { name: "All", exact: true }).click();
      assert.equal(
        await activity.evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
        `${width} stays within the page`,
      );
      if (width >= 1280) {
        const fit = await page.evaluate(() => ({
          pageFits: document.documentElement.scrollHeight <= window.innerHeight + 1,
          visibleRows: [...document.querySelectorAll(".activity-row:not([hidden])")].filter((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
          }).length,
        }));
        assert.equal(fit.pageFits, true, `desktop page does not scroll at ${width}x${height}`);
        assert.ok(fit.visibleRows >= 7, `at least 7 rows fit at ${width}x${height} (got ${fit.visibleRows})`);
      }
      await revealActivity(activity);
      for (const name of ["All", "Emails", "Notes", "Calls and meetings", "Documents", "Changes"]) {
        assert.equal(await chipVisible(activity, name), true, `${name} at ${width}`);
      }
      await page.screenshot({ path: `${shots}/dh-C1-many-${width}-${theme}.png`, animations: "disabled" });

      variant = "none";
      await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
      await page.getByRole("tab", { name: "Activity" }).click();
      await activity.getByText("Nothing recorded yet.", { exact: true }).waitFor();
      assert.equal(await activity.locator(".activity-row").count(), 0);
      const note = activity.getByLabel("Note", { exact: true });
      assert.equal(await note.isEnabled(), true);
      await revealActivity(activity);
      for (const name of ["All", "Emails", "Notes", "Calls and meetings", "Documents", "Changes"]) {
        assert.equal(await chipVisible(activity, name), true, `${name} at ${width} empty`);
      }
      await page.screenshot({ path: `${shots}/dh-C1-none-${width}-${theme}.png`, animations: "disabled" });
    }

  variant = "saved";
  const context = await browser.newContext({ viewport: { width: 1440, height: 772 }, colorScheme: "light" });
  t.after(() => context.close());
  await context.addInitScript(() => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" }));
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(now));
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
  await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
  await page.getByRole("tab", { name: "Activity" }).click();
  const note = page.getByRole("tabpanel", { name: "Activity" }).getByLabel("Note", { exact: true });
  await note.fill("Line one");
  await note.press("Shift+Enter");
  assert.match(await note.inputValue(), /Line one\n/);
  await note.fill("Called the example clinic");
  await note.press("Enter");
  const saved = page.getByRole("tabpanel", { name: "Activity" });
  await saved.locator(".activity-title", { hasText: "Called the example clinic" }).waitFor();
  assert.equal(await saved.getByLabel("Note", { exact: true }).inputValue(), "");
  assert.equal(await saved.locator(".activity-empty:not([hidden])").count(), 0);
});
