import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { after, type TestContext, test } from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";
import { detail, emptyQuietFollowUps, lead, workspace } from "./leads-workspace-fixture.mjs";

const cookieName = "__Host-doctorcre_session";
const partners = new Map([
  ["first", "joe"],
  ["second", "dell"],
]);
const deepLink = "/leads?mode=live&filter=open";
const copiedLeadAlias = "30000000-0000-0000-0000-000000000101";
const docLink = "/api/engine/doc/link";
const dealId = "11111111-1111-4111-8111-111111111111";
const dealName = "Demo deal on engine sign-in";
const activityId = "22222222-2222-4222-8222-222222222222";
const noteId = "44444444-4444-4444-8444-444444444444";
const noteSummary = "Confirm the demo showing";
const callSummary = "Discussed the demo showing";
const noteAttributionPath = `/api/engine/activities/${noteId}/deal-attribution`;
const attributionPath = `/api/engine/activities/${activityId}/deal-attribution`;
const dealPage = `/deals?mode=live&deal=${dealId}`;
const creditedDeal = { id: dealId, name: dealName };
const candidateDeal = { id: "33333333-3333-4333-8333-333333333333", name: "Example second deal" };
const dealRow = { id: dealId, name: dealName, phase: "research", owner: "joe", operating_state: "active" };
const dealBoard = { schema_version: "local-deals-board.v2", actor: "joe", deals: [dealRow] };
const dealDetail = {
  ...dealRow,
  deal_id: dealId,
  activities: [{ id: activityId, kind: "call", summary: callSummary, occurred_at: "2026-01-01T12:00:00Z" }],
  thread: [{ id: noteId, kind: "note", actor: "joe", text: noteSummary, created_at: "2026-01-02T12:00:00Z" }],
};
const pages = [
  "/invoices?mode=live",
  "/control-room/progress?mode=live",
  "/pipeline?mode=live",
  "/a/synthetic?mode=live",
];
const artifacts = "out/test-artifacts/partner-sign-in";
let assets: ReturnType<typeof appAssetSnapshot> | undefined;
let browser: ReturnType<typeof chromium.launch> | undefined;
after(async () => (await browser)?.close());

async function app(
  t: TestContext,
  {
    width = 1440,
    theme = "dark",
    signIn = "engine",
    holdDocIssue,
    readAttribution,
  }: {
    width?: number;
    theme?: "dark" | "light";
    signIn?: "engine" | "carr";
    holdDocIssue?: Promise<void>;
    readAttribution?: (request: Request) => Response | Promise<Response>;
  } = {},
) {
  let unavailable = false;
  let carrChecks = 0;
  let writes = 0;
  const live = new Set<string>();
  const links = new Map<string, string>();
  const exampleLead = lead(1);
  let leadOwner: string | null = null;
  let expireOnLeadDetail = false;
  let issueCount = 0;
  let loseIssueResponse = false;
  const env: NonNullable<Parameters<typeof startWorkerFixture>[0]>["env"] = {
    PARTNER_SIGN_IN: signIn,
    WORKSPACE_COMMAND_CENTER_READ_ENABLED: "true",
    CARR: {
      fetch: async (input) => {
        const path = new URL(input.url).pathname;
        const navigation = input.headers.get("sec-fetch-mode") === "navigate";
        if (path.startsWith("/auth/") || navigation) carrChecks++;
        if (signIn === "carr") {
          if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "fixture-carr" });
          if (path.startsWith("/api/v1/business/vendors")) return Response.json(directoryFixture(input.url));
          if (path === "/api/v1/market-terms/read") {
            const recordings = JSON.parse(
              await readFile(new URL("./fixtures/market-terms/recordings.json", import.meta.url), "utf8"),
            );
            return Response.json(recordings.records.full.response);
          }
          if (path === "/mcp") {
            const { id, params } = await input.json();
            const payload =
              params.name === "deal-room-board"
                ? dealBoard
                : params.name === "get-deal-room"
                  ? dealDetail
                  : params.name === "read-activity-deal-attribution"
                    ? {
                        schema: "activity-deal-attribution.v1",
                        state: "empty",
                        attribution: "unknown",
                        activity: null,
                        direct: null,
                        candidates: [],
                        credited_activity_count: 0,
                        coverage: "unknown",
                      }
                    : {};
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          }
          return new Response(null, { status: navigation ? 200 : 404 });
        }
        throw Error("CARR unavailable");
      },
    },
    PARTNER_APP: {
      async fetch(input) {
        const url = new URL(input.url);
        const path = url.pathname;
        if (unavailable) return new Response(null, { status: 503 });
        const redirect = (location: string, status = 302, headers: Record<string, string> = {}) =>
          new Response(null, { status, headers: { ...headers, location } });
        if (path === "/auth/login") return redirect("/auth/callback/google" + url.search);
        if (path === "/auth/callback/google") {
          const token = url.searchParams.get("fixture") ?? "first";
          if (!partners.has(token)) return Response.json({ error: "sign_in_required" }, { status: 401 });
          live.add(token);
          return redirect(url.searchParams.get("return_to") ?? "/", 302, {
            "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`,
          });
        }
        if (expireOnLeadDetail && path === "/api/engine/leads" && url.searchParams.has("lead_id")) {
          expireOnLeadDetail = false;
          live.clear();
        }
        const token = input.headers.get("cookie")?.match(/__Host-doctorcre_session=([^;]+)/)?.[1];
        if (!token || !live.has(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const csrfToken = "fixture-" + token;
        if (path === "/auth/session")
          return Response.json({
            actor: { slug: partners.get(token) },
            csrf_token: csrfToken,
          });
        if (
          input.method === "POST" &&
          (input.headers.get("x-carr-csrf") !== csrfToken ||
            input.headers.get("origin") !== url.origin ||
            input.headers.get("sec-fetch-site") !== "same-origin")
        )
          return Response.json({ error: "forbidden" }, { status: 403 });
        if (path === "/auth/signout") {
          live.delete(token);
          return redirect("/", 303, {
            "set-cookie": `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          });
        }
        if (path === docLink) {
          if (input.method === "POST") {
            links.set(token, "mac_off");
            const credential = String(++issueCount).padStart(43, "a");
            if (loseIssueResponse) {
              loseIssueResponse = false;
              return new Response(null, { status: 503 });
            }
            await holdDocIssue;
            return Response.json({ credential }, { status: 201 });
          }
          const status = links.get(token) ?? "not_set_up";
          return Response.json({
            connected: status !== "not_set_up" && status !== "mac_off",
            issued_at: links.has(token) ? "2026-01-01T00:00:00Z" : null,
            status,
          });
        }
        if (path === `${docLink}/revoke` && input.method === "POST") {
          links.delete(token);
          return new Response(null, { status: 204 });
        }
        if ((path === attributionPath || path === noteAttributionPath) && readAttribution)
          return readAttribution(input);
        if (path === "/api/engine/deals") return Response.json(dealBoard);
        if (path === `/api/engine/deals/${dealId}`) return Response.json({ ...dealDetail, email_follow_ups: [] });
        if (path.startsWith("/api/engine/vendors")) {
          assert.equal(input.headers.get("cookie"), `${cookieName}=${token}`);
          url.pathname = path.replace("/api/engine", "/api/v1/business");
          return Response.json(directoryFixture(url.href));
        }
        if (path === "/api/engine/leads" && url.searchParams.get("workspace") === "leads") {
          assert.equal(input.headers.get("cookie"), `${cookieName}=${token}`);
          const currentLead = { ...exampleLead, owner: leadOwner, base_version: leadOwner ? 2 : 1 };
          const requestedId = url.searchParams.get("lead_id");
          return Response.json({
            ...workspace(),
            leads: [currentLead],
            ...(requestedId && {
              detail:
                requestedId === currentLead.id || requestedId === copiedLeadAlias
                  ? detail({ ...currentLead, id: requestedId })
                  : null,
            }),
          });
        }
        if (path === "/api/engine/leads") return Response.json({ count: 0 });
        if (path === "/api/engine/quiet-follow-ups") return Response.json(emptyQuietFollowUps());
        if (path === `/api/engine/leads/${exampleLead.id}/changes` && input.method === "POST") {
          const command = await input.json();
          assert.equal(input.headers.get("cookie"), `${cookieName}=${token}`);
          const actor = partners.get(token);
          assert.ok(actor);
          assert.equal(command.expected_actor, actor);
          assert.equal(command.action, "claim");
          leadOwner = actor;
          writes++;
          return Response.json({ ok: true, lead_id: exampleLead.id });
        }
        return new Response(null, { status: 404 });
      },
    },
  };
  assets ??= appAssetSnapshot();
  const server = await startWorkerFixture({ assets: await assets, env });
  t.after(() => server.close());
  browser ??= chromium.launch();
  const context = await (await browser).newContext({
    viewport: { width, height: 850 },
    colorScheme: theme,
  });
  t.after(() => context.close());
  await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
  return {
    server,
    context,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    carrChecks: () => carrChecks,
    expireOnNextLeadDetail: () => {
      expireOnLeadDetail = true;
    },
    writes: () => writes,
    setDocStatus: (status: string) => links.set("first", status),
    loseNextDocIssue: () => {
      loseIssueResponse = true;
    },
  };
}

test("Doc settings show each Mac status and keep link codes private", async (t) => {
  const { server, context, setDocStatus, loseNextDocIssue } = await app(t, { width: 390 });
  const first = await context.newPage();
  await first.goto(server.origin + deepLink);
  await first.locator('#selfAvatar[aria-label*="account and settings"]').click();
  await first.getByRole("link", { name: "Doc link", exact: true }).click({ timeout: 4000 });
  assert.equal(first.url(), server.origin + "/updates#docLinkSettings");
  const target = "/updates?mode=live#docLinkSettings";
  await first.goto(server.origin + target);
  const settings = first.getByRole("region", { name: "Doc link" });
  await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();

  loseNextDocIssue();
  await settings.getByRole("button", { name: "Make link code" }).click();
  await settings.getByText("The code could not be shown. Replace it to get a new one.").waitFor();
  await settings.getByRole("button", { name: "Replace link code" }).click();
  const replacement = "2".padStart(43, "a");
  const code = settings.getByText(replacement, { exact: true });
  await code.waitFor();
  assert.equal(await code.count(), 1);
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const otherContext = await (await browser)?.newContext();
  assert.ok(otherContext);
  t.after(() => otherContext.close());
  const other = await otherContext.newPage();
  await other.goto(server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(target));
  await other.getByText("Doc isn't set up on your Mac yet.").waitFor();
  assert.equal(await other.getByText(replacement, { exact: true }).count(), 0);
  assert.equal(await other.getByRole("button", { name: "Revoke link code" }).count(), 0);
  const otherRevoke = await other.evaluate(
    async (path) => (await fetch(path, { method: "POST", headers: { "x-carr-csrf": "fixture-second" } })).status,
    docLink + "/revoke",
  );
  assert.equal(otherRevoke, 204);
  await code.waitFor();

  await first.reload();
  const refresh = settings.getByRole("button", { name: "Refresh Doc status" });
  await settings.getByText("Doc answers when your Mac is on.").waitFor();
  assert.equal(await code.count(), 0);
  for (const [status, copy] of [
    ["signed_out", "Sign in to Claude Code on your Mac."],
    ["plan_limited", "Doc is paused until your Claude plan resets."],
    ["ready", "Doc is ready on your Mac."],
  ] as const) {
    setDocStatus(status);
    await refresh.click();
    await settings.getByText(copy, { exact: true }).waitFor();
  }

  await settings.getByRole("button", { name: "Revoke link code" }).click();
  await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();
});

for (const issuance of ["completed", "pending"] as const)
  test(`Doc link clears the ${issuance} code when switching settings through the account menu`, async (t) => {
    const issue = Promise.withResolvers<void>();
    t.after(() => issue.resolve());
    const { server, context } = await app(t, { width: 390, holdDocIssue: issue.promise });
    const page = await context.newPage();
    await page.goto(server.origin + "/updates?mode=live#docLinkSettings");
    const settings = page.getByRole("region", { name: "Doc link" });
    const making = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(docLink));
    await settings.getByRole("button", { name: "Make link code" }).click();
    await making;
    const code = settings.getByText("1".padStart(43, "a"), { exact: true });
    if (issuance === "completed") {
      issue.resolve();
      await code.waitFor();
    }

    // The live fixture boots with a query that the production menu hrefs omit.
    await page.evaluate(() => history.replaceState(null, "", "/updates#docLinkSettings"));
    const avatar = page.locator('#selfAvatar[aria-label*="account and settings"]');
    await avatar.click();
    await page.getByRole("link", { name: "Notification preferences" }).click();
    await page.waitForURL("**/updates#prefForm");
    await page.keyboard.press("Escape");
    await avatar.click();
    await page.getByRole("link", { name: "Doc link", exact: true }).click();
    await page.waitForURL("**/updates#docLinkSettings");
    issue.resolve();
    const replace = settings.getByRole("button", { name: "Replace link code" });
    await code.or(replace).waitFor();
    assert.equal(await code.count(), 0, "the issued code must be gone upon returning");
  });

test("Doc link settings are available only with engine sign-in", async (t) => {
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context } = await app(t, { signIn });
    const page = await context.newPage();
    if (signIn === "carr") {
      await page.route("**/js/notifications.js", async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const end = /\.catch\(\(\)=>\{[^{}]*"Couldn't load Doc link settings\."\)\}\)/;
        assert.match(source, end, "Doc link initialization must be observed");
        await route.fulfill({
          response,
          body: source.replace(end, '$&.finally(() => { document.documentElement.dataset.docLinkSettled = "true"; })'),
        });
      });
    }
    await page.goto(server.origin + "/updates?mode=live#docLinkSettings");
    await page.locator('#selfAvatar[aria-label*="account and settings"]').click();
    await page.getByRole("link", { name: "Notification preferences" }).waitFor();
    const entry = page.getByRole("link", { name: "Doc link", exact: true });
    const settings = page.getByRole("region", { name: "Doc link" });
    if (signIn === "engine") {
      await entry.waitFor();
      await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();
    } else {
      await page.getByText("Joe's Workspace", { exact: true }).waitFor();
      await page.locator('html[data-doc-link-settled="true"]').waitFor();
      assert.equal(await entry.count(), 0, "CARR sign-in must hide the Doc link entry");
      assert.equal(
        server.requests.some(({ path }) => path === docLink),
        false,
      );
      assert.equal(await settings.count(), 0);
    }
  }
});

test("Compare terms is empty on engine sign-in and legacy deal features make no requests", async (t) => {
  const { server, context } = await app(t);
  const page = await context.newPage();
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (
      pathname.startsWith("/api/tours/") ||
      pathname === "/api/v1/market-terms/read" ||
      (pathname === "/mcp" && /read-subject-watch-v2|read-activity-deal-attribution/.test(request.postData() ?? ""))
    )
      legacyRequests.push(pathname);
  });
  await page.goto(server.origin + dealPage);
  const room = page.getByRole("main", { name: "Deal Workspace" });
  await room.getByRole("heading", { name: dealName }).waitFor({ timeout: 4000 });
  await room
    .getByRole("region", { name: "Deal watch settings" })
    .getByText("Not available yet", { exact: true })
    .waitFor({ timeout: 4000 });
  await room.getByRole("tab", { name: "Compare terms" }).click();
  await room
    .getByRole("tabpanel", { name: "Compare terms" })
    .getByText("No comparable terms match these filters.", { exact: true })
    .waitFor({ timeout: 4000 });
  await room.getByRole("tab", { name: "Tours" }).click();
  await room
    .getByRole("tabpanel", { name: "Tours" })
    .getByText("Not available yet", { exact: true })
    .waitFor({ timeout: 4000 });
  assert.equal(
    server.requests.some(({ path }) => path === attributionPath || path === noteAttributionPath),
    false,
  );
  assert.deepEqual(legacyRequests, []);
});

test("a saved Leads link opens on the engine session, supports claim and prompts after expiry", async (t) => {
  const { server, context, carrChecks, expireOnNextLeadDetail, writes } = await app(t);
  const path = "/leads?mode=live&lead=L-1";
  const page = await context.newPage();
  await page.goto(server.origin + path);
  const drawer = page.locator("#leadDetail");
  await drawer.getByRole("heading", { name: "Dr. Example 1" }).waitFor({ timeout: 5000 });
  await drawer.getByRole("button", { name: "Claim", exact: true }).click();
  await page.getByText("Lead claimed", { exact: true }).waitFor({ timeout: 5000 });
  await drawer.getByText("Joe", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(writes(), 1);

  await drawer.getByRole("button", { name: "Close lead details" }).click();
  await drawer.waitFor({ state: "hidden" });
  expireOnNextLeadDetail();
  const leadButton = page.getByRole("button", { name: "Dr. Example 1", exact: true });
  await leadButton.click();
  await page.getByRole("link", { name: "Sign in again" }).waitFor({ timeout: 5000 });
  assert.equal(await leadButton.count(), 0);
  assert.equal(carrChecks(), 0);
});

test("a saved Leads link with a second copied UUID opens the lead and supports claim", async (t) => {
  const { server, context, writes } = await app(t);
  const page = await context.newPage();
  await page.goto(`${server.origin}/leads?mode=live&lead=${copiedLeadAlias}`);
  const drawer = page.locator("#leadDetail");
  await drawer.getByRole("heading", { name: "Dr. Example 1" }).waitFor({ timeout: 5000 });
  await drawer.getByText("Planning a dental relocation.", { exact: false }).waitFor({ timeout: 5000 });
  await drawer.getByRole("button", { name: "Claim", exact: true }).click();
  await page.getByText("Lead claimed", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(writes(), 1);
});

test("the Vendor drawer keeps the track record and shows the rating editor only in CARR mode", async (t) => {
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context, carrChecks } = await app(t, { signIn });
    await context.addCookies([
      {
        name: "__Host-dealroom_session",
        value: "stale",
        domain: new URL(server.origin).hostname,
        path: "/",
        secure: true,
      },
    ]);
    const page = await context.newPage();
    await page.goto(server.origin + "/vendors?mode=live&q=Demo+Partner+01");
    await page.locator(".record-row").filter({ hasText: "Demo Partner 01" }).click({ timeout: 5000 });
    const drawer = page.getByRole("dialog");
    await drawer.getByText("Deals worked", { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await drawer.getByText("Trust rating", { exact: true }).count(), signIn === "carr" ? 1 : 0);
    if (signIn === "engine") assert.equal(carrChecks(), 0);
  }
});

function attributionButton(page: Page, update: string) {
  return page
    .getByRole("region", { name: "Deal updates" })
    .getByRole("article")
    .filter({ hasText: update })
    .getByRole("button", { name: "Show deal attribution" });
}

test("an engine history note offers attribution for its activity ID", async (t) => {
  const { server, context } = await app(t, {
    readAttribution: () => Response.json({ kind: "credited", deal: creditedDeal }),
  });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await page.getByRole("region", { name: "Deal updates" }).getByText(noteSummary, { exact: true }).waitFor();
  const button = attributionButton(page, noteSummary);
  assert.equal(await button.count(), 1, "The engine note should have a deal attribution button");
  await button.click();
  const panel = page.getByRole("region", { name: "Activity deal attribution" });
  await panel.getByRole("link", { name: dealName }).waitFor();
  assert.deepEqual(
    server.requests.filter(({ path }) => path === noteAttributionPath).map(({ method }) => method),
    ["GET"],
  );
});

const attributionCases = [
  {
    title: "Direct deal attribution",
    deals: [creditedDeal],
    response: () => Response.json({ kind: "credited", deal: creditedDeal }),
  },
  {
    title: "Ambiguous deals need review",
    deals: [creditedDeal, candidateDeal],
    response: () => Response.json({ kind: "ambiguous", candidates: [creditedDeal, candidateDeal] }),
  },
  {
    title: "Activity attribution unknown",
    deals: [],
    response: () => Response.json({ error: "not_found" }, { status: 404 }),
  },
];

for (const { title, deals, response } of attributionCases)
  test(`engine deal history shows ${title.toLowerCase()}`, async (t) => {
    const { server, context } = await app(t, { readAttribution: response });
    const page = await context.newPage();
    await page.goto(server.origin + dealPage);
    await page.locator(".updates-history summary").click();
    await attributionButton(page, callSummary).click();
    const panel = page.getByRole("region", { name: "Activity deal attribution" });
    await panel.getByRole("heading", { name: title }).waitFor();
    await panel.getByText(`${deals.length === 1 ? 1 : 0} credited activities`, { exact: true }).waitFor();
    const links = panel.getByRole("link");
    assert.deepEqual(
      await links.allTextContents(),
      deals.map(({ name }) => name),
    );
    for (const [index, deal] of deals.entries())
      assert.equal(await links.nth(index).getAttribute("href"), `/deals?deal=${deal.id}`);
    assert.deepEqual(
      server.requests.filter(({ path }) => path === attributionPath).map(({ method, target }) => [method, target]),
      [["GET", attributionPath]],
    );
  });

test("a signed-out attribution read returns the partner to sign-in", async (t) => {
  const { server, context } = await app(t, {
    readAttribution: () => Response.json({ error: "unauthorized" }, { status: 401 }),
  });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await attributionButton(page, callSummary).click();
  await page.waitForURL("**/public-shell/session-ended.html");
  await page.getByRole("link", { name: "Sign in again" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: dealName }).count(), 0);
});

test("an attribution timeout aborts the read and shows a sign-in prompt", async (t) => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  t.after(() => cancelled.resolve());
  const { server, context } = await app(t, {
    async readAttribution(request) {
      request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      started.resolve();
      await cancelled.promise;
      return Response.json({ kind: "credited", deal: creditedDeal });
    },
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await attributionButton(page, callSummary).click();
  await started.promise;
  await page.clock.fastForward(30_001);
  await page
    .getByRole("region", { name: "Activity deal attribution" })
    .getByRole("link", { name: "Sign in" })
    .waitFor();
  await cancelled.promise;
  await page.getByRole("heading", { name: dealName }).waitFor();
  assert.equal(await page.getByText("1 credited activities", { exact: true }).count(), 0);
});

test("CARR deal history and Compare terms use their existing reads", async (t) => {
  const { server, context } = await app(t, { signIn: "carr" });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await page.getByRole("region", { name: "Deal updates" }).getByText(noteSummary, { exact: true }).waitFor();
  assert.equal(await attributionButton(page, noteSummary).count(), 0);
  const reading = page.waitForRequest(
    (request) =>
      request.url().endsWith("/mcp") && request.postDataJSON()?.params?.name === "read-activity-deal-attribution",
  );
  await attributionButton(page, callSummary).click();
  assert.deepEqual((await reading).postDataJSON().params.arguments, { activity_id: activityId });
  await page.getByRole("heading", { name: "Activity attribution unknown" }).waitFor();
  await page.getByText("Version evidence", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close attribution" }).click();
  await page.getByRole("tab", { name: "Compare terms" }).click();
  await page.getByRole("tabpanel", { name: "Compare terms" }).getByRole("table").waitFor();
  assert.deepEqual(
    server.requests.filter(({ path }) => path === "/api/v1/market-terms/read").map(({ method }) => method),
    ["POST"],
  );
  assert.equal(
    server.requests.some(({ path }) => path === attributionPath || path === noteAttributionPath),
    false,
  );
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`engine sign-in gates real app pages at ${width}px in ${theme}`, async (t) => {
      const { server, context, setUnavailable, carrChecks } = await app(t, { width, theme });
      const page = await context.newPage();
      const target = server.origin + deepLink;
      setUnavailable(true);
      const outage = await page.goto(target);
      assert.ok(outage);
      assert.equal(outage.status(), 503);
      await page.getByRole("heading", { name: "DoctorCRE is temporarily unavailable" }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: `${artifacts}/unavailable-${width}-${theme}.png` });
      const loginOutage = await page.goto(server.origin + "/auth/login");
      assert.ok(loginOutage);
      assert.equal(loginOutage.status(), 503);
      await page.getByRole("heading", { name: "DoctorCRE is temporarily unavailable" }).waitFor();
      setUnavailable(false);

      const pageResponse = await page.goto(target);
      assert.equal(page.url(), target);
      assert.ok(pageResponse);
      assert.equal(pageResponse.status(), 200);
      assert.equal(pageResponse.headers()["cache-control"], "no-store");
      const login = pageResponse.request().redirectedFrom()?.redirectedFrom();
      assert.ok(login);
      assert.equal(new URL(login.url()).searchParams.get("return_to"), deepLink);
      await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
      for (const path of pages) {
        const response = await page.goto(server.origin + path);
        assert.ok(response);
        assert.equal(response.status(), 200, path);
        assert.equal(response.headers()["cache-control"], "no-store", path);
        await page.locator("main").first().waitFor({ state: "attached" });
      }
      assert.deepEqual(await page.evaluate(() => fetch("/api/engine/leads").then((response) => response.json())), {
        count: 0,
      });
      assert.equal(carrChecks(), 0);
    });
    test(`a refused Google sign-in can be retried at ${width}px in ${theme}`, async (t) => {
      const { server, context } = await app(t, { width, theme });
      const page = await context.newPage();
      const response = await page.goto(server.origin + "/auth/callback/google?fixture=refused");
      assert.ok(response);
      assert.equal(response.status(), 401);
      assert.match(response.headers()["content-type"] ?? "", /^text\/html\b/);
      assert.equal(response.headers()["cache-control"], "no-store");
      await page.getByRole("heading", { name: "We couldn’t complete Google sign-in" }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: `${artifacts}/refused-${width}-${theme}.png` });
      await page.getByRole("link", { name: "Try again" }).click();
      await page.waitForURL(server.origin + "/");
      await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
    });
  }

test("engine sign-out clears two tabs, revokes the cookie, and leaves another context signed in", async (t) => {
  const { server, context } = await app(t);
  const first = await context.newPage();
  const otherTab = await context.newPage();
  assert.ok(browser);
  const separate = await (await browser).newContext();
  t.after(() => separate.close());
  const otherPartner = await separate.newPage();
  const target = server.origin + deepLink;
  await first.goto(target);
  await otherTab.goto(target);
  await otherPartner.goto(
    server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(deepLink),
  );
  for (const page of [first, otherTab, otherPartner])
    await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await first.locator("#selfAvatar").click();
  await first.getByRole("button", { name: "Sign out", exact: true }).click();
  await Promise.all([first, otherTab].map((page) => page.waitForURL("**/public-shell/session-ended.html")));
  assert.equal((await context.request.get(server.origin + "/auth/session")).status(), 401);
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === cookieName),
    false,
  );
  assert.equal((await separate.request.get(server.origin + "/auth/session")).status(), 200);
});

test("a delayed session change notification leaves the new engine workspace open", async (t) => {
  const { server, context } = await app(t);
  const stale = await context.newPage();
  const fresh = await context.newPage();
  const avatar = '#selfAvatar[aria-label*="account and settings"]';
  const target = server.origin + deepLink;
  await stale.addInitScript(() => {
    const delayEpoch = (event: StorageEvent) => {
      if (event.key !== "doctorcre-session-epoch-v1") return;
      event.stopImmediatePropagation();
      window.removeEventListener("storage", delayEpoch, true);
      const notification = new StorageEvent("storage", event);
      window.addEventListener("release-session-change", () => window.dispatchEvent(notification), { once: true });
      document.documentElement.dataset.sessionChangeDelayed = "true";
    };
    window.addEventListener("storage", delayEpoch, true);
  });

  await stale.goto(target);
  await stale.locator(avatar).waitFor();
  await fresh.goto(server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(deepLink));
  await fresh.locator(avatar).waitFor();
  await stale.locator('html[data-session-change-delayed="true"]').waitFor({ state: "attached" });
  await fresh.evaluate(() => localStorage.setItem("doctorcre:fixture-new-draft", "New synthetic draft"));

  await stale.evaluate(() => window.dispatchEvent(new Event("release-session-change")));
  await stale.waitForURL("**/public-shell/session-ended.html");
  assert.equal((await context.request.get(server.origin + "/auth/session")).status(), 200);
  assert.equal(fresh.url(), target);
  assert.equal(await fresh.locator(avatar).isVisible(), true);
  assert.equal(await fresh.evaluate(() => localStorage.getItem("doctorcre:fixture-new-draft")), "New synthetic draft");
});

test("engine session changes fence old tabs and offline navigation shows the public shell", async (t) => {
  const { server, context, writes } = await app(t);
  const stale = await context.newPage();
  const fresh = await context.newPage();
  const target = server.origin + deepLink;
  await stale.goto(target);
  await stale.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await context.request.get(server.origin + "/auth/callback/google?fixture=second", { maxRedirects: 0 });
  await stale.evaluate(() => {
    const sessionModule: string = "/js/private-session.js";
    void import(sessionModule)
      .then(({ privateSession }) =>
        privateSession().fetch("/api/engine/leads", {
          method: "POST",
          headers: { "x-carr-csrf": "fixture-first" },
          body: "{}",
        }),
      )
      .catch(() => {});
  });
  await stale.waitForURL("**/public-shell/session-ended.html");
  assert.equal(writes(), 0);
  await fresh.goto(target);
  await fresh.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await fresh.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  await fresh.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  const api = await fresh.evaluate(() => fetch("/api/engine/leads").then((response) => response.json()));
  assert.equal(api.error, "offline");
  await fresh.goto(target);
  await fresh.getByRole("heading", { name: "Reconnecting…" }).waitFor();
  assert.equal(await fresh.locator("#selfAvatar").count(), 0);
});

test("an engine login opens the original page after clearing the previous session state", async (t) => {
  const { server, context } = await app(t);
  await context.addInitScript(() => {
    if (localStorage.getItem("fixture-previous-session-seeded")) return;
    localStorage.setItem("fixture-previous-session-seeded", "true");
    localStorage.setItem("doctorcre-session-binding-v1", "0".repeat(64));
    localStorage.setItem("doctorcre:previous-session-draft", "Old synthetic draft");
  });
  const page = await context.newPage();
  const target = server.origin + deepLink;
  await page.goto(target);
  await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor({ timeout: 3500 });
  assert.equal(page.url(), target);
  assert.equal(await page.evaluate(() => localStorage.getItem("doctorcre:previous-session-draft")), null);
  assert.equal(server.requests.filter((request) => request.path === "/auth/callback/google").length, 1);
});
