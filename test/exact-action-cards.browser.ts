import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { chromium, type Page } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { proveExact } from "../scripts/prove-exact-action-cards.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";

const reply: { ref: string; card: { id: string } } = JSON.parse(
  await readFile("test/fixtures/action-link-reply.v2.json", "utf8"),
);
const target = { ref: reply.ref, id: reply.card.id };
const commit = "1".repeat(40),
  foreignRef = `al1_${Buffer.from(`rd:${reply.card.id}:dell:1`).toString("base64url")}`;
const cardContract = new Ajv({ strict: false, validateFormats: false }).compile(
  JSON.parse(await readFile("contracts/carr-interface.v1/action-link-resolve.v2.json", "utf8")),
);
assert.ok(cardContract(reply), JSON.stringify(cardContract.errors));
const assets = await appAssetSnapshot();
async function fixture() {
  const routes = new Map(assets);
  routes.set("/app-release", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit })),
  });
  const calls: string[] = [];
  const server = await startWorkerFixture({
    routes,
    env: {
      CARR: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/auth/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic-csrf" });
          if (url.pathname === "/mcp") {
            const rpc = await request.json();
            assert.ok(
              typeof rpc === "object" &&
                rpc !== null &&
                "id" in rpc &&
                "params" in rpc &&
                typeof rpc.params === "object" &&
                rpc.params !== null &&
                "name" in rpc.params &&
                "arguments" in rpc.params &&
                typeof rpc.params.arguments === "object" &&
                rpc.params.arguments !== null,
            );
            calls.push(String(rpc.params.name));
            const value = "ref" in rpc.params.arguments && rpc.params.arguments.ref === reply.ref ? reply : null;
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(value || { error: "action_link_not_found" }) }],
              },
            });
          }
          return new Response(null);
        },
      },
    },
  });
  return { ...server, calls };
}
async function gotoEndedSession(page: Page, url: string) {
  await page.goto(url);
  await page.waitForURL("**/public-shell/session-ended.html?**");
}

test("session refusal replaces initial navigation before its pending load and discloses no private card", async () => {
  const server = await fixture();
  const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) events.push(new URL(frame.url()).pathname);
    });
    await page.route("**/a/**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace("</body>", '<img src="/held-initial-load"></body>'),
      });
    });
    await page.route("**/held-initial-load", async (route) => {
      await gate;
      await route.fulfill({ body: "" });
    });
    await page.route("**/auth/session", async (route) => {
      events.push("session 401");
      await route.fulfill({ status: 401, json: { error: "not_authenticated" } });
    });
    await gotoEndedSession(page, `${server.origin}/a/${reply.ref}?mode=live`);
    assert.deepEqual(events.slice(0, 3), [`/a/${reply.ref}`, "session 401", "/public-shell/session-ended.html"]);
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    const login = page.locator("a[href*=return_to]");
    await login.waitFor();
    assert.equal(
      new URL((await login.getAttribute("href")) || "", server.origin).searchParams.get("return_to"),
      `/a/${reply.ref}`,
    );
  } finally {
    release();
    await browser.close();
    await server.close();
  }
});

test("reply links show the exact draft without inbox reads at phone and desktop sizes", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        await page.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        await page.goto(`${server.origin}/a/${target.ref}?mode=live`);
        const node = page.locator("[data-exact-card-id]");
        await node.waitFor();
        assert.equal(await node.getAttribute("data-exact-card-id"), target.id);
        assert.equal(await node.getAttribute("data-exact-card-kind"), "reply_draft");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({
          path: `out/test-artifacts/action-links/reply_draft-${width}-${theme}.png`,
          fullPage: true,
        });
        await page.close();
      }
    assert.ok(server.calls.filter((name) => name === "resolve-action-link-v2").length >= 4);
    assert.equal(server.calls.includes("read-home-inbox"), false);
  } finally {
    await browser.close();
    await server.close();
  }
});
test("wrong partner malformed near-match offline and expired session disclose no card; sign-in preserves reference", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    for (const ref of [foreignRef, `${reply.ref}A`, "al1_bad"]) {
      await page.goto(`${server.origin}/a/${ref}?mode=live`);
      await page.getByText(/unavailable for your account|invalid|could not be opened/).waitFor();
      assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    }
    await page.route("**/mcp", (route) => route.abort("internetdisconnected"));
    await page.goto(`${server.origin}/a/${reply.ref}?mode=live`);
    await page.getByText("The draft could not be opened.", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    await page.unroute("**/mcp");
    await page.route("**/auth/login?**", async (route) => {
      const destination = new URL(route.request().url()).searchParams.get("return_to");
      assert.equal(destination, `/a/${reply.ref}`);
      await page.unroute("**/auth/session");
      await route.fulfill({ status: 302, headers: { location: `${destination}?mode=live` }, body: "" });
    });
    await page.route("**/auth/session", (route) =>
      route.fulfill({ status: 401, json: { error: "not_authenticated" } }),
    );
    await page.goto(`${server.origin}/a/${reply.ref}?mode=live`);
    await page.waitForURL("**/public-shell/session-ended.html?**");
    const login = page.locator("a[href*=return_to]");
    await login.waitFor();
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    assert.equal(
      new URL((await login.getAttribute("href")) || "", server.origin).searchParams.get("return_to"),
      `/a/${reply.ref}`,
    );
    await login.click();
    await page.waitForURL(`${server.origin}/a/${reply.ref}?mode=live`);
    await page.locator("[data-exact-card-id]").waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
test("retired call and feedback links show the unavailable page without resolving the card", async () => {
  const server = await fixture(),
    browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    for (const prefix of ["cr", "fe"]) {
      const ref = `al1_${Buffer.from(`${prefix}:${target.id}:synthetic`).toString("base64url")}`;
      const response = await page.goto(`${server.origin}/a/${ref}?mode=live`);
      assert.equal(response?.status(), 404);
      await page.getByRole("heading", { name: "This link is no longer available" }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Back to Home" }).getAttribute("href"), "/");
      assert.equal(await page.locator("[data-exact-card-id]").count(), 0);
    }
    assert.deepEqual(server.calls, []);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("exact-card proof containing release passes and near-match fails; unavailable registered read is insufficient", async () => {
  const server = await fixture();
  try {
    assert.equal(
      (await proveExact({ origin: server.origin, commit, target, foreignRef, engine: chromium })).status,
      "passed",
    );
    await assert.rejects(
      proveExact({
        origin: server.origin,
        commit,
        target: { ...target, id: `${target.id}f` },
        foreignRef,
        engine: chromium,
      }),
    );
    await assert.rejects(
      proveExact({
        origin: server.origin,
        commit,
        target: { ...target, ref: foreignRef },
        foreignRef,
        engine: chromium,
      }),
      { exitCode: 78 },
    );
  } finally {
    await server.close();
  }
});

test("production proof CLI exits 0, 1 and 78 through a real browser fixture", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const browserFixture = await ownedCdpFixture();
  t.after(() => browserFixture.close());
  const server = await fixture(),
    browser = browserFixture.browser;
  try {
    const endpoint = browserFixture.endpoint;
    const args = [
      "scripts/prove-exact-action-cards.ts",
      "--origin",
      server.origin,
      "--commit",
      commit,
      "--reply-ref",
      reply.ref,
      "--reply-id",
      reply.card.id,
      "--foreign-ref",
      foreignRef,
      "--cdp-url",
      endpoint,
    ];
    assert.equal(JSON.parse((await exec(process.execPath, args, { timeout: 45000 })).stdout).status, "passed");
    const wrong = [...args];
    wrong[wrong.indexOf("--reply-id") + 1] = `${reply.card.id.slice(0, -1)}f`;
    await assert.rejects(
      exec(process.execPath, wrong, { timeout: 45000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
    );
    const missing = [...args];
    missing[missing.indexOf("--reply-ref") + 1] = foreignRef;
    await assert.rejects(
      exec(process.execPath, missing, { timeout: 45000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 78,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

for (const phase of ["late launch", "stalled evaluation"])
  test(`exact-card deadline closes owned browser for ${phase}`, async () => {
    const server = await fixture();
    let owned: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const engine = {
        async launch(options: { timeout: number; args: string[] }) {
          const browser = await chromium.launch({
            ...options,
            headless: true,
            args: [...CHROMIUM_SAFETY_ARGS, ...options.args],
          });
          owned = browser;
          if (phase === "late launch") await new Promise((resolve) => setTimeout(resolve, 1500));
          else {
            const newPage = browser.newPage.bind(browser);
            browser.newPage = async () => {
              const page = await newPage();
              page.evaluate = () => new Promise<never>(() => {});
              return page;
            };
          }
          return browser;
        },
      };
      await assert.rejects(proveExact({ origin: server.origin, commit, target, foreignRef, engine, timeoutMs: 1000 }), {
        exitCode: 78,
      });
      assert.equal(owned?.isConnected(), false);
    } finally {
      await owned?.close();
      await server.close();
    }
  });
