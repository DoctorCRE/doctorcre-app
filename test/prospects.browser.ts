import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium, settles } from "./browser-harness.mjs";

const party = "00000000-0000-4000-8000-000000000001";
const note = { activity_id: party, by: "dell", at: "2026-11-18T15:40:00Z", summary: "First line\nSecond line" };

test("Deals opens one prospect on desktop and phone and reloads its notes", async (t) => {
  const actor = "joe";
  const session = { actor: { slug: actor }, csrf_token: "synthetic-csrf" };
  const CARR = { fetch: async () => Response.json(session) };
  const server = await startWorkerFixture({ assets: await appAssetSnapshot(), env: { CARR } });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.clock.setFixedTime(new Date("2026-11-18T17:00:00Z"));
      let notes = [note];
      const step = { next_step_id: party, owner: actor, what: "Call again", due_on: "2026-11-19", change_id: 8 };
      const prospect = {
        party_id: party,
        name: "Example Elm Practice",
        how_found: "referral",
        owner: null,
        needs_attention: true,
        follow_ups: [step],
        latest_note: note,
        change_id: 12,
      };
      const birchProspect = {
        ...prospect,
        party_id: "00000000-0000-4000-8000-000000000006",
        name: "Example Birch Practice",
        owner: "dell",
        how_found: "not_recorded",
        needs_attention: false,
        latest_note: { ...note, by: "agent" },
        follow_ups: [{ ...step, owner: "dell", due_on: "2026-11-12" }],
      };
      const board = { schema_version: "local-deals-board.v2", actor, deals: [] };
      let enabled = false;
      const env = {
        GIT_SHA: "0".repeat(40),
        APP_ENV: "fixture",
        ENGINE_ROUTING: { get: async () => (enabled ? "on" : null) },
        CARR: {
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname !== "/mcp") return Response.json(session);
            const { id, params } = await request.json();
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(params.name === "deal-room-board" ? board : {}) }],
              },
            });
          },
        },
        ENGINE: {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (path.endsWith("/prospects")) return Response.json({ count: 2, prospects: [prospect, birchProspect] });
            if (path.endsWith(birchProspect.party_id))
              return Response.json({
                ...birchProspect,
                notes: [birchProspect.latest_note, { ...note, activity_id: birchProspect.party_id, by: null }],
              });
            if (path.endsWith(party)) return Response.json({ ...prospect, notes });
            return Response.json(board);
          },
        },
      };
      assert.equal((await worker.fetch(new Request(`${server.origin}/api/engine/prospects`), env)).status, 404);
      enabled = true;
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
      await page.goto(`${server.origin}/deals?mode=live`);
      const open = page.getByRole("button", { name: "Example Elm Practice" });
      await open.waitFor();
      assert.equal(await open.count(), 1);
      assert.equal(
        await page
          .locator("#kanban")
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
        width === 390 ? 1 : 8,
      );
      const lane = page.locator("#prospectsLane");
      assert.match((await lane.textContent()) ?? "", /Unclaimed[\s\S]*Needs attention[\s\S]*Thu, Nov 19/);
      assert.equal(
        await lane
          .locator(".work-card-meta")
          .first()
          .evaluate((element) => element.clientWidth > (element.parentElement?.clientWidth ?? 0) / 2),
        true,
      );
      if (width === 1440) {
        const headline = page.locator("#boardLive");
        const chips = page.locator("#boardChips");
        const birch = lane.getByRole("button", { name: "Example Birch Practice" });
        await birch.waitFor();
        await settles(async () => assert.match((await headline.textContent()) ?? "", / · 2 prospects$/));
        assert.match((await lane.textContent()) ?? "", /Dell · Due Thu, Nov 12 \(6 days late\)/);
        assert.match((await lane.textContent()) ?? "", /Doc \(assistant\) · Wed, Nov 18, 9:40 AM/);
        await chips.getByRole("button", { name: "Joe", exact: true }).click();
        await birch.waitFor({ state: "detached" });
        await open.waitFor();
        await settles(async () => assert.match((await headline.textContent()) ?? "", / · 1 prospect$/));
        await chips.getByRole("button", { name: "Dell", exact: true }).click();
        await birch.waitFor();
        await open.waitFor();
        await settles(async () => assert.match((await headline.textContent()) ?? "", / · 2 prospects$/));
        await birch.click();
        const claimedDetail = page.getByRole("dialog", { name: "Example Birch Practice" });
        await claimedDetail.getByText("Claimed by Dell", { exact: true }).waitFor();
        await claimedDetail.getByText("How found · Not recorded", { exact: true }).waitFor();
        await claimedDetail.getByText(/^Author not recorded ·/).waitFor();
        await page.goto(`${server.origin}/deals?mode=live&filter=flagged`);
        await open.waitFor();
        assert.equal(await birch.count(), 0);
        await settles(async () => assert.match((await headline.textContent()) ?? "", / · 1 prospect$/));
        await page.goto(`${server.origin}/deals?mode=live`);
        await open.waitFor();
      }
      await page.getByRole("button", { name: "List", exact: true }).click();
      await open.waitFor();
      assert.equal(await open.count(), 1);
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Example Elm Practice" });
      await dialog.waitFor();
      assert.match((await dialog.textContent()) ?? "", /Referral[\s\S]*Call again[\s\S]*First line/);
      notes = [{ ...note, activity_id: crypto.randomUUID(), summary: "Other partner update" }, ...notes];
      await dialog.getByRole("button", { name: "Reload prospect" }).click();
      await dialog.getByText("Other partner update", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await page.close();
    }
  }
});
