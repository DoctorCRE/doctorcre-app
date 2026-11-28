import assert from "node:assert/strict";
import test from "node:test";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { chromium } from "./browser-harness.mjs";
import { ownedServer } from "./fixture-probe.ts";

const contactId = "party:00000000-0000-4000-8000-00000000b004";

test("a person under People with no relationship links opens their card", async (t) => {
  const server = await ownedServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const network = relationshipNetworkFixture(new Date().toISOString());
  const [template] = network.nodes;
  if (!template) throw Error("the fixture has no nodes");
  network.nodes.push({ ...template, id: contactId, record_id: contactId.slice(6), name: "Dr. Example", kind: "contact" });
  assert.equal(
    network.edges.some((edge) => [edge.from, edge.to, edge.via].includes(contactId)),
    false,
    "the contact has no links",
  );
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/business/relationships**", (route) => route.fulfill({ json: network }));
  await page.route(/\/(api\/system-work\/session|auth\/session)$/, (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } }),
  );
  await page.route("**/mcp", (route) =>
    route.fulfill({
      json: { jsonrpc: "2.0", id: route.request().postDataJSON().id, result: { content: [{ type: "text", text: "{}" }] } },
    }),
  );
  await page.goto(`${server.url}/relationships?mode=live&node=${encodeURIComponent(contactId)}`);
  await page.getByRole("heading", { name: "Dr. Example" }).waitFor();
  assert.match(page.url(), /node=party%3A00000000-0000-4000-8000-00000000b004|node=party:00000000-0000-4000-8000-00000000b004/);
});
