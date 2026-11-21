import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { validateLeadWorkspace } from "../js/leads-client.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseReachability } from "../src/ui/lead-reachability.ts";
import { chromium } from "./browser-harness.mjs";

test("views, keyboard selection, refresh, source change and retirement at both widths and themes", async (t) => {
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/lead-reachability/producer.json", import.meta.url), "utf8"),
  );
  const schema = JSON.parse(
    await readFile(new URL("../contracts/lead-reachability.v2/contract.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv({ strict: false, formats: { uuid: true, date: true, "date-time": true } });
  const validate = ajv.compile(schema);
  let current = { ...recording.cases.reachable, city: "Pensacola", state: "FL" };
  const malformed: Record<string, (value: Record<string, unknown>) => void> = {
    invalid: (value) => {
      value.classification = "invalid";
    },
    route: (value) => {
      assert.ok(value.usable_route && typeof value.usable_route === "object");
      Reflect.set(value.usable_route, "kind", "telepathy");
    },
    contact: (value) => {
      value.successful_contact = {};
    },
    evidence: (value) => {
      value.evidence = [{}];
    },
    inputs: (value) => {
      delete value.source_inputs;
    },
  };
  let failure = "";
  const calls: string[] = [];
  const board = () => {
    assert.equal(validate(current.reachability), true);
    parseReachability(current.reachability);
    return validateLeadWorkspace({
      schema_version: "lead-workspace.v1",
      generated_at: current.reachability.evaluated_at,
      leads: [current],
    });
  };
  const assets = await appAssetSnapshot();
  const mapScript = assets.get("/js/leads-territory-map.js");
  assert.ok(mapScript);
  assets.set("/js/leads-territory-map.js", {
    ...mapScript,
    body: Buffer.from(
      (await readFile(new URL("../js/leads-territory-map.js", import.meta.url), "utf8")).replace(
        "const markers = new Map();",
        'Reflect.set(globalThis,"reachabilityMap",map); const markers = new Map();',
      ),
    ),
  });
  const server = await startWorkerFixture({
    assets,
    env: {
      APP_ENV: "fixture",
      CARR: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname !== "/mcp")
            return Response.json({ actor: { slug: "example-partner" }, csrf_token: "synthetic" });
          const body = await request.json();
          const name = body.params.name;
          calls.push(name);
          if (name === "lead-board" && ["denied", "stale"].includes(failure))
            return failure === "denied" ? new Response("", { status: 403 }) : new Response("", { status: 503 });
          const payload =
            name === "lead-board"
              ? { ...board(), ...(body.params.arguments.lead_id ? { detail: current } : {}) }
              : name === "quiet-follow-ups"
                ? {
                    schema_version: "quiet-follow-ups.v1",
                    cadence: { lead_days: 45, vendor_days: 90 },
                    proposals: [],
                    sent: false,
                    tasks_created: false,
                  }
                : { error: "unsupported_fixture_read" };
          if ("leads" in payload && failure === "workspace")
            payload.leads = payload.leads.map((row) => ({ ...row, stage: null }));
          else if ("leads" in payload && Object.hasOwn(malformed, failure)) {
            const invalid = {
              ...structuredClone(current),
              id: "example-unverified",
              doctor_name: "Example Unverified Lead",
            };
            const research = {
              ...recording.cases.unknown,
              id: "example-research",
              doctor_name: "Example Research Lead",
            };
            const mutate = malformed[failure];
            assert.ok(mutate);
            mutate(invalid.reachability);
            payload.leads.push(research, invalid);
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          });
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const screenshots = "out/test-artifacts/lead-reachability";
  await mkdir(screenshots, { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      current = { ...recording.cases.reachable, city: "Pensacola", state: "FL" };
      failure = "";
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        for (const mutation of Object.keys(malformed)) {
          failure = mutation;
          await page.goto(`${server.origin}/leads`);
          await page.locator('#leadBoard[aria-busy="false"]').waitFor();
          assert.equal(await page.locator("#leadBoardError").isVisible(), false, mutation);
          assert.equal(await page.locator(".lead-card").count(), 3, mutation);
          await page.locator("#reachabilityFilter").selectOption("research");
          assert.equal(await page.locator(".lead-card").count(), 1, mutation);
          assert.equal(await page.locator(".lead-open").textContent(), "Example Research Lead");
        }
        failure = "";
        await page.goto(`${server.origin}/leads`);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.locator(".lead-card").waitFor();
        assert.equal(await page.locator("#reachabilityFilter").isVisible(), false);
        await page.locator(".lead-open").focus();
        await page.keyboard.press("Enter");
        await page.locator("#leadDetail[open]").waitFor();
        assert.equal(await page.locator("#detailTitle").textContent(), current.doctor_name);
        await page.locator("#closeDetail").click();
        await page.locator("#refreshBoard").click();
        await page.locator('#leadBoard[aria-busy="false"]').waitFor();
        assert.equal(await page.locator(".lead-card").getAttribute("data-selected"), "true");
        await page.locator("#leadBoard").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${screenshots}/${width}-${theme}.png` });
        await page.locator("#showTerritory").click();
        await page.locator(".market-marker").first().waitFor();
        const canvas = await page.locator("#territoryMap canvas").elementHandle();
        assert.ok(canvas);
        const camera = await page.evaluate(() => {
          const map = Reflect.get(window, "reachabilityMap");
          return { center: map.getCenter().toArray(), zoom: map.getZoom() };
        });
        const membership = async () => {
          const boardIds = await page
            .locator("#leadBoard .lead-card")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-lead-id")).sort());
          const markers = await page
            .locator(".market-marker")
            .evaluateAll((nodes) => nodes.flatMap((node) => JSON.parse(node.getAttribute("data-lead-ids") || "[]")));
          assert.ok(markers.every((id) => boardIds.includes(id)));
          const marketTotal = await page
            .locator("#marketCounts b")
            .evaluateAll((nodes) => nodes.reduce((sum, node) => sum + Number(node.textContent), 0));
          assert.equal(marketTotal, boardIds.length);
        };
        await membership();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        current = recording.cases.unknown;
        await page.locator("#refreshBoard").click();
        await page.locator('#leadBoard[aria-busy="false"]').waitFor();
        assert.equal(await page.locator(".lead-card").count(), 1);
        assert.equal(await page.locator("#reachabilityFilter").isVisible(), false);
        assert.equal(await page.locator(".lead-card .work-card-body").count(), 0);
        await membership();
        assert.equal(await canvas.evaluate((node) => node.isConnected), true);
        assert.deepEqual(
          await page.evaluate(() => {
            const map = Reflect.get(window, "reachabilityMap");
            return { center: map.getCenter().toArray(), zoom: map.getZoom() };
          }),
          camera,
        );
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        assert.equal(await page.locator(".lead-card").count(), 0);
        assert.equal(await page.locator(".market-marker").count(), 0);
        await page.locator("#refreshBoard").click();
        await page.locator(".lead-card").waitFor();
        failure = "stale";
        await page.locator("#refreshBoard").click();
        await page.locator("#leadBoardError").waitFor();
        assert.match((await page.locator("#leadBoardError").textContent()) || "", /Source stale/);
        assert.equal(await page.locator(".lead-card").count(), 1);
        failure = "";
        await page.locator("#refreshBoard").click();
        await page.locator("#leadBoardError").waitFor({ state: "hidden" });
        assert.equal(await page.locator(".lead-card").count(), 1);
        failure = "workspace";
        await page.locator("#refreshBoard").click();
        await page.waitForFunction(
          () =>
            document.getElementById("leadBoardError")?.textContent ===
            "Leads couldn't be loaded. Showing the last update. Retry",
        );
        failure = "denied";
        await page.locator("#refreshBoard").click();
        await page.getByText("Sign-in required", { exact: false }).first().waitFor();
        assert.equal(await page.locator(".lead-card").count(), 0);
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        assert.equal(await page.locator(".market-marker").count(), 0);
      } catch (error) {
        console.error(await page.locator("#leadBoardError").textContent());
        throw error;
      } finally {
        await page.close();
      }
    }
  assert.equal(
    calls.some((name) => ["claim-lead", "update-lead", "send-email"].includes(name)),
    false,
  );
});

test("proof CLI passes synthetic fixture, rejects a near miss, and refuses missing releases", async () => {
  const { execFile } = await import("node:child_process");
  const run = (args: string[]) =>
    new Promise<number>((resolve) => {
      execFile(process.execPath, ["scripts/prove-lead-reachability.ts", ...args], { timeout: 10000 }, (error) =>
        resolve(error && typeof error.code === "number" ? error.code : error ? 1 : 0),
      );
    });
  const base = ["--origin", "http://localhost", "--expected-commit", "1".repeat(40)];
  assert.equal(await run([...base, "--fixture-case", "pass"]), 0);
  assert.equal(await run([...base, "--fixture-case", "fail"]), 1);
  assert.equal(await run(base), 78);
});

test("natural production proof observer checks real fixture UI and refuses a changed count", async () => {
  const { execFile } = await import("node:child_process");
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/lead-reachability/producer.json", import.meta.url), "utf8"),
  );
  const schema = JSON.parse(
    await readFile(new URL("../contracts/lead-reachability.v2/contract.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv({ strict: false, formats: { uuid: true, date: true, "date-time": true } }).compile(schema);
  const leads = [
    { ...recording.cases.reachable, city: "Pensacola", state: "FL" },
    { ...recording.cases.unknown, id: "00000000-0000-4000-8000-000000000002" },
  ];
  for (const lead of leads) {
    assert.equal(validate(lead.reachability), true);
    parseReachability(lead.reachability);
  }
  const board = validateLeadWorkspace({
    schema_version: "lead-workspace.v1",
    generated_at: recording.cases.reachable.reachability.evaluated_at,
    leads,
  });
  const original = await appAssetSnapshot();
  for (const change of [false, true]) {
    const assets = new Map(original);
    if (change) {
      const path = "/js/leads-workspace-app.js";
      const asset = assets.get(path);
      assert.ok(asset);
      const source = asset.body.toString();
      const modified = source.replace('"lead":"leads"', '"visible lead":"visible leads"');
      assert.notEqual(modified, source);
      assets.set(path, { ...asset, body: Buffer.from(modified) });
    }
    const server = await startWorkerFixture({
      assets,
      routes: new Map([
        ["/release", { contentType: "application/json", body: JSON.stringify({ git_sha: "2".repeat(40) }) }],
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({
              service: "doctorcre-app",
              environment: "production",
              source_commit: "1".repeat(40),
            }),
          },
        ],
      ]),
      env: {
        APP_ENV: "fixture",
        CARR: {
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname !== "/mcp")
              return Response.json({ actor: { slug: "example-partner" }, csrf_token: "synthetic" });
            const body = await request.json();
            const payload =
              body.params.name === "lead-board"
                ? {
                    ...board,
                    ...(body.params.arguments.lead_id
                      ? { detail: leads.find((row) => row.id === body.params.arguments.lead_id) }
                      : {}),
                  }
                : { error: "unsupported_fixture_read" };
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          },
        },
      },
    });
    try {
      const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            "scripts/prove-lead-reachability.ts",
            "--origin",
            server.origin,
            "--expected-commit",
            "1".repeat(40),
            "--producer-origin",
            server.origin,
            "--producer-commit",
            "2".repeat(40),
            "--producer-repository",
            ".",
            "--timeout-ms",
            "30000",
          ],
          { timeout: 40000 },
          (error, stdout) =>
            resolve({ code: error && typeof error.code === "number" ? error.code : error ? 1 : 0, stdout }),
        );
      });
      assert.equal(result.code, change ? 1 : 0, result.stdout);
    } finally {
      await server.close();
    }
  }
});
