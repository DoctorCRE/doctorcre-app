import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Route } from "playwright";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const added = "00000000-0000-4000-8000-000000000777";
const other = "00000000-0000-4000-8000-000000000888";
const firstClient = "00000000-0000-4000-8000-000000000001";
type Sent = { method: string; path: string; body: Record<string, unknown> | null };

async function setup(
  t: import("node:test").TestContext,
  path: string,
  answer: (sent: Sent) => { status: number; json: unknown },
  {
    width = 1440,
    theme = "dark",
    engineSwitch = true,
  }: { width?: number; theme?: "dark" | "light"; engineSwitch?: boolean } = {},
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
  await page.route(
    (url) => url.pathname === "/clients" || url.pathname === "/vendors",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      return route.fulfill({
        response,
        body: engineSwitch ? html.replace("<html ", "<html data-clients-vendors-from-engine ") : html,
      });
    },
  );
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

test("New vendor fits a 560 px form at 1440, offers no relationship level, and explains a refused save plainly", async (t) => {
  const { page, sent } = await setup(t, "/vendors", ({ path }) =>
    path === "/api/engine/parties"
      ? { status: 201, json: { party_id: added, name: "Example Lending" } }
      : { status: 422, json: { error: "database_refused_the_statement", rule: "party_role_avoid_not_target" } },
  );
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const box = await dialog.boundingBox();
  assert.ok(box && box.width <= 560 && box.width >= 540, `form is about 560 px wide, not ${box?.width}`);
  assert.equal(await dialog.getByLabel("Relationship level").count(), 0);
  await dialog.getByLabel("Name").fill("Example Lending");
  await dialog.getByLabel("Banking").check();
  await dialog.getByRole("button", { name: "Save vendor" }).click();
  await dialog.getByText("This was not saved. Try again.").waitFor();
  const [, role] = posts(sent);
  assert.deepEqual(withoutKey(role?.body ?? {}), { party_id: added, categories: ["banker"] });
});

test("An edit after an unanswered save clears Not confirmed yet and saves the new values", async (t) => {
  let answered = false;
  const { page, sent } = await setup(t, "/clients", ({ path }) => {
    if (path === "/api/engine/parties" && !answered) {
      answered = true;
      return { status: 503, json: { error: "database_unavailable" } };
    }
    return path === "/api/engine/parties"
      ? { status: 201, json: { party_id: added, name: "Example Dental Group" } }
      : { status: 201, json: { party_id: added } };
  });
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByLabel("How found").selectOption("inbound");
  await dialog.getByRole("button", { name: "Save client" }).click();
  const status = dialog.locator("[data-status]");
  await dialog.getByText("Not confirmed yet.").waitFor();
  await dialog.getByLabel("Name").fill("Example Dental Group");
  assert.equal(await status.textContent(), "");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
  const [unanswered, party] = posts(sent);
  assert.equal(party?.body?.name, "Example Dental Group");
  assert.notEqual(party?.body?.idempotency_key, unanswered?.body?.idempotency_key);
});

test("Without the Clients and Vendors switch there is no New client, and the record says Practice type", async (t) => {
  const { page } = await setup(t, `/clients?record=${firstClient}`, () => ({ status: 404, json: {} }), {
    engineSwitch: false,
  });
  const panel = page.locator("#recordPanel");
  await panel.getByText("Practice type").first().waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await panel.getByText("Vertical", { exact: true }).count(), 0);
  assert.equal(await page.locator(".party-new").count(), 0);
});
