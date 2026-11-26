import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
before(async () => {
  const outDir = temporaryDirectory("home-drop-chips-");
  await buildArtifact({ root: process.cwd(), outDir });
  server = await ownedFixtureServer({ root: join(outDir, "site") });
});
after(() => server?.close());

const today = "2026-11-26";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const stepCard = (n: number, title: string) => ({
  item_id: `next_action:${id(n)}`,
  card_id: `next_action:${id(n)}`,
  source_type: "next_action",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "Sample practice asked for an update",
  primary_action: "Mark done",
  activity_at: "2026-11-25T15:00:00.000Z",
  completed_at: null,
  due_on: today,
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

const filingCard = (n: number, title: string) => ({
  item_id: `suggestion:${id(n)}`,
  card_id: `suggestion:${id(n)}`,
  source_type: "email_proposal",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "Mentions the sample lease renewal",
  primary_action: "Review filing",
  activity_at: "2026-11-25T15:30:00.000Z",
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Maya Example",
  open_url: null,
  deal_id: null,
  kind_label: "Suggestion",
  action_id: null,
  action_version: null,
  merged_source_ids: [id(n)],
  suggestions: [{ id: id(n), kind: "file_to_deal", activity_kind: "email", activity_id: id(90) }],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "inbox",
});

const draftCard = (draftId: number, proposalId: number, title: string) => ({
  item_id: `reply_draft:${id(draftId)}`,
  card_id: `reply_draft:${id(draftId)}`,
  source_type: "email_proposal",
  source_id: id(draftId),
  source_version: "3",
  base_version: "3:0:inbox",
  source_state: "needs_attention",
  title,
  why: "Reply ready to review",
  primary_action: "Open",
  activity_at: "2026-11-25T16:00:00.000Z",
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Sam Example",
  open_url: null,
  deal_id: null,
  kind_label: "Reply draft",
  action_id: null,
  action_version: null,
  merged_source_ids: [id(draftId), id(proposalId)],
  reply_draft_id: id(draftId),
  reply_draft_status: "pending",
  suggestions: [{ id: id(proposalId), kind: "phase_move", activity_kind: "email", activity_id: id(91) }],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "inbox",
});

const group = (items: unknown[]) => ({ count: items.length, items });

async function openDropHome(
  t: TestContext,
  options: {
    width?: number;
    height?: number;
    reasonsByCategory?: Record<string, string[] | "fail">;
  } = {},
) {
  const {
    width = 1440,
    height = 900,
    reasonsByCategory = {
      next_step: [
        "Client paused",
        "Already handled",
        "Not needed",
        "Duplicate",
        "Not ours to do",
        "Sixth reason hidden",
      ],
      filing: ["Not about a deal", "Not business", "Spam", "Already filed"],
      reply_draft: ["Already replied", "No reply needed", "Replying myself"],
      phase_move: ["Phase is right", "Too early", "Already moved"],
    },
  } = options;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: "America/Chicago" });
  await page.clock.setFixedTime(new Date("2026-11-26T16:00:00Z"));
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

  const reminders = [stepCard(1, "Call the sample landlord"), stepCard(2, "Send the sample floor plan")];
  const inbox = [
    filingCard(11, "Choose the deal for Maya's email"),
    draftCard(12, 13, "Send your reply to Sam Example"),
  ];
  const reasonReads: string[] = [];
  const writes: Array<{ name: string; args: Record<string, unknown> }> = [];

  await page.route("**/api/engine/home/drop-reasons*", (route) => {
    const category = new URL(route.request().url()).searchParams.get("category") ?? "";
    reasonReads.push(category);
    const configured = reasonsByCategory[category];
    if (configured === "fail") return route.fulfill({ status: 500, json: { error: "unavailable" } });
    return route.fulfill({ json: { category, reasons: configured ?? [] } });
  });
  await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-inbox.v6",
        home_mark_drop: true,
        home_proposal_drop: true,
        reminders: group(reminders),
        inbox: group(inbox),
        waiting: group([]),
      },
    }),
  );
  await page.route("**/api/engine/home/today", (route) =>
    route.fulfill({
      json: { ok: true, schema_version: "home-today.v1", today, viewer: null, meetings: { state: "empty", items: [] } },
    }),
  );
  await page.route("**/api/engine/weekly-reviews?*", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/engine/calendar/critical-dates", (route) =>
    route.fulfill({ json: { schema_version: "calendar-critical-dates.v1", critical_dates: [] } }),
  );
  await page.route("**/mcp", async (route) => {
    const call = route.request().postDataJSON();
    const { name, arguments: args } = call.params;
    let payload: unknown = {};
    if (name === "read-home-inbox-v5") {
      payload = {
        ok: true,
        schema_version: "home-inbox.v5",
        engine_marks: true,
        home_mark_drop: true,
        home_proposal_drop: true,
        truncated: false,
        limit: 1000,
        working_collapsed: true,
        items: [...reminders, ...inbox],
      };
    } else if (name === "end-engine-home-step") {
      writes.push({ name, args });
      const index = reminders.findIndex((row) => row.action_id === args.id);
      if (index >= 0) reminders.splice(index, 1);
      payload = { next_step_id: args.id, status: "cancelled", change_id: 2 };
    } else if (name === "decide-engine-home-proposal") {
      writes.push({ name, args });
      const index = inbox.findIndex((row) => row.source_id === args.id);
      if (index >= 0) inbox.splice(index, 1);
      for (const row of inbox) {
        if ("suggestions" in row && Array.isArray(row.suggestions)) {
          row.suggestions = row.suggestions.filter((entry) => entry.id !== args.id);
        }
      }
      payload = { proposal_id: args.id, status: "dismissed" };
    } else if (name === "read-engine-home-draft") {
      payload = {
        draft_id: id(12),
        subject: "Re: Sample tour",
        body: "Thanks, we will send the updated plan.",
        version: 3,
        status: "pending",
        to: "sam@example.test",
        cc: "partner@example.test",
        attachments: [],
        source_activity: { id: id(91), subject: "Sample tour" },
        thread: [
          {
            activity_id: id(91),
            happened_at: "2026-11-25T15:00:00Z",
            sender_name: "Sam Example",
            body: "Can you share the updated plan?",
            folded: null,
          },
        ],
      };
    } else if (name === "read-engine-home-proposal") {
      payload = {
        proposal_id: id(13),
        kind: "phase_move",
        target_name: "Example Dental",
        to_phase: "Legal",
        evidence: "Landlord sent the lease draft.",
        source_activity: { kind: "email", id: id(91), subject: "Sample tour" },
        thread: [],
      };
    } else if (name === "dismiss-engine-home-draft") {
      writes.push({ name, args });
      const index = inbox.findIndex((row) => row.source_id === args.id);
      if (index >= 0) inbox.splice(index, 1);
      payload = { draft_id: args.id, status: "dismissed", version: 4 };
    } else if (name === "deal-room-board") {
      payload = { board_from_engine: true, deals: [] };
    } else if (name === "lead-board") {
      payload = { schema_version: "lead-workspace.v1", generated_at: "2026-11-26T15:00:00Z", leads: [] };
    } else {
      payload = { schema_version: "quiet-follow-ups.v1", proposals: [], sent: false, tasks_created: false };
    }
    await route.fulfill({
      json: { jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
    });
  });

  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole("region", { name: "Reminders", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));
  return { page, reasonReads, writes };
}

test("Drop renders up to five chips from the stubbed read, saves on one tap, and fetches once per category", async (t) => {
  const { page, reasonReads, writes } = await openDropHome(t);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const dialog = page.getByRole("dialog", { name: "Drop with a reason" });

  // Reminders row 1: chips appear (capped at 5), fine-pointer height is 28-32px, one tap saves.
  const firstStep = reminders.locator("[data-inbox-row]").filter({ hasText: "Call the sample landlord" });
  await firstStep.getByRole("button", { name: "Drop", exact: true }).click();
  const chips = dialog.getByRole("group", { name: "Common reasons" }).getByRole("button");
  await chips.first().waitFor();
  assert.deepEqual(await chips.allTextContents(), [
    "Client paused",
    "Already handled",
    "Not needed",
    "Duplicate",
    "Not ours to do",
  ]);
  const chipHeight = (await chips.first().boundingBox())?.height ?? 0;
  assert.ok(chipHeight >= 28 && chipHeight <= 32, `fine-pointer chip height is ${chipHeight}px`);
  await chips.getByText("Client paused", { exact: true }).click();
  await firstStep.waitFor({ state: "detached" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.name, "end-engine-home-step");
  assert.equal(writes[0]?.args.reason, "Client paused");

  // Reminders row 2 (same category): no second fetch, typing still works.
  const secondStep = reminders.locator("[data-inbox-row]").filter({ hasText: "Send the sample floor plan" });
  await secondStep.getByRole("button", { name: "Drop", exact: true }).click();
  await chips.first().waitFor();
  assert.equal(
    reasonReads.filter((category) => category === "next_step").length,
    1,
    "next_step is fetched once per page load",
  );
  await dialog.getByLabel("Reason for dropping").fill("Site was leased");
  await dialog.getByRole("button", { name: "Drop", exact: true }).click();
  await secondStep.waitFor({ state: "detached" });
  assert.equal(writes[1]?.args.reason, "Site was leased");

  // Inbox row (filing suggestion): Drop works without opening the item and uses the filing category.
  const filingRow = inbox.locator("[data-inbox-row]").filter({ hasText: "Choose the deal for Maya's email" });
  await filingRow.getByRole("button", { name: "Drop", exact: true }).click();
  await chips.getByText("Not about a deal", { exact: true }).click();
  await filingRow.waitFor({ state: "detached" });
  assert.equal(writes[2]?.name, "decide-engine-home-proposal");
  assert.equal(writes[2]?.args.reason, "Not about a deal");

  // Opened item: reply draft and phase_move suggestion each use their own category chips.
  await inbox.getByRole("link", { name: "Send your reply to Sam Example" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to Sam Example" });
  await details.getByRole("button", { name: "Send reply", exact: true }).waitFor();
  const suggestionSection = details.getByRole("region", { name: "Deal progress" });
  await suggestionSection.getByRole("button", { name: "Drop", exact: true }).click();
  await chips.getByText("Too early", { exact: true }).click();
  await suggestionSection.waitFor({ state: "detached" });
  assert.equal(writes[3]?.name, "decide-engine-home-proposal");
  assert.equal(writes[3]?.args.reason, "Too early");

  await details.getByRole("button", { name: "Drop", exact: true }).click();
  await chips.getByText("Already replied", { exact: true }).click();
  await details.waitFor({ state: "detached" });
  assert.equal(writes[4]?.name, "dismiss-engine-home-draft");
  assert.equal(writes[4]?.args.reason, "Already replied");
  assert.deepEqual(reasonReads, ["next_step", "filing", "phase_move", "reply_draft"]);
});

test("When the drop-reasons read fails, Drop shows only the text box with no error text", async (t) => {
  const { page, writes } = await openDropHome(t, { reasonsByCategory: { next_step: "fail" } });
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const row = reminders.locator("[data-inbox-row]").filter({ hasText: "Call the sample landlord" });
  const failedRead = page.waitForResponse((response) => response.url().includes("/api/engine/home/drop-reasons"));
  await row.getByRole("button", { name: "Drop", exact: true }).click();
  assert.equal((await failedRead).status(), 500);
  const dialog = page.getByRole("dialog", { name: "Drop with a reason" });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("group", { name: "Common reasons" }).count(), 0);
  assert.equal(await dialog.getByRole("alert").count(), 0);
  assert.equal(await dialog.getByRole("status").count(), 0);
  assert.equal(await dialog.getByRole("button").count(), 2);
  await dialog.getByLabel("Reason for dropping").fill("Typed fallback reason");
  await dialog.getByRole("button", { name: "Drop", exact: true }).click();
  await row.waitFor({ state: "detached" });
  assert.equal(writes[0]?.args.reason, "Typed fallback reason");
});
