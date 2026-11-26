import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import type { Page } from "playwright";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
before(async () => {
  const outDir = temporaryDirectory("home-inbox-advance-");
  await buildArtifact({ root: process.cwd(), outDir });
  server = await ownedFixtureServer({ root: join(outDir, "site") });
});
after(() => server?.close());

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Card = Record<string, unknown> & { item_id: string; suggestions?: { id: string }[] };
const step = (n: number, title: string): Card => ({
  item_id: `next_action:${id(n)}`,
  card_id: `next_action:${id(n)}`,
  source_type: "next_action",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "The practice asked for it",
  primary_action: "Mark done",
  activity_at: "2026-11-24T15:00:00.000Z",
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Example Dental",
  open_url: `/deals?deal=${id(99)}&focus=next-step&step=${id(n)}`,
  deal_id: id(99),
  kind_label: "Task",
  action_id: id(n),
  action_version: 1,
  merged_source_ids: [id(n)],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "reminders",
});
const suggestion = (n: number, title: string, decisions = 1): Card => ({
  ...step(n, title),
  item_id: `suggestion:${id(n)}`,
  card_id: `suggestion:${id(n)}`,
  source_type: "email_proposal",
  kind_label: "Suggestion",
  primary_action: "Review suggestions",
  action_id: null,
  action_version: null,
  deal_id: null,
  open_url: null,
  suggestions: Array.from({ length: decisions }, (_, index) => ({ id: id(n * 10 + index) })),
  tile: "inbox",
});

async function openHome(t: TestContext, cards: Card[]) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Chicago" });
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(new Date("2026-11-25T16:00:00Z"));
  await page.addInitScript(() =>
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ walkthroughSeen: { joe: true } })),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route(
    (url) => url.pathname === "/" && url.searchParams.get("mode") === "live",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html ", "<html data-home-today-from-engine ");
      await route.fulfill({ response, body });
    },
  );
  const group = (tile: string) => {
    const items = cards.filter((card) => card.tile === tile && card.section !== "done");
    return { count: items.length, items };
  };
  await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-inbox.v6",
        home_mark_drop: true,
        home_proposal_drop: true,
        reminders: group("reminders"),
        inbox: group("inbox"),
        waiting: group("waiting"),
      },
    }),
  );
  await page.route("**/mcp", async (route) => {
    const call = route.request().postDataJSON();
    const { name, arguments: args } = call.params;
    let result: unknown = { ok: true, items: [], deals: [], leads: [], proposals: [] };
    if (name === "read-home-inbox-v5")
      result = {
        ok: true,
        schema_version: "home-inbox.v5",
        truncated: false,
        limit: 1000,
        working_collapsed: true,
        engine_marks: true,
        items: cards.map(({ card_id, ...card }) => card),
      };
    if (name === "end-engine-home-step") {
      cards = cards.map((card) =>
        card.action_id === args.id
          ? { ...card, section: "done", source_state: "done", completed_at: "2026-11-25T16:00:00Z", action_version: 2 }
          : card,
      );
      result = { next_step_id: args.id, status: "done", change_id: 2 };
    }
    if (name === "read-engine-home-proposal")
      result = {
        proposal_id: args.id,
        kind: "next_step",
        target_name: "Example Dental",
        what: "Send the floor plan",
        reason: "The manager asked.",
        evidence: "Can you send the plan?",
      };
    if (name === "decide-engine-home-proposal") {
      cards = cards.flatMap((card) => {
        const suggestions = card.suggestions?.filter((row) => row.id !== args.id);
        return suggestions?.length === 0 ? [] : [suggestions ? { ...card, suggestions } : card];
      });
      result = { proposal_id: args.id, status: args.decision === "accept" ? "accepted" : "dismissed" };
    }
    await route.fulfill({
      json: { jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } },
    });
  });
  await page.goto(`${server.origin}/?mode=live`);
  await page.locator("[data-inbox-row]").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));
  return page;
}

const pane = (page: Page, title: string) => page.getByRole("region", { name: `Details for ${title}` });
async function rowTitles(page: Page, tile: string) {
  return page.getByRole("region", { name: tile, exact: true }).locator("[data-inbox-row] h3").allTextContents();
}

test("Accepting an Inbox item keeps it open while decisions are left, then removes its row and opens the next one, and the last one closes the pane", async (t) => {
  const page = await openHome(t, [
    suggestion(11, "Choose the deal for Maya's email", 2),
    suggestion(12, "Send the plan to Pat"),
  ]);
  await page
    .getByRole("region", { name: "Inbox", exact: true })
    .getByRole("link", { name: "Choose the deal for Maya's email" })
    .click();
  const first = pane(page, "Choose the deal for Maya's email");
  const accept = first.getByRole("button", { name: "Accept", exact: true });
  await accept.nth(1).waitFor();
  await accept.first().click();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".home-inline-review button")).filter(
        (button) => button.textContent === "Accept",
      ).length === 1,
  );
  assert.deepEqual(await rowTitles(page, "Inbox"), ["Choose the deal for Maya's email", "Send the plan to Pat"]);
  await accept.click();
  const second = pane(page, "Send the plan to Pat");
  await second.getByRole("button", { name: "Accept", exact: true }).waitFor();
  assert.equal(await first.count(), 0);
  assert.deepEqual(await rowTitles(page, "Inbox"), ["Send the plan to Pat"]);
  await second.getByRole("button", { name: "Accept", exact: true }).click();
  await second.waitFor({ state: "detached" });
  assert.deepEqual(await rowTitles(page, "Inbox"), []);
});

test("Mark done in an opened reminder removes its row and opens the next reminder, and the last one closes the pane", async (t) => {
  const page = await openHome(t, [step(1, "Call the sample practice"), step(2, "Send the sample floor plan")]);
  await page
    .getByRole("region", { name: "Reminders", exact: true })
    .getByRole("link", { name: "Call the sample practice" })
    .click();
  const first = pane(page, "Call the sample practice");
  await first.getByRole("button", { name: "Mark done", exact: true }).click();
  const second = pane(page, "Send the sample floor plan");
  await second.waitFor();
  assert.equal(await first.count(), 0);
  assert.deepEqual(await rowTitles(page, "Reminders"), ["Send the sample floor plan"]);
  await second.getByRole("button", { name: "Mark done", exact: true }).click();
  await second.waitFor({ state: "detached" });
  assert.deepEqual(await rowTitles(page, "Reminders"), []);
});
