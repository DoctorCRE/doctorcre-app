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
const vendor = firstClient;
type Sent = { method: string; path: string; body: Record<string, unknown> | null };
type Answer = { status: number; json: unknown };

async function setup(
  t: import("node:test").TestContext,
  path: string,
  answer: (sent: Sent) => Answer | Promise<Answer>,
  {
    width = 1440,
    theme = "dark",
    engineSwitch = true,
    holdList = false,
    record = {},
    facets = {},
    activity,
  }: {
    width?: number;
    theme?: "dark" | "light";
    engineSwitch?: boolean;
    // The list read, and the filter choices it carries, never arrives.
    holdList?: boolean;
    // Fields the record read adds, as a newer engine would.
    record?: Record<string, unknown>;
    // Filter choices the list read adds.
    facets?: Record<string, unknown>;
    // The record's activity answers once this settles.
    activity?: Promise<void>;
  } = {},
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
  const listHeld = new Promise<void>((release) => t.after(() => release()));
  await page.route("**/api/v1/business/**", async (route) => {
    const url = new URL(route.request().url());
    const isList = url.pathname.split("/").length === 5;
    if (holdList && isList) return listHeld.then(() => route.abort());
    try {
      const json = directoryFixture(url.href);
      return route.fulfill({
        json: isList
          ? { ...json, facets: Object.assign({}, json.facets, facets) }
          : { ...json, record: Object.assign({}, json.record, record) },
      });
    } catch {
      return route.fulfill({ status: 404, json: { error: "RECORD_NOT_FOUND" } });
    }
  });
  await page.route("**/mcp", async (route) => {
    await activity;
    return route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: route.request().postDataJSON()?.id,
        result: { content: [{ type: "text", text: "{}" }] },
      },
    });
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/api/engine/**", async (route: Route) => {
    const request = route.request();
    const call = {
      method: request.method(),
      path: new URL(request.url()).pathname + new URL(request.url()).search,
      body: request.postDataJSON(),
    };
    sent.push(call);
    const { status, json } = await answer(call);
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
    const radio = await dialog.getByLabel("Company").boundingBox();
    assert.ok(radio && radio.width <= 24 && radio.height <= 24, `the radio box is small, not ${radio?.width}`);
    await dialog.getByRole("button", { name: "Save client" }).click();
    const use = dialog.getByRole("button", { name: "Use Example Smile Studio · Demo City" });
    await use.waitFor();
    assert.equal(
      await use.evaluate(
        (choice) => choice === document.activeElement && choice.getBoundingClientRect().bottom <= innerHeight,
      ),
      true,
      "the first choice has focus and is in view",
    );
    await dialog.getByText("An existing record keeps its own email, phone and city").waitFor();
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

// Saves edits as the engine does: a field whose from is not what it holds now is refused with the current record.
function engine(party: Record<string, unknown>, role: "client" | "vendor", profile: Record<string, unknown>) {
  // The contact holds its phone as the engine shows it.
  const state = { contact: { ...party }, profile: { ...profile } };
  const contactRead = () => ({ ...state.contact, phone: state.contact.phone ? { shown: state.contact.phone } : null });
  const changesIn = (body: Record<string, unknown> | null) =>
    Object.entries(body ?? {}).flatMap(([name, change]) =>
      typeof change === "object" && change !== null && "from" in change && "to" in change
        ? [{ name, from: change.from, to: change.to }]
        : [],
    );
  const edit = (held: Record<string, unknown>, body: Record<string, unknown> | null, read: () => unknown) => {
    const changes = changesIn(body);
    const stale = changes.filter(({ name, from }) => JSON.stringify(from) !== JSON.stringify(held[name] ?? null));
    if (stale.length)
      return {
        status: 409,
        json: { error: "version_conflict", fields: stale.map(({ name }) => name), current: read() },
      };
    for (const { name, to } of changes)
      held[name] = name === "phone" && typeof to === "string" ? `+1${to.replace(/\D/g, "")}` : to;
    return { status: 200, json: read() };
  };
  return {
    state,
    answer({ method, path, body }: Sent): Answer {
      const id = state.contact.party_id;
      if (method === "GET" && path === `/api/engine/parties/${id}`)
        return { status: 200, json: { ...contactRead(), client: null, vendor: null, [role]: state.profile } };
      if (path === `/api/engine/parties/${id}`) return edit(state.contact, body, contactRead);
      if (path === `/api/engine/${role}s/${id}`) return edit(state.profile, body, () => state.profile);
      return { status: 500, json: {} };
    },
  };
}
const vendorParty = {
  party_id: vendor,
  kind: "company",
  name: "Demo Partner 01",
  city: "Demo City",
  email: "hello@example.test",
  phone: "+12025550101",
  company: null,
};
const vendorProfile = { party_id: vendor, stage: "warm", offers: null, categories: ["banker"] };

test("Edit takes the record's current values after a conflict, so the next save applies what the partner typed", async (t) => {
  const fake = engine(vendorParty, "vendor", { ...vendorProfile, categories: [] });
  const { page, sent } = await setup(t, `/vendors?record=${vendor}`, fake.answer);
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("Phone").fill("202-555-0199");
  await dialog.getByLabel("Banking").check();
  fake.state.profile.categories = ["lender"];
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Someone changed this since you opened it. Now: Categories Lender.").waitFor();
  assert.equal(await dialog.getByLabel("Banking").isChecked(), true);
  assert.equal(await dialog.getByLabel("Phone").inputValue(), "(202) 555-0199");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [contact, refused, role] = posts(sent);
  assert.equal(contact?.path, `/api/engine/parties/${vendor}`);
  assert.deepEqual(withoutKey(contact?.body ?? {}), { phone: { from: "+12025550101", to: "202-555-0199" } });
  assert.deepEqual(withoutKey(refused?.body ?? {}), { categories: { from: [], to: ["banker"] } });
  assert.deepEqual(withoutKey(role?.body ?? {}), { categories: { from: ["lender"], to: ["banker"] } });
  assert.equal(posts(sent).length, 3);
});

test("Edit before the list's choices load keeps the record's categories and stage, and saves only the city", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page, sent } = await setup(t, `/vendors?record=${vendor}`, fake.answer, { holdList: true });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  assert.equal(await dialog.getByLabel("Banker").isChecked(), true);
  assert.equal(await dialog.getByLabel("Stage").inputValue(), "warm");
  await dialog.getByLabel("City").fill("Example Town");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    posts(sent).map((call) => [call.path, withoutKey(call.body ?? {})]),
    [[`/api/engine/parties/${vendor}`, { city: { from: "Demo City", to: "Example Town" } }]],
  );
});

test("Edit on a client opened by its old id edits the party the record names", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: "group_practice",
    how_found: "not_recorded",
    vertical: "Dental",
  });
  const { page, sent } = await setup(t, `/clients?record=${firstClient}`, fake.answer, {
    record: { party_id: party },
    width: 390,
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  assert.equal(await dialog.getByLabel("Client type").inputValue(), "group_practice");
  assert.equal(await dialog.getByLabel("How found").locator("option", { hasText: "Not recorded" }).count(), 1);
  await assertTargets(page, "Edit client");
  await dialog.getByLabel("Practice type").fill("Orthodontics");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    sent.filter((call) => /\/(parties|clients)\//.test(call.path)).map((call) => call.path),
    [`/api/engine/parties/${party}`, `/api/engine/clients/${party}`],
  );
  assert.deepEqual(withoutKey(posts(sent)[0]?.body ?? {}), { vertical: { from: "Dental", to: "Orthodontics" } });
});

test("Edit says it is opening and opens once however often it is pressed", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle = () => {};
  const activity = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { page, sent } = await setup(
    t,
    `/vendors?record=${vendor}`,
    async (call) => {
      if (call.method === "GET") await read;
      return fake.answer(call);
    },
    { activity },
  );
  const button = page.locator("#recordPanel").getByRole("button", { name: "Edit" });
  await button.click();
  // Settled activity redraws the record panel while Edit is still opening.
  settle();
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  const opening = page.locator("#recordPanel").getByRole("button", { name: "Opening…" });
  assert.equal(await opening.isDisabled(), true);
  await opening.click({ force: true });
  release();
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor();
  assert.equal(await button.isEnabled(), true, "the redrawn Edit is ready again");
  await button.click({ force: true }).catch(() => {});
  assert.equal(sent.filter((call) => call.path === `/api/engine/parties/${vendor}`).length, 1);
});

test("Edit to an email another record has offers that record, and Keep this email saves it anyway", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page, sent } = await setup(t, `/vendors?record=${vendor}`, (call) =>
    call.method === "POST" && call.path === `/api/engine/parties/${vendor}` && !call.body?.force_new
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Demo Partner 02", city: null }] },
        }
      : fake.answer(call),
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("Email").fill("shared@example.test");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Another record has this email.").waitFor();
  await dialog.getByRole("button", { name: "Open Demo Partner 02" }).waitFor();
  await dialog.getByRole("button", { name: "Keep this email" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [refused, kept] = posts(sent);
  assert.deepEqual(withoutKey(kept?.body ?? {}), { ...withoutKey(refused?.body ?? {}), force_new: true });
  assert.equal(fake.state.contact.email, "shared@example.test");
});

test("Open on another record's email opens it in the list that holds it", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const otherVendor = "00000000-0000-4000-8000-000000000002";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: null,
    how_found: "inbound",
    vertical: null,
  });
  const { page } = await setup(
    t,
    `/clients?record=${firstClient}`,
    (call) =>
      call.path === `/api/engine/parties/${otherVendor}`
        ? { status: 200, json: { ...vendorParty, party_id: otherVendor, client: null, vendor: vendorProfile } }
        : call.method === "POST" && call.path === `/api/engine/parties/${party}`
          ? {
              status: 409,
              json: { error: "party_exists", candidates: [{ id: otherVendor, name: "Demo Partner 02", city: null }] },
            }
          : fake.answer(call),
    { record: { party_id: party } },
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  await dialog.getByLabel("Email").fill("shared@example.test");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByRole("button", { name: "Open Demo Partner 02" }).click();
  await page.waitForURL(`**/vendors?record=${otherVendor}`);
  await page.locator("#recordPanel").getByRole("heading", { name: "Demo Partner 02" }).waitFor();
});

test("Edit opened from the keyboard gives focus back to Edit when it closes", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page } = await setup(t, `/vendors?record=${vendor}`, fake.answer);
  // Settled activity re-renders the panel, which would take keyboard focus off Edit before Enter lands.
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).press("Enter");
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-party-edit"), null, { timeout: 2000 });
});

test("A saved contact with a refused profile refreshes the record, and focus finds the new Edit", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page } = await setup(t, `/vendors?record=${vendor}`, (call) =>
    call.path === `/api/engine/vendors/${vendor}`
      ? { status: 422, json: { error: "invalid_field_value", fields: ["offers"] } }
      : fake.answer(call),
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("City").fill("Example Town");
  await dialog.getByLabel("What they offer").fill("Construction loans");
  const reread = page.waitForRequest(
    (request) => request.method() === "GET" && new URL(request.url()).pathname.endsWith(`/business/vendors/${vendor}`),
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Check the highlighted fields.").waitFor();
  await reread;
  assert.equal(fake.state.contact.city, "Example Town");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-party-edit"), null, { timeout: 2000 });
});

test("Edit names each choice from its own list and offers Not recorded only to a record that has it", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: null,
    how_found: "inbound",
    vertical: null,
  });
  const { page } = await setup(t, `/clients?record=${firstClient}`, fake.answer, {
    record: { party_id: party },
    facets: { types: [{ slug: "referral", label: "Referral practice" }] },
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  await dialog.getByText("Changing the practice type clears the subtype.").waitFor();
  assert.equal(await dialog.getByLabel("How found").locator("option", { hasText: "Not recorded" }).count(), 0);
  await dialog.getByLabel("How found").selectOption("event");
  await dialog.getByLabel("Client type").selectOption("referral");
  Object.assign(fake.state.profile, { how_found: "not_recorded", client_type: "referral" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog
    .getByText("Now: How found Not recorded; Client type Referral practice. Save again", { exact: false })
    .waitFor();
});

test("Edit does not open for a record the partner has already left", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { page } = await setup(t, `/vendors?record=${vendor}`, async (call) => {
    if (call.method === "GET") await read;
    return fake.answer(call);
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  await page.locator("#recordPanel").getByRole("button", { name: "Opening…" }).waitFor();
  await page.locator("#recordClose").click();
  await page.waitForURL((url) => !url.searchParams.has("record"));
  release();
  await page.waitForResponse((response) => response.url().endsWith(`/api/engine/parties/${vendor}`));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("Using an existing record that is already a vendor opens it", async (t) => {
  const { page, sent } = await setup(t, "/vendors", ({ path }) =>
    path === "/api/engine/parties"
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Example Lending", city: null }] },
        }
      : { status: 409, json: { error: "already_vendor", party_id: other } },
  );
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  await dialog.getByLabel("Name").fill("Example Lending");
  await dialog.getByRole("button", { name: "Save vendor" }).click();
  assert.equal(await dialog.getByText("An existing record keeps its own").count(), 0);
  await dialog.getByRole("button", { name: "Use Example Lending" }).click();
  await page.waitForURL(`**/vendors?record=${other}`);
  await page.getByText("This record is already a vendor, so it is open now.").waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal(posts(sent).length, 2);
});

test("A client saved while unconfirmed opens instead of refusing after an edit", async (t) => {
  let unanswered: unknown;
  const { page } = await setup(t, "/clients", ({ path, body }) => {
    if (path === "/api/engine/parties") return { status: 201, json: { party_id: added, name: "Example Dental" } };
    unanswered ??= body?.idempotency_key;
    return body?.idempotency_key === unanswered
      ? { status: 503, json: { error: "database_unavailable" } }
      : { status: 409, json: { error: "already_client", party_id: added } };
  });
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByLabel("How found").selectOption("inbound");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByText("Not confirmed yet.").waitFor();
  await dialog.getByLabel("Practice type").fill("Dental");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
  await page.getByText("This record is already a client, so it is open now.").waitFor();
});

test("New client asks for How found before saving anything, and says what is wrong", async (t) => {
  const { page, sent } = await setup(t, "/clients", () => ({ status: 201, json: { party_id: added } }));
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByText("Fill in the highlighted fields.").waitFor();
  const howFound = dialog.getByLabel("How found");
  assert.equal(await howFound.getAttribute("aria-invalid"), "true");
  assert.equal(await dialog.getByRole("combobox", { name: "How found", description: "Fill this in." }).count(), 1);
  assert.equal(await dialog.getByLabel("Name").getAttribute("aria-invalid"), null);
  assert.equal(posts(sent).length, 0);
  await howFound.selectOption("event");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
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
