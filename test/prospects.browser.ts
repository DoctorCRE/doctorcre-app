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
      let savesEnabled = false,
        firstNote = true;
      const writeKeys: string[] = [];
      const env = {
        GIT_SHA: "0".repeat(40),
        APP_ENV: "fixture",
        ENGINE_ROUTING: {
          get: async (key: string) => (enabled && (key === "deals-from-engine" || savesEnabled) ? "on" : null),
        },
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
            if (request.method === "POST") {
              const body = await request.json();
              assert.equal(request.headers.get("x-carr-csrf"), session.csrf_token);
              assert.match(body.idempotency_key, /^[\da-f-]{36}$/);
              if (path.endsWith("/activities")) {
                assert.deepEqual(body.about, [{ party_id: party }]);
                assert.equal(body.kind, "note");
                if (body.summary === "Save refused for account")
                  return Response.json({ error: "actor_not_provisioned" }, { status: 422 });
                if (body.summary === "Save refused for data")
                  return Response.json({ error: "database_refused_the_statement" }, { status: 422 });
                if (!writeKeys.includes(body.idempotency_key))
                  notes = [{ ...note, activity_id: crypto.randomUUID(), summary: body.summary, by: actor }, ...notes];
                writeKeys.push(body.idempotency_key);
                if (firstNote) {
                  firstNote = false;
                  return Response.json({ error: "engine_unavailable" }, { status: 503 });
                }
                return Response.json({ activity_id: party }, { status: 201 });
              }
              assert.equal(path, "/api/engine/next-steps");
              assert.equal(body.replaces, "current");
              assert.equal(body.party_id, party);
              assert.equal(body.seen_current_step.next_step_id, step.next_step_id);
              if (body.seen_current_step.change_id !== step.change_id)
                return Response.json({ error: "version_conflict" }, { status: 409 });
              Object.assign(step, { what: body.what, due_on: body.due_on });
              return Response.json({ next_step_id: party }, { status: 201 });
            }
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
      const blocked = await worker.fetch(
        new Request(`${server.origin}/api/engine/prospects/note`, { method: "POST" }),
        env,
      );
      assert.equal(blocked.status, 404);
      savesEnabled = true;
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
      if (width === 1440) {
        const input = dialog.getByRole("textbox", { name: "Add note" });
        const checkOutcome = dialog.getByRole("button", { name: "Check outcome" });
        await input.fill("Earlier note");
        await input.press("Enter");
        await checkOutcome.waitFor();
        await dialog.getByRole("button", { name: "Back to Deals" }).click();
        await open.click();
        await input.fill("New draft");
        await input.press("Enter");
        await checkOutcome.click();
        await settles(async () => assert.equal(await input.isEnabled(), true));
        assert.equal(await input.inputValue(), "New draft");
        assert.equal(writeKeys.length, 2);
        assert.equal(writeKeys[0], writeKeys[1]);
        await input.press("Enter");
        await dialog.getByText("New draft", { exact: true }).waitFor();
        assert.notEqual(writeKeys[2], writeKeys[1]);
        await input.fill("Save refused for account");
        await input.press("Enter");
        await dialog.getByText("Your account is not set up to save prospects. Ask the app administrator.").waitFor();
        await input.fill("Save refused for data");
        await input.press("Enter");
        await dialog.getByText("The change was refused. Reload the prospect, then try again.").waitFor();
        const summary = dialog.getByRole("textbox", { name: "Your follow-up", exact: true });
        await summary.fill("Send the details");
        await dialog.getByLabel("Follow-up date").fill("2026-11-20");
        step.change_id++;
        step.what = "Other follow-up";
        await dialog.getByRole("button", { name: "Reload prospect", exact: true }).click();
        await dialog.getByText(/Other follow-up/).waitFor();
        const save = dialog.getByRole("button", { name: "Set your follow-up" });
        await save.click();
        await dialog.getByText("This prospect changed while you were editing.").waitFor();
        assert.equal(await summary.inputValue(), "Send the details");
        await dialog.getByRole("button", { name: "Reload changes", exact: true }).click();
        await dialog.getByText(/Other follow-up/).waitFor();
        await save.click();
        await dialog.getByText(/Send the details · Due Fri, Nov 20/).waitFor();
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await page.close();
    }
  }
});
