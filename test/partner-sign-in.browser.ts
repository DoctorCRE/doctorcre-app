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
  { width = 1440, theme = "dark" }: { width?: number; theme?: "dark" | "light" } = {},
) {
  let unavailable = false;
  let carrChecks = 0;
  let writes = 0;
  const live = new Set<string>();
  const env: NonNullable<Parameters<typeof startWorkerFixture>[0]>["env"] = {
    PARTNER_SIGN_IN: "engine",
    WORKSPACE_COMMAND_CENTER_READ_ENABLED: "true",
    CARR: {
      fetch: async (input) => {
        if (new URL(input.url).pathname.startsWith("/auth/") || input.headers.get("sec-fetch-mode") === "navigate")
          carrChecks++;
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
  };
}

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
