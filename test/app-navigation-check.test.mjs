import { navigationItems } from "../js/navigation.js";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const routes = (await import("../js/routes.js")).routeContract.routes;
const pages = [...new Set(Object.values(routes))];
const expected = navigationItems.map(item => item.label);

test("workspace routes share navigation while the client portal stays outside the broker shell", () => {
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    if (page === "client-portal.html") {
      assert.doesNotMatch(html, /appShell|app-shell|navigation\.js|doc-context|doc-panel/, "client portal has no broker workspace shell");
      assert.match(html, /src="\/js\/client-portal\.js"/, "client portal mounts its dedicated reader");
      continue;
    }
    assert.match(html, /<link rel="stylesheet" href="\/css\/app-shell\.css">/, `${page}: shared shell styles`);
    assert.match(html, /<div id="appShell"><\/div><script type="module" src="\/js\/app-shell\.js"><\/script>/, `${page}: shared shell mount`);
    assert.equal((html.match(/id="appShell"/g) || []).length, 1, `${page}: exactly one shell`);
    assert.doesNotMatch(html, /class="(?:primary-nav|mobile-nav|leads-nav|room-nav|workspaces|system-work-session)"/, `${page}: no second global navigation`);
  }
});

test("the shared navigation has one stable set of destinations, including every partner destination", async () => {
  const { appShellMarkup, activeDestination } = await import("../js/navigation.js");
  for (const route of Object.keys(routes)) {
    const html = appShellMarkup(route);
    const labels = [...html.matchAll(/data-app-nav-item[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(labels, expected, `${route}: same order and items`);
    assert.doesNotMatch(html, />Agent (?:Room|Queue)<\/a>/);
    const current = navigationItems.some(item => item.href === activeDestination(route))
      || ["/search", "/doc-chats", "/settings"].includes(route);
    assert.equal((html.match(/aria-current="page"/g) || []).length, Number(current), `${route}: current when present in navigation`);
  }
});

test("Deals has one global Deals link and local views are labelled as views", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  assert.match(html, /<body class="dealroom-page">\s*<script src="\/js\/theme-boot\.js"><\/script>/, "theme lives on <html>; the body carries no theme class");
  assert.doesNotMatch(html, /<nav class="workspaces"/);
  assert.match(html, /href="\/deals">Local Deals<\/a>/);
  assert.match(html, /href="\/deals\?view=national" aria-current="page">National Accounts<\/a>/);
});

test('navigation has one public module; the app shell exports only app mounting', async () => {
  const shell = await import('../js/app-shell.js');
  assert.deepEqual(Object.keys(shell).sort(), ['mountAppShell', 'partnerIdentity']);
  const navigation = await import('../js/navigation.js');
  assert.deepEqual(Object.keys(navigation).sort(), ['activeDestination', 'appShellMarkup', 'mountNavigation', 'navigationItems']);
});
