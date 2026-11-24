import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Route } from "playwright";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const vendor = "00000000-0000-4000-8000-000000000001";
const added = "00000000-0000-4000-8000-000000000777";
const other = "00000000-0000-4000-8000-000000000888";
type Sent = { method: string; path: string; body: Record<string, unknown> | null };

async function setup(
  t: import("node:test").TestContext,
  path: string,
  answer: (sent: Sent) => { status: number; json: unknown },
  { width = 1440, theme = "dark" }: { width?: number; theme?: "dark" | "light" } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(
    (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
    theme,
  );
  const sent: Sent[] = [];
  await page.route("https://**", (route) => route.abort());
  // A record added in the test is outside the synthetic directory, so its drawer reads as not found.
  await page.route("**/api/v1/business/**", (route) => {
    try {
      return route.fulfill({ json: directoryFixture(route.request().url()) });
    } catch {
      return route.fulfill({ status: 404, json: { error: "RECORD_NOT_FOUND" } });
    }
  });
  await page.route("**/mcp", (route) =>
    route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: route.request().postDataJSON()?.id,
        result: { content: [{ type: "text", text: "{}" }] },
      },
    }),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/api/engine/**", (route: Route) => {
    const request = route.request();
    const call = {
      method: request.method(),
      path: new URL(request.url()).pathname + new URL(request.url()).search,
      body: request.postDataJSON(),
    };
    sent.push(call);
    const { status, json } = answer(call);
    return route.fulfill({ status, json });
  });
  // A local host opts into the live client explicitly.
  await page.goto(`${server.url}${path}${path.includes("?") ? "&" : "?"}mode=live`);
  return { page, sent };
}

const posts = (sent: Sent[]) => sent.filter((call) => call.method === "POST");
const withoutKey = ({ idempotency_key, ...body }: Record<string, unknown>) => {
  assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
  return body;
};

// The page under the modal dialog is checked by the phone accessibility walk; this checks the dialog.
async function assertTargets(page: Page, label: string) {
  const observed = await inspectPhoneAccessibility(page);
  const inDialog = (targets: { selector: string }[]) => targets.filter((target) => target.selector.includes("dialog"));
  assert.equal(observed.overflow, false, `${label}: no sideways scroll`);
  assert.deepEqual(inDialog(observed.small), [], `${label}: every control is at least 44 by 44`);
  assert.deepEqual(inDialog(observed.covered), [], `${label}: every control is reachable`);
  assert.deepEqual(observed.violations, [], `${label}: no accessibility violations`);
}

const themes: ("light" | "dark")[] = ["light", "dark"];
for (const theme of themes)
  test(`New client offers a likely duplicate, then saves a separate record at 390 px in ${theme}`, async (t) => {
    const { page, sent } = await setup(
      t,
      "/clients",
      ({ path, body }) => {
        if (path === "/api/engine/parties" && !body?.force_new)
          return {
            status: 409,
            json: {
              error: "party_exists",
              candidates: [{ id: other, name: "Example Smile Studio", city: "Demo City" }],
            },
          };
        if (path === "/api/engine/parties")
          return { status: 201, json: { party_id: added, name: "Example Smile Studio" } };
        return { status: 201, json: { party_id: added, status: "roster" } };
      },
      { width: 390, theme },
    );
    const open = await page.getByRole("button", { name: "New client" }).boundingBox();
    assert.ok(open && open.height >= 44 && open.width >= 44);
    await page.getByRole("button", { name: "New client" }).click();
    const dialog = page.getByRole("dialog", { name: "New client" });
    await dialog.getByLabel("Name").fill("Example Smile Studio");
    await dialog.getByLabel("Email").fill("front@example.test");
    await dialog.getByLabel("Phone").fill("(202) 555-0101");
    await dialog.getByLabel("How found").selectOption("referral");
    await dialog.getByLabel("Practice type").fill("Dental");
    await assertTargets(page, `New client ${theme}`);
    await dialog.getByRole("button", { name: "Save client" }).click();
    await dialog.getByRole("button", { name: "Use Example Smile Studio · Demo City" }).waitFor();
    await dialog.getByRole("button", { name: "Save as a separate record" }).click();
    await page.waitForURL(`**/clients?record=${added}`);
    assert.equal(await dialog.count(), 0);
    const [first, separate, client] = posts(sent);
    assert.deepEqual(withoutKey(first?.body ?? {}), {
      kind: "company",
      name: "Example Smile Studio",
      email: "front@example.test",
      phone: "(202) 555-0101",
    });
    assert.deepEqual(withoutKey(separate?.body ?? {}), { ...withoutKey(first?.body ?? {}), force_new: true });
    assert.equal(client?.path, "/api/engine/clients");
    assert.deepEqual(withoutKey(client?.body ?? {}), {
      party_id: added,
      how_found: "referral",
      status: "roster",
      vertical: "Dental",
    });
  });

test("New client can use the existing record a partner picks", async (t) => {
  const { page, sent } = await setup(t, "/clients", ({ path }) =>
    path === "/api/engine/parties"
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Example Smile Studio", city: null }] },
        }
      : { status: 201, json: { party_id: other } },
  );
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Smile Studio");
  await dialog.getByLabel("How found").selectOption("event");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByRole("button", { name: "Use Example Smile Studio" }).click();
  await page.waitForURL(`**/clients?record=${other}`);
  assert.deepEqual(
    posts(sent).map((call) => call.path),
    ["/api/engine/parties", "/api/engine/clients"],
  );
});

test("Edit sends only what changed, with what the partner saw, and explains a conflict", async (t) => {
  let conflict = true;
  const record = {
    party_id: vendor,
    kind: "company",
    name: "Demo Partner 01",
    city: "Demo City",
    email: "hello@example.test",
    phone: { number: "+12025550101", extension: null, shown: "+12025550101" },
    company: null,
    client: null,
    vendor: {
      party_id: vendor,
      stage: null,
      relationship_level: 1,
      owner: "joe",
      offers: null,
      seeking: null,
      is_target: false,
      disposition: null,
      disposition_reason: null,
      categories: [],
    },
  };
  const { page, sent } = await setup(t, `/vendors?record=${vendor}`, ({ method, path }) => {
    if (method === "GET") return { status: 200, json: record };
    if (path === `/api/engine/vendors/${vendor}` && conflict) {
      conflict = false;
      return { status: 409, json: { error: "version_conflict", fields: ["relationship_level"] } };
    }
    if (path === `/api/engine/parties/${vendor}`)
      return {
        status: 200,
        json: { ...record, phone: { number: "+12025550199", extension: null, shown: "+12025550199" } },
      };
    return { status: 200, json: { party_id: vendor } };
  });
  const panel = page.locator("#recordPanel");
  await panel.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("Phone").fill("202-555-0199");
  await dialog.getByLabel("Banking").check();
  await dialog.getByLabel("Relationship level").selectOption("2");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Someone changed this record since you opened it.").waitFor();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [contact, refused, role] = posts(sent);
  assert.equal(contact?.path, `/api/engine/parties/${vendor}`);
  assert.deepEqual(withoutKey(contact?.body ?? {}), { phone: { from: "+12025550101", to: "202-555-0199" } });
  assert.deepEqual(withoutKey(refused?.body ?? {}), {
    categories: { from: [], to: ["banker"] },
    relationship_level: { from: 1, to: 2 },
  });
  assert.deepEqual(withoutKey(role?.body ?? {}), withoutKey(refused?.body ?? {}));
});

test("Link to someone finds the other record and saves the link", async (t) => {
  const { page, sent } = await setup(t, `/vendors?record=${vendor}`, ({ method, path }) =>
    method === "GET" && path.startsWith("/api/engine/parties/search")
      ? {
          status: 200,
          json: {
            ok: true,
            parties: [{ id: other, display_name: "Avery Example", kind: "person", city: "Demo City" }],
          },
        }
      : { status: 201, json: { link_id: "00000000-0000-4000-8000-000000000999" } },
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Link to someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Link Demo Partner 01 to someone" });
  await dialog.getByLabel("Link", { exact: true }).selectOption("can_introduce");
  await dialog.getByLabel("Find a person or company").fill("Avery");
  await dialog.getByLabel("Avery Example · Demo City").check();
  await dialog.getByLabel("Note").fill("Met at a study club");
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [link] = posts(sent);
  assert.equal(link?.path, "/api/engine/party-links");
  assert.deepEqual(withoutKey(link?.body ?? {}), {
    kind: "can_introduce",
    party_id: vendor,
    other_party_id: other,
    note: "Met at a study club",
  });
});
