import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import anniversaries from "./fixtures/client-anniversary-panel/recordings.json" with { type: "json" };
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

test("replaced screens guide partners to current work at desktop and phone widths", async (t) => {
  const assets = await appAssetSnapshot();
  const routes = new Map();
  const views = [
    [
      "/review-workflows",
      "/review-workflows-moved.html",
      "#homeEmailFollowups",
      "Review workflows",
      "#homeBrief",
      ["Home", "Deals", "Calendar"],
      ["/", "/deals", "/calendar"],
    ],
    ["/leases", "/lease-anniversaries.html", "?lease=example", "Lease dates", "#leaseRadar", ["Deals"], ["/deals"]],
    [
      "/client-portal",
      "/client-website-moved.html",
      "?slug=example",
      "Client websites",
      "#portalForm",
      ["Deals"],
      ["/deals"],
    ],
  ] as const;
  for (const [path, file] of views) {
    const html = assets.get(file);
    assert.ok(html);
    routes.set(path, {
      ...html,
      body: String(html.body).replace("<html ", '<html data-deals-saves-from-engine="2025-06-12" '),
    });
  }
  routes.set("/api/v1/intelligence/client-anniversary-read", {
    contentType: "application/json",
    body: JSON.stringify(anniversaries.ready.output),
  });
  const server = await startFixture({ assets, routes });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(".scratch/linked-screens", { recursive: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("https://**", (route) => route.abort());
    const main = page.locator("main");
    for (const [path, , suffix, heading, retired, labels, targets] of views) {
      await page.goto(`${server.origin}${path}${suffix}`);
      await main.getByRole("heading", { name: heading, exact: true }).waitFor();
      const links = labels.map((name) => main.getByRole("link", { name, exact: true }).getAttribute("href"));
      assert.deepEqual(await Promise.all(links), targets);
      assert.equal(await page.locator(retired).count(), 0);
      if (path === "/leases") await main.getByText("From deals closed before Jun 12, 2025").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `.scratch/linked-screens/${path.slice(1)}-${width}.png` });
    }
    await page.close();
  }
});

test("the switched vendor page opens a vendor without reading approved client needs", async (t) => {
  const assets = await appAssetSnapshot();
  const html = assets.get("/business.html");
  assert.ok(html);
  const routes = new Map([
    [
      "/vendors",
      {
        ...html,
        body: String(html.body).replace("<html ", "<html data-deals-saves-from-engine "),
      },
    ],
  ]);
  const server = await startFixture({ assets, routes });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/business/**", (route) =>
    route.fulfill({ json: directoryFixture(route.request().url()) }),
  );
  let needs = 0;
  await page.route("**/mcp", (route) => {
    const rpc: unknown = route.request().postDataJSON();
    assert.ok(rpc && typeof rpc === "object" && "id" in rpc && "params" in rpc);
    const params = rpc.params;
    if (params && typeof params === "object" && "name" in params && params.name === "read-vendor-client-needs-v1")
      needs++;
    return route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "{}" }] } } });
  });
  const vendor = "00000000-0000-4000-8000-000000000001";
  const name = directoryFixture(`${server.origin}/api/v1/business/vendors/${vendor}`).record;
  assert.ok(name && typeof name === "object" && "name" in name && typeof name.name === "string");
  await page.goto(`${server.origin}/vendors?record=${vendor}`);
  await page.getByRole("heading", { name: name.name, exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Approved client needs", exact: true }).count(), 0);
  assert.equal(needs, 0);
});
