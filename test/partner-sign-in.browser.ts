import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, type TestContext, test } from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const cookieName = "__Host-doctorcre_session";
const partners = new Map([
  ["first", "joe"],
  ["second", "dell"],
]);
const deepLink = "/leads?mode=live&filter=open";
const docLink = "/api/engine/doc/link";
const dealId = "11111111-1111-4111-8111-111111111111";
const dealName = "Demo deal on engine sign-in";
const activityId = "22222222-2222-4222-8222-222222222222";
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
  }: { width?: number; theme?: "dark" | "light"; signIn?: "engine" | "carr"; holdDocIssue?: Promise<void> } = {},
) {
  let unavailable = false;
  let carrChecks = 0;
  let writes = 0;
  const live = new Set<string>();
  const links = new Map<string, string>();
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
        if (path === "/api/engine/deals") {
          return Response.json({
            schema_version: "local-deals-board.v2",
            deals: [{ id: dealId, name: dealName, phase: "research", owner: "joe", operating_state: "active" }],
          });
        }
        if (path === `/api/engine/deals/${dealId}`) {
          return Response.json({
            deal_id: dealId,
            name: dealName,
            phase: "research",
            owner: "joe",
            email_follow_ups: [],
            activities: [{ id: activityId, kind: "note", summary: "Confirm the demo showing" }],
          });
        }
        if (path === "/api/engine/leads") {
          if (input.method === "POST") writes++;
          return Response.json({ count: 0 });
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

test("a signed-in deal explains unavailable features without requesting them", async (t) => {
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
  await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
  const room = page.getByRole("main", { name: "Deal Workspace" });
  await room.getByRole("heading", { name: dealName }).waitFor({ timeout: 4000 });
  await room
    .getByRole("region", { name: "Deal watch settings" })
    .getByText("Not available yet", { exact: true })
    .waitFor({ timeout: 4000 });
  await room.locator(".updates-history summary").click();
  await room.getByText("Deal attribution · Not available yet", { exact: true }).waitFor({ timeout: 4000 });
  for (const name of ["Compare terms", "Tours"]) {
    await room.getByRole("tab", { name, exact: true }).click();
    await room
      .getByRole("tabpanel", { name })
      .getByText("Not available yet", { exact: true })
      .waitFor({ timeout: 4000 });
  }
  assert.deepEqual(legacyRequests, []);
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
