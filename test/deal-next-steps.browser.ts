import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const shots = "out/test-artifacts/deal-next-steps";
await mkdir(shots, { recursive: true });
const dealId = "00000000-0000-4000-8000-00000000d160";
const stepId = "00000000-0000-4000-8000-00000000a101";
const suggestionId = "00000000-0000-4000-8000-00000000b101";
const filingId = "00000000-0000-4000-8000-00000000b102";
const emailId = "00000000-0000-4000-8000-00000000e101";
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };
const body = [
  "Thanks for the two offers. Example Row is still our first choice.",
  "One thing before we answer. Our lender cannot fund until late February. Can the rent start move to March?",
  "Best,\nMorgan Example\nExample Dental | 555-010-0199 | morgan@example.test",
  "From: Joe <joe@example.test>\nSent: Monday\nSubject: Offers",
].join("\n\n");

async function openDeal(
  t: TestContext,
  viewport: { width: number; height: number },
  theme: "light" | "dark",
  { holdEmail = false } = {},
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { CARR: { fetch: async () => Response.json(session) }, ENGINE_ROUTING: { get: async () => "on" } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  await page.addInitScript(
    (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
    theme,
  );
  await page.clock.setFixedTime(new Date("2026-11-25T17:00:00Z"));
  const writes: [string, unknown][] = [];
  const emailReads: string[] = [];
  let releaseEmail = () => {};
  const emailHeld = holdEmail ? new Promise<void>((resolve) => (releaseEmail = resolve)) : Promise.resolve();
  const email = {
    activity_id: emailId,
    sender_name: "Morgan Example",
    subject: "Offers",
    happened_at: "2026-11-24T15:12:00Z",
    summary: "The client asks whether rent can start in March.",
  };
  let suggestions = [
    {
      proposal_id: suggestionId,
      kind: "next_step",
      title: "Ask the landlord whether rent can start in March",
      what: "Ask the landlord whether rent can start in March",
      owner: "dell",
      due_on: "2026-11-27",
      email,
    },
    { proposal_id: filingId, kind: "file_to_deal", title: "File Morgan's email", email },
  ];
  let steps = [
    {
      id: stepId,
      owner: "dell",
      description: "Call the landlord's broker about the counter",
      due_on: "2026-11-24",
      status: "open",
      change_id: 3,
      set_on: "2026-11-18",
    },
  ];
  const deal = () => ({
    id: dealId,
    deal_id: dealId,
    name: "Example Harbor Dental, second office",
    client_name: "Example Harbor Dental",
    phase: "negotiating",
    owner: "joe",
    seen: 4 + writes.length,
    kind: "lease",
    next_deal_saves: true,
    next_actions: steps,
    critical_dates: [],
    vendors: [],
    email_follow_ups: suggestions,
    correspondence: [],
    documents: [],
  });
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "staging",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const decided = /^\/api\/engine\/proposals\/([^/]+)\/decision$/.exec(path);
        if (request.method === "POST" && decided) {
          const { idempotency_key: _key, ...decision } = await request.json();
          writes.push([path, decision]);
          suggestions = suggestions.filter((row) => row.proposal_id !== decided[1]);
          return Response.json({
            proposal_id: decided[1],
            status: decision.decision === "accept" ? "accepted" : "dismissed",
          });
        }
        if (request.method === "POST" && path === `/api/engine/next-steps/${stepId}/end`) {
          const { idempotency_key: _key, ...end } = await request.json();
          writes.push([path, end]);
          steps = [];
          return Response.json({ next_step_id: stepId, status: "done", change_id: 4 });
        }
        if (path === `/api/engine/proposals/${suggestionId}` || path === `/api/engine/proposals/${filingId}`) {
          emailReads.push(path);
          await emailHeld;
          return Response.json({
            thread: [{ activity_id: emailId, happened_at: email.happened_at, sender_name: email.sender_name, body }],
            source_activity: { subject: email.subject },
          });
        }
        if (path === `/api/engine/deals/${dealId}`) return Response.json(deal());
        if (path === "/api/engine/deals")
          return Response.json({ schema_version: "local-deals-board.v2", actor: "joe", deals: [deal()] });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
  await page.route(/\/(mcp|api\/engine\/.*)$/, async (route) => {
    const request = route.request();
    const posted = request.postData();
    const reply = await worker.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(posted === null ? {} : { body: posted }),
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
  const tile = page.getByRole("region", { name: "Next steps", exact: true });
  if (!holdEmail)
    await tile.getByText("Our lender cannot fund until late February", { exact: false }).first().waitFor();
  return { page, tile, writes, emailReads, releaseEmail };
}

for (const [width, height] of [
  [1440, 772],
  [1280, 640],
  [500, 900],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`Next steps lists open and suggested steps with the cleaned email at ${width} ${scheme}`, async (t) => {
      const { page, tile } = await openDeal(t, { width, height }, scheme);
      await tile.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `${shots}/next-steps-${width}-${scheme}.png` });
      assert.deepEqual(
        await tile.getByRole("heading").allTextContents(),
        ["Next steps", "Open", "Suggested", "Ask the landlord whether rent can start in March", "File Morgan's email"],
        "one tile, open then suggested",
      );
      assert.equal(await page.getByText("Email follow-ups", { exact: true }).count(), 0, "no Email follow-ups heading");
      const open = tile.getByRole("list", { name: "Open steps" });
      await open.getByText("Dell · Due Tue, Nov 24, 2026 · 1 day late", { exact: false }).waitFor();
      const suggestion = tile.getByRole("listitem", { name: "Ask the landlord whether rent can start in March" });
      await suggestion.getByText("From Morgan's email, Tue, Nov 24 · For Dell · Due", { exact: false }).waitFor();
      assert.deepEqual(await suggestion.getByRole("button").allTextContents(), ["Accept", "Edit", "Dismiss"]);
      const mail = suggestion.locator(".deal-suggestion-email");
      assert.deepEqual(await mail.locator("p").allTextContents(), [
        "From Morgan · Tue, Nov 24, 9:12 AM",
        "Thanks for the two offers. Example Row is still our first choice.",
        "One thing before we answer. Our lender cannot fund until late February. Can the rent start move to March?",
        "Best,\nMorgan Example",
      ]);
      assert.doesNotMatch(
        (await tile.textContent()) ?? "",
        /555-010|Sent: Monday|@example\.test/,
        "no signature or quoted history",
      );
      const filing = tile.getByRole("listitem", { name: "File Morgan's email" });
      assert.equal(await filing.locator(".deal-suggestion-email").count(), 0, "an email shows once");
      assert.deepEqual(await filing.getByRole("button").allTextContents(), ["Accept", "Dismiss"], "only a step edits");
      const addStep = await tile.getByText("Add step", { exact: true }).boundingBox();
      const heading = await tile.getByRole("heading", { name: "Next steps" }).boundingBox();
      assert.ok(addStep && heading && Math.abs(addStep.y - heading.y) <= 12, "Add step sits in the tile's corner");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, "no sideways page scroll");
    });

test("Edit changes a suggestion's wording and date before Accept, and the circle marks a step done", async (t) => {
  const { tile, writes } = await openDeal(t, { width: 1440, height: 772 }, "dark");
  const suggestion = tile.getByRole("listitem", { name: "Ask the landlord whether rent can start in March" });
  assert.equal(await suggestion.getByLabel("Next step").isVisible(), false, "wording shows only after Edit");
  await suggestion.getByRole("button", { name: "Edit" }).click();
  await suggestion.getByLabel("Next step").fill("Ask the landlord about a March rent start");
  await suggestion.getByLabel("Due date").fill("2026-11-30");
  await suggestion.getByRole("button", { name: "Accept" }).click();
  await suggestion.waitFor({ state: "detached" });
  await tile.getByRole("listitem", { name: "File Morgan's email" }).getByRole("button", { name: "Dismiss" }).click();
  await tile.getByText("Suggested", { exact: true }).waitFor({ state: "detached" });
  await tile.getByRole("button", { name: "Done" }).click();
  await tile.getByText("No next step set.", { exact: true }).waitFor();
  assert.deepEqual(writes, [
    [
      `/api/engine/proposals/${suggestionId}/decision`,
      {
        decision: "accept",
        edits: { what: "Ask the landlord about a March rent start", due_on: "2026-11-30" },
      },
    ],
    [`/api/engine/proposals/${filingId}/decision`, { decision: "dismiss" }],
    [`/api/engine/next-steps/${stepId}/end`, { resolution: "done", base_version: 3 }],
  ]);
});

for (const [width, height] of [
  [1440, 772],
  [500, 900],
] as const)
  test(`Edit opens the wording across the row at ${width}, and Cancel or Escape put the suggestion back`, async (t) => {
    const { page, tile } = await openDeal(t, { width, height }, "light");
    const suggestion = tile.getByRole("listitem", { name: "Ask the landlord whether rent can start in March" });
    const titleBox = () =>
      suggestion.evaluate((element) => {
        const [row, title] = [element, element.querySelector("h3")].map((node) => node?.getBoundingClientRect());
        return row && title && [title.x - row.x, title.y - row.y, title.width, title.height];
      });
    const before = await titleBox();
    await suggestion.getByRole("button", { name: "Edit" }).click();
    const wording = suggestion.getByLabel("Next step");
    await suggestion.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${shots}/edit-${width}.png` });
    const [field, row] = [await wording.boundingBox(), await suggestion.boundingBox()];
    assert.ok(field && row && field.width >= row.width * 0.55, "the wording gets the row");
    assert.ok(
      await wording.evaluate((input: HTMLInputElement) => input.scrollWidth <= input.clientWidth),
      "wording not cut",
    );
    assert.deepEqual(await titleBox(), before, "the title stays put");
    assert.deepEqual(await suggestion.getByRole("button").allTextContents(), ["Accept", "Cancel", "Dismiss"]);
    await wording.fill("Something else");
    await suggestion.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await wording.isVisible(), false, "Cancel closes the editor");
    assert.deepEqual(await suggestion.getByRole("button").allTextContents(), ["Accept", "Edit", "Dismiss"]);
    await suggestion.getByRole("button", { name: "Edit" }).click();
    assert.equal(
      await wording.inputValue(),
      "Ask the landlord whether rent can start in March",
      "Cancel keeps the wording",
    );
    await wording.fill("Something else");
    await suggestion.getByLabel("Due date").fill("2026-12-04");
    await wording.press("Escape");
    assert.equal(await wording.isVisible(), false, "Escape closes the editor");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit", "focus returns to Edit");
    await suggestion.getByRole("button", { name: "Edit" }).click();
    assert.equal(
      await wording.inputValue(),
      "Ask the landlord whether rent can start in March",
      "Escape keeps the wording",
    );
    assert.equal(await suggestion.getByLabel("Due date").inputValue(), "2026-11-27", "Escape keeps the date");
  });

test("A suggestion's email is read once while the deal reads again", async (t) => {
  const { tile, emailReads, releaseEmail } = await openDeal(t, { width: 1440, height: 772 }, "light", {
    holdEmail: true,
  });
  const filing = tile.getByRole("listitem", { name: "File Morgan's email" });
  await filing.getByRole("button", { name: "Dismiss" }).click();
  await filing.waitFor({ state: "detached" });
  releaseEmail();
  await tile.getByText("Our lender cannot fund until late February", { exact: false }).waitFor();
  assert.deepEqual(emailReads, [`/api/engine/proposals/${suggestionId}`]);
});
