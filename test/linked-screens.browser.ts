import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

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
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByRole("region", { name: "Approved client needs", exact: true }).count(), 0);
  assert.equal(needs, 0);
});
