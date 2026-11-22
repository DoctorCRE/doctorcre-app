

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const at = (html, needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };

test("Conversations puts the list before the transcript", async () => {
  const html = await read("conversations.html");
  assert.ok(at(html, 'data-section="list"') < at(html, 'data-section="turns"'));
});

test("Conversations carries no no-thread or unknown-status copy in the hero", async () => {
  const html = await read("conversations.html");
  const js = await read("js/conversations.js");
  const hero = html.slice(at(html, 'data-section="hero"'), at(html, 'id="conversationLive"'));
  assert.doesNotMatch(hero, /No conversation is open|no conversation open|>unknown</i);
  assert.doesNotMatch(js, /No conversation is open|no conversation open/);
  for (const id of ["conversationId", "conversationAsOf", "visibilityBadge", "heroFacts", "titleHistoryLine"]) {
    assert.match(hero, new RegExp(`id="${id}"[^>]*hidden`), `${id} starts hidden`);
  }
  assert.match(js, /piece\.hidden = !header/);
});

test("Search puts results ahead of Scope and Saved views", async () => {
  const html = await read("search.html");
  for (const later of ['data-search="scope"', 'data-search="views"']) {
    assert.ok(at(html, 'id="searchResults"') < at(html, later), `results before ${later}`);
  }
});

test("no page or script points Home or sign-in at /business", async () => {
  for (const file of ["review-workflows.html", "js/workspace-command-center-model.js", "js/app-shell.js"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /href="\/business|return_to=\/business|"\/business"\s*,\s*href/, `${file} must not target /business`);
  }
  const shell = await import("../js/navigation.js");
  const markup = shell.appShellMarkup("/search");
  assert.match(markup, /aria-label="DoctorCRE Home"/);
  assert.match(markup, /class="app-shell-brand" href="\/"/);
  assert.match(markup, /aria-label="Home"[^>]*href="\/"/);
  assert.doesNotMatch(markup, /\/business/);
});

test("every Home page control resolves to a real route, never /business", async () => {
  const html = await read("review-workflows.html");
  const routes = (await import("../js/routes.js")).routeContract;
  const targets = [...html.matchAll(/<a [^>]*href="(\/[^"?#]*)/g)].map((m) => m[1]);
  for (const target of targets) assert.ok(target === "/" || routes.routes[target] || routes.redirects[target] || target.startsWith("/auth/"), `${target} is a routed path`);
  assert.equal(routes.redirects["/business"], "/");
});

test("Deal Room phone strips scroll in their own regions with token scrollbars", async () => {
  const css = await read("css/app.css");
  const shell = await read("css/app-shell.css");
  // V2 S1: app.css reads scrollbar colours from css/tokens.css, as the shell does.
  assert.match(css, /\.focus,\s*\.filters,\s*\.table-frame[^{]*\{[^}]*max-width:\s*100%[^}]*overscroll-behavior-x:\s*contain[^}]*scrollbar-color:\s*var\(--hairline-strong\) transparent/);
  assert.match(css, /\.focus::-webkit-scrollbar-thumb[^{]*\{[^}]*background:\s*var\(--hairline-strong\)/);
  assert.match(css, /\.focus\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.filters\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /@media\s*\(max-width:\s*680px\)\s*\{\s*html,\s*body\s*\{\s*max-width:\s*100%;\s*overflow-x:\s*clip;?\s*\}/);
  // S8: the list stops above the phone bottom chrome, whatever its height.
  assert.match(shell, /\.app-shell-more-list[^}]*max-height:\s*calc\(100dvh - var\(--layout-bottom\) - var\(--space-5\)\)/);
  // V2 S0: the shared shell reads scrollbar colours from css/tokens.css.
  assert.match(shell, /\.app-shell-more-list[^{]*\{[^}]*scrollbar-color:\s*var\(--hairline-strong\) transparent/);
});
