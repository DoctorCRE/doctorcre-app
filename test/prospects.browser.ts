import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium, settles } from "./browser-harness.mjs";

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
      const known = { id: "00000000-0000-4000-8000-000000000002", display_name: "Known Example", kind: "person" };
      const matchedClient = {
        id: "00000000-0000-4000-8000-000000000004",
        display_name: "Client Example",
        kind: "company",
      };
      const renewalLease = {
        lease_id: "00000000-0000-4000-8000-000000000010",
        address: "10 Example Road",
        expiration_on: "2031-06-01",
      };
      const storedParty = { ...matchedClient, id: "00000000-0000-4000-8000-000000000007", kind: "person" };
      const storedTwin = { ...storedParty, id: "00000000-0000-4000-8000-000000000009" };
      const missingHowFound = {
        ...storedParty,
        id: "00000000-0000-4000-8000-000000000008",
        display_name: "Example Outside Practice",
      };
      const dealId = "00000000-0000-4000-8000-000000000003";
      const newName = "Example Pine Prospect";
      let prospects = [prospect, birchProspect];
      const convertedNotes: { kind: string; text: string }[] = [];
      let conversionAttempts = 0;
      type CreatedDeal = { id: string; name: string; owner: string; phase: string; client_name: string };
      let converted: CreatedDeal | undefined;
      let conversionKey: string | undefined;
      let refuseConversion = true;
      const existingDeal = {
        id: "00000000-0000-4000-8000-000000000011",
        name: "Example Maple Deal",
        owner: actor,
        phase: "pending",
        client_name: "Example Maple",
      };
      const deals: CreatedDeal[] = [existingDeal];
      const board = { schema_version: "local-deals-board.v2", actor, deals };
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
            assert.notEqual(params.name, "new-deal", "a conversion must never reach the legacy writer");
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
                if (body.party_id === known.id)
                  return Response.json(
                    { error: "not_a_prospect", party_id: known.id, deal_ids: [dealId] },
                    { status: 409 },
                  );
                if (body.party_id === matchedClient.id)
                  return Response.json({ error: "already_client", party_id: matchedClient.id }, { status: 409 });
                assert.partialDeepStrictEqual(body, {
                  name: newName,
                  kind: "company",
                  how_found: "referral",
                  note: "First conversation",
                });
                const party_id = "00000000-0000-4000-8000-000000000005";
                prospects.push({ ...prospect, party_id, name: newName, needs_attention: false });
                return Response.json({ party_id }, { status: 201 });
              }
              if (path.endsWith("/changes")) {
                assert.equal(body.seen_change_id, prospect.change_id++);
                Object.assign(prospect, body.fields);
                return Response.json({ party_id: party, change_id: prospect.change_id });
              }
              if (path.endsWith("/drop")) {
                assert.equal(body.reason, "No longer looking");
                prospects = prospects.filter((row) => row.party_id !== party);
                return Response.json({ party_id: party, stage: "archived" });
              }
              if (path === "/api/engine/deals") {
                conversionAttempts++;
                if (body.client_id === missingHowFound.id)
                  return Response.json(
                    { error: "database_refused_the_statement", rule: "lead_or_client_how_found" },
                    { status: 422 },
                  );
                assert.deepEqual(body, {
                  idempotency_key: body.idempotency_key,
                  prospect_id: birchProspect.party_id,
                  client_id: width === 1440 ? matchedClient.id : storedParty.id,
                  name: "Example Edited Deal",
                  owner: "joe",
                  phase: "research",
                  kind: "lease",
                  ...(width === 1440
                    ? { reason: "renewal", renews_lease_id: renewalLease.lease_id }
                    : { reason: "start_up" }),
                });
                if (refuseConversion) {
                  refuseConversion = false;
                  return Response.json({ error: "not_a_prospect" }, { status: 409 });
                }
                const replay = body.idempotency_key === conversionKey;
                assert.ok(replay || !converted, "a retry must keep the original key");
                if (!replay) {
                  conversionKey = body.idempotency_key;
                  converted = {
                    id: dealId,
                    name: body.name,
                    owner: body.owner,
                    phase: body.phase,
                    client_name: matchedClient.display_name,
                  };
                  board.deals.push(converted);
                  prospects = prospects.filter((row) => row.party_id !== birchProspect.party_id);
                  if (width === 1440) return Response.json({ error: "engine_unavailable" }, { status: 503 });
                }
                return Response.json(
                  { deal_id: dealId, change_id: 24, phase_changed_at: note.at, ...(replay && { replayed: true }) },
                  { status: replay ? 200 : 201 },
                );
              }
              if (path.endsWith("/activities")) {
                if (body.about[0].deal_id) {
                  assert.deepEqual(body.about, [{ deal_id: dealId }]);
                  assert.equal(body.summary, "Edited before saving");
                  convertedNotes.push({ kind: "note", text: body.summary });
                  return Response.json({ activity_id: party }, { status: 201 });
                }
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
            if (path.endsWith("/leases"))
              return Response.json(path === `/api/engine/clients/${matchedClient.id}/leases` ? [renewalLease] : []);
            if (path.endsWith("/parties/search")) {
              const params = new URL(request.url).searchParams;
              const query = params.get("query");
              assert.equal(params.has("role"), false);
              if (query === "Knownx") return Response.json({ error: "engine_unavailable" }, { status: 503 });
              return Response.json({
                parties: [known, matchedClient, storedParty, storedTwin, missingHowFound].filter((match) =>
                  match.display_name.startsWith(query ?? ""),
                ),
              });
            }
            if (path === `/api/engine/deals/${dealId}`)
              return Response.json({ ...converted, deal_id: dealId, email_follow_ups: [], thread: convertedNotes });
            if (path.endsWith("/prospects")) {
              return savesEnabled
                ? Response.json({ count: prospects.length, prospects })
                : Response.json({ error: "engine_unavailable" }, { status: 503 });
            }
            if (path.endsWith(birchProspect.party_id))
              return converted
                ? new Response(null, { status: 404 })
                : Response.json({
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
      const birchName = page.getByRole("button", { name: birchProspect.name, exact: true });
      const birchDetail = page.getByRole("dialog", { name: birchProspect.name });
      const turn = birchDetail.getByRole("button", { name: "Turn into deal" });
      await page.goto(`${server.origin}/deals?mode=live`);
      await page
        .locator("#boardAsOf")
        .filter({ hasText: /^Updated / })
        .waitFor();
      const lane = page.locator("#prospectsLane");
      const loadError = page.getByRole("alert").filter({ hasText: "Could not load prospects." });
      assert.equal(await lane.count(), 0, `Prospects lane should be absent at ${width}px before the switch`);
      assert.equal(await loadError.count(), 0);
      assert.equal(await turn.count(), 0);
      for (const suffix of ["", `/${party}`, "/search?query=Example"]) {
        const response = await worker.fetch(new Request(`${server.origin}/api/engine/prospects${suffix}`), env);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "not_found" });
      }

      const blockedConversion = await worker.fetch(
        new Request(`${server.origin}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-carr-csrf": session.csrf_token },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "new-deal",
              arguments: { prospect_id: birchProspect.party_id },
            },
          }),
        }),
        env,
      );
      const { result } = await blockedConversion.json();
      assert.equal(JSON.parse(result.content[0].text).error, "reload_deals");

      savesEnabled = true;
      await page.reload();
      const open = page.getByRole("button", { name: "Example Elm Practice" });
      await open.waitFor();
      assert.equal(await open.count(), 1);
      assert.equal(await loadError.count(), 0);
      assert.equal(
        await page
          .locator("#kanban")
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
        width === 390 ? 1 : 8,
      );
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
        assert.match((await lane.textContent()) ?? "", /Doc \(assistant\) · Wed, Nov 18(?:,| at) 9:40 AM/);
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
      const prospectNames = [prospect.name, birchProspect.name];
      const entries = lane.getByRole("article");
      const deal = page.getByRole("button", { name: existingDeal.name, exact: true });
      await deal.waitFor();
      assert.equal(
        await deal.evaluate((button) => button.closest("[data-column]")?.previousElementSibling?.id),
        "prospectsLane",
      );
      const titles = () => entries.getByRole("heading").allTextContents();
      assert.deepEqual(await titles(), prospectNames);
      const tileRadius = await entries.first().evaluate((entry) => getComputedStyle(entry).borderRadius);
      assert.notEqual(tileRadius, "0px");
      const tileText = await entries.allTextContents();
      await page.screenshot({ path: `out/test-artifacts/prospect-list-rows/board-${width}.png` });

      const list = page.getByRole("button", { name: "List", exact: true });
      await list.click();
      await settles(async () =>
        assert.equal(await entries.first().evaluate((entry) => getComputedStyle(entry).borderRadius), "0px"),
      );
      assert.deepEqual(await titles(), prospectNames);
      assert.deepEqual(await entries.allTextContents(), tileText);
      const dealBox = await deal.boundingBox();
      const prospectBox = await entries.first().boundingBox();
      assert.ok(dealBox && prospectBox && dealBox.y + dealBox.height <= prospectBox.y);
      const titleBox = await open.boundingBox();
      const noteBox = await entries.first().getByText("First line", { exact: true }).boundingBox();
      assert.ok(titleBox && noteBox);
      if (width === 1440) assert.ok(noteBox.x >= titleBox.x + titleBox.width);
      else assert.ok(noteBox.y >= titleBox.y + titleBox.height);
      if (width === 390) await entries.first().evaluate((entry) => entry.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `out/test-artifacts/prospect-list-rows/list-${width}.png` });
      await birchName.click();
      await birchDetail.getByText("Claimed by Dell", { exact: true }).waitFor();
      await birchDetail.getByRole("button", { name: "Back to Deals" }).click();
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Example Elm Practice" });
      await dialog.waitFor();
      assert.match((await dialog.textContent()) ?? "", /Referral[\s\S]*Call again[\s\S]*First line/);
      await dialog.getByRole("button", { name: "Back to Deals" }).click();
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await settles(async () =>
        assert.equal(await entries.first().evaluate((entry) => getComputedStyle(entry).borderRadius), tileRadius),
      );
      assert.deepEqual(await titles(), prospectNames);
      await list.click();
      await open.click();
      await dialog.getByRole("button", { name: "Turn into deal" }).click();
      const unclaimedForm = page.getByRole("dialog", { name: "Add deal" });
      const unclaimedOwner = unclaimedForm.getByLabel("Owner");
      assert.equal(await unclaimedOwner.inputValue(), "");
      assert.equal(await unclaimedOwner.evaluate((control) => control.matches(":invalid")), true);
      await unclaimedForm.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor();
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

      const claim = dialog.getByRole("button", { name: "Claim", exact: true });
      const reason = dialog.getByLabel("Reason", { exact: true });
      const drop = dialog.getByRole("button", { name: "Drop prospect", exact: true });
      const background = (button: HTMLElement) => getComputedStyle(button).backgroundColor;
      await settles(async () => assert.equal(await drop.evaluate(background), await claim.evaluate(background)));
      assert.equal(await reason.isVisible(), false);
      await claim.click();
      await dialog.getByRole("button", { name: "Hand off to Dell" }).click();
      await dialog.getByText(/^Claimed by Dell/).waitFor();
      await dialog.getByRole("button", { name: "Unclaim" }).click();
      await claim.waitFor();
      await dialog.getByRole("button", { name: "Clear needs attention" }).click();
      await dialog.getByRole("button", { name: "Mark needs attention" }).click();
      await dialog.getByRole("button", { name: "Clear needs attention" }).waitFor();
      await drop.click();
      await reason.fill("No longer looking");
      await dialog.getByRole("button", { name: "Confirm drop" }).click();
      await open.waitFor({ state: "detached" });

      const name = lane.getByRole("textbox", { name: "Prospect name" });
      const noteInput = lane.getByRole("textbox", { name: "Optional first note" });
      if (width === 1440) {
        const known = lane.getByRole("button", { name: "Known Example · person" });
        await name.fill("Known");
        await known.waitFor();
        const failedSearch = page.waitForResponse((response) => response.url().includes("query=Knownx"));
        await name.fill("Knownx");
        assert.equal((await failedSearch).status(), 503);
        await known.waitFor({ state: "hidden" });
        await name.fill("Known");
        await known.click();
        await noteInput.fill("First conversation");
        await noteInput.press("Enter");
        const deal = lane.getByRole("link", { name: "Open deal" });
        await deal.waitFor();
        assert.equal(await deal.getAttribute("href"), `/deals?deal=${dealId}`);
        assert.equal(await name.inputValue(), "Known Example");
        assert.equal(await noteInput.inputValue(), "First conversation");
        await name.fill("Client");
        await lane.getByRole("button", { name: "Client Example · company" }).click();
        await noteInput.press("Enter");
        await lane.getByRole("button", { name: "Add deal" }).click();
        const addDeal = page.getByRole("dialog", { name: "Add deal" });
        assert.equal(
          await addDeal.getByRole("textbox", { name: "Client", exact: true }).inputValue(),
          "Client Example",
        );
        assert.equal(await addDeal.getByLabel("Deal name").inputValue(), "Client Example");
        await addDeal.getByLabel("Phase", { exact: true }).waitFor();
        await addDeal.getByLabel("Deal kind", { exact: true }).waitFor();
        await addDeal
          .getByLabel("Deal reason", { exact: true })
          .locator("option")
          .filter({ hasText: /^Start-up$/ })
          .waitFor({ state: "attached" });
        await addDeal.getByRole("button", { name: "Cancel" }).click();
      }
      await name.fill(newName);
      await noteInput.fill("First conversation");
      const person = lane.getByRole("button", { name: "Person", exact: true });
      const company = lane.getByRole("button", { name: "Company", exact: true });
      const add = lane.getByRole("button", { name: "Add prospect", exact: true });
      assert.equal((await name.boundingBox())?.y === (await add.boundingBox())?.y, width === 1440);
      await person.click();
      assert.equal(await person.getAttribute("aria-pressed"), "true");
      await company.click();
      assert.equal(await person.getAttribute("aria-pressed"), "false");
      const howFound = lane.getByLabel("How found");
      await howFound.selectOption("referral");
      await noteInput.press("Enter");
      await lane.getByRole("button", { name: newName }).waitFor();
      const saved = lane.getByText("Prospect saved", { exact: true });
      await saved.waitFor();
      await name.focus();
      await saved.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole("button", { name: "All", exact: true }).click();
      await birchName.click();
      await birchDetail.getByRole("heading", { name: "Notes" }).waitFor();
      assert.equal(await birchDetail.getByText("First line Second line", { exact: true }).count(), 2);
      assert.equal(await turn.isVisible(), true);
      await turn.click();
      const form = page.getByRole("dialog", { name: "Add deal" });
      const nameField = form.getByLabel("Deal name");
      const clientField = form.getByRole("textbox", { name: "Client", exact: true });
      const ownerField = form.getByLabel("Owner");
      const phaseField = form.getByLabel("Phase");
      const notesField = form.getByLabel("Notes");
      const dealKind = form.getByLabel("Deal kind", { exact: true });
      const dealReason = form.getByLabel("Deal reason", { exact: true });
      await dealKind.waitFor();
      await dealReason
        .locator("option")
        .filter({ hasText: /^Start-up$/ })
        .waitFor({ state: "attached" });
      assert.equal(await form.getByLabel("Type", { exact: true }).isVisible(), false);
      const save = form.getByRole("button", { name: "Create deal" });
      assert.equal(await nameField.inputValue(), birchProspect.name);
      assert.equal(await notesField.inputValue(), note.summary);
      assert.equal(await ownerField.inputValue(), "dell");
      assert.equal(await phaseField.inputValue(), "");
      assert.equal(await clientField.inputValue(), "");
      assert.equal(await form.evaluate((element) => element.getBoundingClientRect().width <= innerWidth), true);
      await nameField.fill("Example Edited Deal");
      await notesField.fill("Edited before saving");
      await ownerField.selectOption("joe");
      await dealKind.selectOption("lease");
      if (width === 1440) {
        assert.equal(
          await form.evaluate((dialog) => {
            const body = dialog.querySelector(".dialog-body");
            const fields = dialog.querySelector("fieldset");
            if (!body || !fields) return false;
            const offset = fields.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
            return Math.abs(offset - Number.parseFloat(getComputedStyle(body).paddingTop)) < 1;
          }),
          true,
          "an empty alert leaves no gap above the form",
        );
        await dealReason.selectOption("renewal");
        await form.getByRole("button", { name: `Use ${birchProspect.name} as client` }).click();
        await form.getByText("No leases found for this client.").waitFor();
        await clientField.fill("Client Ex");
        await form.getByRole("button", { name: "Client Example · Company" }).click();
        const lease = form.getByLabel("Lease to renew");
        await lease.locator("option").filter({ hasText: "10 Example Road · Expires Sun, Jun 1, 2031" }).waitFor({
          state: "attached",
        });
        await phaseField.selectOption("Research");
        await save.click();
        assert.equal(conversionAttempts, 0, "a renewal must name a lease");
        await lease.selectOption(renewalLease.lease_id);
        await phaseField.selectOption("");
      } else {
        await dealReason.selectOption("start_up");
        await clientField.fill("Clint Example");
        await form.getByText("No matching people or companies.").waitFor({ timeout: 5000 });
        await clientField.fill("Client Ex");
        await form.getByRole("button", { name: "Client Example · Company" }).waitFor({ timeout: 5000 });
        await form.getByRole("button", { name: `Client Example · Person · ${storedTwin.id}`, exact: true }).waitFor();
        assert.equal(
          await form.getByRole("list", { name: "Matching people and companies" }).evaluate((list) => {
            const right = list.closest("dialog")?.getBoundingClientRect().right ?? 0;
            return [...list.querySelectorAll("button")].every(
              (button) => button.getBoundingClientRect().right <= right,
            );
          }),
          true,
          "each client match fits inside the dialog",
        );
        await form.getByRole("button", { name: `Client Example · Person · ${storedParty.id}`, exact: true }).click();
        assert.equal(await clientField.inputValue(), storedParty.display_name);
      }
      await save.click();
      assert.equal(conversionAttempts, 0, "phase must be chosen");
      await phaseField.selectOption("Research");

      savesEnabled = false;
      await save.click();
      await form.getByText("Reload Deals before adding a deal.").waitFor();
      assert.equal(conversionAttempts, 0);
      savesEnabled = true;
      if (width === 390) {
        await clientField.fill("Example Outside");
        await form.getByRole("button", { name: "Example Outside Practice · Person" }).click();
        await save.click();
        await form.getByText("Record how you found this person or company before using them as a client.").waitFor();
        await clientField.fill("Client Ex");
        await save.click();
        await form.getByText("Choose a client from the matches.").waitFor();
        assert.equal(conversionAttempts, 1, "typing a name does not pick a client");
        await form.getByRole("button", { name: `Client Example · Person · ${storedParty.id}`, exact: true }).click();
      }
      await save.click();
      await form.getByText("This person or company is no longer a prospect.").waitFor();
      assert.equal(await nameField.inputValue(), "Example Edited Deal");
      assert.equal(await notesField.inputValue(), "Edited before saving");
      await save.click();
      if (width === 1440) await form.getByRole("button", { name: "Check creation outcome" }).click();
      await page.getByRole("heading", { name: "Example Edited Deal", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("deal"), dealId);
      await page.locator("#workspaceFacts").getByText(matchedClient.display_name).waitFor();
      assert.equal(await birchDetail.count(), 0);
      await page.getByRole("tab", { name: "Correspondence & notes" }).click();
      const dealNote = page
        .getByRole("region", { name: "Deal notes" })
        .getByText("Edited before saving", { exact: true });
      await dealNote.waitFor();
      assert.equal(await dealNote.count(), 1);
      assert.equal(conversionAttempts, 3);
      assert.equal(convertedNotes.length, 1);
      await page.getByRole("button", { name: "Back to deals" }).click();
      await page
        .locator("#boardLive")
        .getByText(/ · 1 prospect$/)
        .waitFor();
      assert.equal(await birchName.count(), 0);
      assert.equal(await lane.getByRole("heading", { name: "Prospects 1" }).count(), 1);
    } finally {
      await page.close();
    }
  }
});
