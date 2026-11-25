import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const paginated = JSON.parse(await readFile(new URL("./fixtures/vendor-meetings/page.json", import.meta.url), "utf8"));

for (const path of ["/vendors", "/vendors?view=suggested"]) {
  test(`Vendor meetings opens Research at ${path}`, async (t) => {
    const { page, section, requests } = await setup(t, 1440, path);
    assert.equal(requests[0]?.view, "research");
    assert.equal(await section.getByRole("tab", { name: "Suggested", exact: true }).count(), 0);
    await section.getByText("A verified office is needed", { exact: true }).waitFor();
    await section.getByRole("link", { name: "Ada Synthetic" }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Demo Partner 01", exact: true }).waitFor();
  });
}

test("Unavailable calendar keeps Research rows and retries in place", async (t) => {
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  const recovered = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/ready.json", import.meta.url), "utf8"),
  );
  let meetingReads = 0;
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/mcp", (r) => {
    const req = r.request().postDataJSON();
    return r.fulfill({
      json: {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                req.params.name === "read-vendor-meetings"
                  ? (++meetingReads === 1 ? recording : recovered).research
                  : {},
              ),
            },
          ],
        },
      },
    });
  });
  await page.goto(`${server.url}/vendors`);
  await page.getByRole("button", { name: "People worth meeting", exact: true }).click();
  const section = page.getByRole("region", { name: "People worth meeting" });
  await section.getByText("Ada Synthetic", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await section.getByText("A verified office is needed", { exact: true }).count(), 1);
  assert.equal(await section.getByRole("alert").textContent({ timeout: 1000 }), "Calendar unavailable.");
  await section.getByRole("button", { name: "Retry calendar" }).click();
  await section.getByRole("heading", { name: "Possible meetings" }).waitFor();
  assert.equal(await section.getByRole("alert").count(), 0);
  assert.equal(meetingReads, 2);
});

async function setup(t: import("node:test").TestContext, width = 1440, path = "/vendors") {
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  const requests: { view: string; q: string; cursor?: string }[] = [];
  recording.research.items[0].vendor_id = "00000000-0000-4000-8000-000000000001";
  let mode = "ready";
  let release: (() => void) | undefined;
  await page.route("**/mcp", async (route) => {
    const request = route.request().postDataJSON();
    let payload: unknown = {};
    let isError = false;
    if (request.params.name === "read-vendor-meetings") {
      requests.push(request.params.arguments);
      const query = request.params.arguments;
      const held = mode === "hold";
      const failed = mode === "fail";
      payload = structuredClone(recording[query.view]);
      if (mode === "page") payload = structuredClone(paginated[query.view]);
      if (mode === "empty") payload = { ...recording[query.view], items: [], total: 0, calendar: { state: "empty" } };
      if (failed) {
        payload = { error: "vendor_meetings_unavailable" };
        isError = true;
      }
      if (held)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    await route
      .fulfill({
        json: {
          jsonrpc: "2.0",
          id: request.id,
          result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] },
        },
      })
      .catch(() => {});
  });
  await page.goto(`${server.url}${path}`);
  const section = page.getByRole("region", { name: "People worth meeting" });
  await page.getByRole("button", { name: "People worth meeting", exact: true }).click();
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
  return {
    page,
    section,
    requests,
    setMode: (next: string) => {
      mode = next;
    },
    release: () => release?.(),
  };
}
test("empty, failure and retry remain distinct", async (t) => {
  const { section, setMode } = await setup(t);
  setMode("empty");
  await section.getByRole("searchbox").fill("empty");
  await section.getByText("No people need research", { exact: true }).waitFor();
  assert.equal(await section.getByRole("alert").count(), 0);
  setMode("fail");
  await section.getByRole("searchbox").fill("failure");
  await section.getByText("People could not be loaded. Try again.", { exact: true }).waitFor();
  assert.equal(await section.getByText("Ada Synthetic", { exact: true }).count(), 0);
  setMode("ready");
  await section.getByRole("button", { name: "Retry people" }).click();
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
  setMode("fail");
  await section.getByRole("searchbox").fill("another failure");
  await section.getByText("People could not be loaded. Try again.", { exact: true }).waitFor();
  setMode("ready");
  await section.getByRole("searchbox").fill("recovered query");
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
});
test("pagination is query-bound when a new search retires the pending page", async (t) => {
  const { page, section, requests, setMode, release } = await setup(t);
  setMode("page");
  await section.getByRole("searchbox").fill("Ada");
  await section.getByRole("button", { name: "Next people" }).waitFor();
  setMode("hold");
  const nextPage = page.waitForRequest(
    (request) => request.url().endsWith("/mcp") && Boolean(request.postDataJSON()?.params?.arguments?.cursor),
  );
  await section.getByRole("button", { name: "Next people" }).click();
  const request = await nextPage;
  assert.equal(request.postDataJSON()?.params?.arguments?.cursor, paginated.research.next_cursor);
  setMode("ready");
  await section.getByRole("searchbox").fill("");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  assert.equal(requests.at(-1)?.cursor, undefined);
  release();
  setMode("page");
  await section.getByRole("searchbox").fill("Ada");
  await section.getByRole("button", { name: "Next people" }).click();
  await section.getByRole("button", { name: "Back to first people" }).waitFor();
  setMode("ready");
  await section.getByRole("searchbox").fill("new");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  assert.equal(requests.at(-1)?.cursor, undefined);
});
test("session retirement erases results and ignores pending responses", async (t) => {
  const { page, section, setMode, release } = await setup(t);
  setMode("hold");
  await section.getByRole("searchbox").fill("pending");
  await page.waitForTimeout(450);
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  release();
  await page.waitForTimeout(100);
  assert.equal(await section.count(), 0);
});
for (const width of [1440, 390])
  for (const theme of ["light", "dark"])
    test(`vendor meetings fit ${width} ${theme}`, async (t) => {
      const { page, section } = await setup(t, width);
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const { mkdir } = await import("node:fs/promises");
      await mkdir("out/test-artifacts/vendor-meetings", { recursive: true });
      await page.screenshot({
        path: `out/test-artifacts/vendor-meetings/research-${width}-${theme}.png`,
        fullPage: true,
      });
    });

test("query changes retire successful and failed late reads even when the adapter ignores cancellation", async (t) => {
  const { page } = await setup(t);
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  await page.evaluate(async (recording) => {
    const path = "/js/ui-vendor-meetings.generated.js";
    const { mountVendorMeetings } = await import(path);
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    const mounted = mountVendorMeetings(host, {
      load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      href: () => "/vendors",
      nameLabel: (value: string) => value,
      phoneLabel: (value: string) => value,
      timeLabel: (value: string) => value,
      open: () => {},
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 400));
    await tick();
    function search(value: string) {
      const input = host.querySelector("input");
      if (!input) throw Error("Missing search");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    search("new");
    await tick();
    pending[1]?.resolve(recording.research);
    await tick();
    pending[0]?.reject(Error("Old failure"));
    await tick();
    if (!host.textContent?.includes("A verified office is needed")) throw Error("Late failure replaced current result");
    search("third");
    await tick();
    search("fourth");
    await tick();
    if (pending.length !== 4) throw Error("Expected all four reads to start");
    pending[2]?.resolve(recording.research);
    await tick();
    if (host.querySelector("#vendor-meetings-results")?.getAttribute("aria-busy") !== "true")
      throw Error("Late response replaced current pending read");
    pending[3]?.resolve(recording.research);
    await tick();
    if (!host.textContent?.includes("A verified office is needed")) throw Error("Late success replaced current result");
    mounted.dispose();
    pending.at(-1)?.resolve(recording.research);
    await tick();
    if (host.textContent) throw Error("Disposed mount repainted");
  }, recording);
});

for (const mode of ["ready", "empty", "fail"])
  test(`session retirement clears ${mode} answers`, async (t) => {
    const { page, section, setMode } = await setup(t);
    if (mode !== "ready") {
      setMode(mode);
      await section.getByRole("searchbox").fill(mode);
      if (mode === "fail") await section.getByText("People could not be loaded. Try again.", { exact: true }).waitFor();
      else await section.getByText("No people need research", { exact: true }).waitFor();
    }
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    assert.equal(await section.count(), 0);
  });

test("possible meetings show Central times and a short partial-calendar warning", async (t) => {
  const { page, section } = await setup(t);
  const ready = JSON.parse(await readFile(new URL("./fixtures/vendor-meetings/ready.json", import.meta.url), "utf8"));
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                request.params.name === "read-vendor-meetings" ? ready[request.params.arguments.view] : {},
              ),
            },
          ],
        },
      },
    });
  });
  await section.getByRole("searchbox").fill("meeting");
  await section.getByText("Synthetic office visit", { exact: false }).waitFor();
  assert.deepEqual(await section.locator("h3 + ul time").allTextContents(), [
    "Nov 10, 2026, 6:50 PM",
    "Nov 10, 2026, 7:50 PM",
  ]);
  assert.equal(await section.getByText("Calendar incomplete", { exact: true }).count(), 1);
  for (const note of ready.research.calendar.notes)
    assert.equal(await section.getByText(note, { exact: true }).count(), 0);
});

test("the List tab restores the directory and People worth meeting keeps its search", async (t) => {
  const { page, section } = await setup(t, 390);
  const search = section.getByRole("searchbox");
  await search.fill("Ada");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "List", exact: true }).click();
  assert.equal(await section.isVisible(), false);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator(".record-row").first().isVisible(), true);
  await page.getByRole("button", { name: "People worth meeting", exact: true }).focus();
  await page.keyboard.press("Enter");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  assert.equal(await search.inputValue(), "Ada");
});
