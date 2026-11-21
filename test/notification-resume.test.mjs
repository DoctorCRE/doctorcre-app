import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { mountReadOnResume } from "../js/read-on-resume.mjs";

function events(initial = "visible") {
  const listeners = new Map();
  const doc = {
    visibilityState: initial,
    addEventListener(name, fn) { listeners.set(`doc:${name}`, fn); },
  };
  return {
    doc,
    visibility(state) { doc.visibilityState = state; listeners.get("doc:visibilitychange")(); },
  };
}

test("a hidden Notifications page reads the feed once when it becomes visible", async () => {
  const browser = events();
  let reads = 0;
  mountReadOnResume({ document: browser.doc, refresh: async () => { reads++; } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "a repeated visible event cannot issue a second read");
});

test("failed reads can be retried on the next actual resume", async () => {
  const browser = events();
  let reads = 0;
  mountReadOnResume({ document: browser.doc, refresh: async () => {
    reads++;
    if (reads === 1) throw new Error("synthetic feed failure");
  } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("a second return while a read is in flight queues one fresh read", async () => {
  const browser = events();
  let complete;
  let reads = 0;
  mountReadOnResume({ document: browser.doc, refresh: async () => {
    reads++;
    if (reads === 1) await new Promise((resolve) => { complete = resolve; });
  } });
  browser.visibility("hidden");
  browser.visibility("visible");
  await new Promise((resolve) => setImmediate(resolve));
  browser.visibility("hidden");
  browser.visibility("visible");
  assert.equal(reads, 1);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("the shipped Notifications page binds resume to its existing read path", async () => {
  const source = await readFile(new URL("../js/notifications.js", import.meta.url), "utf8");
  assert.match(source, /mountAutoRefresh\(\{[\s\S]*?refresh:\s*load/);
  assert.doesNotMatch(source, /setInterval\(/);
});
