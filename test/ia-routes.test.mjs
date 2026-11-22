import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { routeContract as routeContract } from "../js/routes.js";
import { appShellMarkup, navigationItems } from "../js/navigation.js";
import { handleDoctorcreRequest } from "../src/worker.js";

const origin = "https://app.doctorcre.com";
const originalPaths = [
  "/", "/workspace", "/deals", "/leads",
  "/clients", "/vendors", "/calendar",
  "/tours",
  "/pipeline", "/business", "/status", "/notifications",
  "/conversations",
];

const newHomes = {
  "/workspace": "/",
  "/pipeline": "/deals?view=board",
  "/business": "/",
  "/notifications": "/updates",
  "/conversations": "/doc-chats",
};

const html = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const env = {
  CARR: { fetch: async () => new Response("admitted") },
  ASSETS: { fetch: async (request) => {
    const asset = new URL(request.url).pathname.slice(1);
    return new Response(await html(asset), { headers: { "content-type": "text/html" } });
  } },
};

test("the approved map accounts for every original path with a permanent home", async () => {
  assert.deepEqual(Object.keys(routeContract.redirects || {}).sort(), Object.keys(newHomes).sort());
  for (const path of originalPaths) {
    const response = await handleDoctorcreRequest(new Request(`${origin}${path}`), env);
    let destination = path;
    if (path in newHomes) {
      assert.equal(response.status, 308, `${path}: permanent redirect`);
      const location = new URL(response.headers.get("location"), origin);
      destination = `${location.pathname}${location.search}`;
      assert.equal(destination, newHomes[path], `${path}: approved home`);
    }
    const final = path in newHomes
      ? await handleDoctorcreRequest(new Request(`${origin}${destination}`), env)
      : response;
    assert.equal(final.status, 200, `${path}: destination renders`);
    const page = await final.text();
    assert.match(page, /id="appShell"/, `${path}: shared shell mount`);
    assert.match(page, /src="(?:\.\.\/)?\/?js\/app-shell\.js"/, `${path}: shared shell script`);
    assert.deepEqual(
      [...appShellMarkup(new URL(destination, origin).pathname).matchAll(/data-app-nav-item[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]),
      navigationItems.map((item) => item.label), `${path}: identical navigation`,
    );
  }
});

test("the shell has four primary sections and secondary destinations", () => {
  assert.deepEqual(navigationItems.filter(item => !item.secondary).map((item) => item.label),
    ["Home", "Deals", "Leads", "Vendors"]);
  const shell = appShellMarkup("/calendar");
  for (const name of ["Updates", "Phone capture", "Relationships", "Invoices", "Lease radar"]) {
    assert.match(shell, new RegExp(`aria-label="${name}"[^>]*href="[^"]+".*?<span class="app-shell-nav-label">${name}</span>`));
  }
});

test("legacy search and board links retain the query after redirection", async () => {
  const search = await handleDoctorcreRequest(new Request(`${origin}/business?q=mobile%20clinic`), env);
  assert.equal(search.status, 308);
  assert.equal(new URL(search.headers.get("location")).pathname, "/search");
  assert.equal(new URL(search.headers.get("location")).searchParams.get("q"), "mobile clinic");
  const charts = await handleDoctorcreRequest(new Request(`${origin}/business?charts=1&group=phase&pick=Pending`), env);
  assert.equal(charts.status, 308);
  assert.equal(new URL(charts.headers.get("location")).searchParams.get("view"), "charts");
  assert.equal(new URL(charts.headers.get("location")).searchParams.get("group"), "phase");
  const board = await handleDoctorcreRequest(new Request(`${origin}/pipeline?filter=active`), env);
  assert.equal(board.status, 308);
  assert.equal(new URL(board.headers.get("location")).pathname, "/deals");
  assert.equal(new URL(board.headers.get("location")).searchParams.get("view"), "board");
  assert.equal(new URL(board.headers.get("location")).searchParams.get("filter"), "active");
});
