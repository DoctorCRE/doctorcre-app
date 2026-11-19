import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const party = "00000000-0000-4000-8000-000000000001";
const note = { activity_id: party, by: "dell", at: "2026-11-18T15:40:00Z", summary: "First line\nSecond line" };

test("partners see and manage prospects from Deals", async (t) => {
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
      const knownId = "00000000-0000-4000-8000-000000000002";
      const dealId = "00000000-0000-4000-8000-000000000003";
      const clientId = "00000000-0000-4000-8000-000000000004";
      let claimed: "joe" | "dell" | null = null;
      let dropped = false,
        added = false;
      const newProspect = { ...prospect, party_id: knownId, name: "Example Pine Prospect", needs_attention: false };
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
              if (path === "/api/engine/prospects") {
                if (body.party_id === knownId)
                  return Response.json(
                    { error: "not_a_prospect", party_id: knownId, deal_ids: [dealId] },
                    { status: 409 },
                  );
                if (body.party_id === clientId)
                  return Response.json({ error: "already_client", party_id: clientId }, { status: 409 });
                assert.equal(body.name, newProspect.name);
                assert.equal(body.kind, "company");
                assert.equal(body.how_found, "referral");
                assert.equal(body.note, "First conversation");
                added = true;
                return Response.json({ party_id: newProspect.party_id }, { status: 201 });
              }
              if (path.endsWith("/changes")) {
                assert.equal(body.seen_change_id, prospect.change_id++);
                if ("owner" in body.fields) claimed = body.fields.owner;
                if ("needs_attention" in body.fields) prospect.needs_attention = body.fields.needs_attention;
                return Response.json({ party_id: party, change_id: prospect.change_id });
              }
              if (path.endsWith("/drop")) {
                assert.equal(body.reason, "No longer looking");
                dropped = true;
                return Response.json({ party_id: party, stage: "archived" });
              }
              if (path.endsWith("/activities")) {
                assert.deepEqual(body.about, [{ party_id: party }]);
                assert.equal(body.kind, "note");
                writeKeys.push(body.idempotency_key);
                if (firstNote) {
                  firstNote = false;
                  notes = [{ ...note, activity_id: crypto.randomUUID(), summary: body.summary, by: actor }, ...notes];
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
            if (path.endsWith("/parties/search")) {
              const query = new URL(request.url).searchParams.get("query");
              return Response.json({
                parties:
                  query === "Known"
                    ? [{ id: knownId, display_name: "Known Example", kind: "person" }]
                    : query === "Client"
                      ? [{ id: clientId, display_name: "Client Example", kind: "company" }]
                      : [],
              });
            }
            if (path.endsWith("/prospects")) {
              const prospects = [
                ...(dropped ? [] : [{ ...prospect, owner: claimed }]),
                ...(added ? [newProspect] : []),
              ];
              return Response.json({ count: prospects.length, prospects });
            }
            if (path.endsWith(party)) return Response.json({ ...prospect, owner: claimed, notes });
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
          .evaluate((element) => element.clientWidth > (element.parentElement?.clientWidth ?? 0) / 2),
        true,
      );
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
        await input.fill("Note returned on retry");
        await input.press("Enter");
        await dialog.getByRole("button", { name: "Check outcome" }).click();
        await dialog.getByText("Note returned on retry", { exact: true }).waitFor();
        assert.equal(writeKeys.length, 2);
        assert.equal(writeKeys[0], writeKeys[1]);
        const summary = dialog.getByRole("textbox", { name: "Follow-up", exact: true });
        await summary.fill("Send the details");
        await dialog.getByLabel("Follow-up date").fill("2026-11-20");
        step.change_id++;
        step.what = "Other follow-up";
        const save = dialog.getByRole("button", { name: "Set follow-up" });
        await save.click();
        await dialog.getByText("This prospect changed while you were editing.").waitFor();
        assert.equal(await summary.inputValue(), "Send the details");
        await dialog.getByRole("button", { name: "Reload changes", exact: true }).click();
        await dialog.getByText(/Other follow-up/).waitFor();
        await save.click();
        await dialog.getByText(/Send the details · Due Fri, Nov 20/).waitFor();
        await dialog.getByRole("button", { name: "Claim", exact: true }).click();
        await dialog.getByRole("button", { name: "Hand off to Dell" }).click();
        await dialog.getByRole("button", { name: "Take ownership" }).waitFor();
        assert.equal(claimed, "dell");
        await dialog.getByRole("button", { name: "Unclaim" }).click();
        await dialog.getByRole("button", { name: "Claim", exact: true }).waitFor();
        await dialog.getByRole("button", { name: "Clear needs attention" }).click();
        await dialog.getByRole("button", { name: "Mark needs attention" }).waitFor();
        await dialog.getByText("Drop prospect", { exact: true }).click();
        await dialog.getByLabel("Reason", { exact: true }).fill("No longer looking");
        await dialog.getByRole("button", { name: "Confirm drop" }).click();
        await open.waitFor({ state: "detached" });

        const name = lane.getByRole("textbox", { name: "Prospect name" });
        const firstNote = lane.getByRole("textbox", { name: "Optional first note" });
        await name.fill("Known");
        await lane.getByRole("button", { name: "Known Example · person" }).click();
        await firstNote.fill("First conversation");
        await firstNote.press("Enter");
        await lane.getByText(/Already on a deal/).waitFor();
        assert.equal(await lane.getByRole("link", { name: "Open deal" }).getAttribute("href"), `/deals?deal=${dealId}`);
        assert.equal(await name.inputValue(), "Known Example");
        assert.equal(await firstNote.inputValue(), "First conversation");
        await name.fill("Client");
        await lane.getByRole("button", { name: "Client Example · company" }).click();
        await firstNote.press("Enter");
        await lane.getByRole("button", { name: "Add deal" }).click();
        const addDeal = page.getByRole("dialog", { name: "Add deal" });
        assert.equal(await addDeal.getByLabel("Client", { exact: true }).inputValue(), "Client Example");
        await addDeal.getByRole("button", { name: "Cancel" }).click();
        await name.fill("Example Pine Prospect");
        await lane.getByLabel("Person or company").selectOption("company");
        await lane.getByLabel("How found").selectOption("referral");
        await firstNote.press("Enter");
        await lane.getByRole("button", { name: "Example Pine Prospect" }).waitFor();
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await page.close();
    }
  }
});
