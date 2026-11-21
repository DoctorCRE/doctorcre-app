import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseMeetingPage } from "../src/ui/vendor-meetings-client.ts";

const recordings = JSON.parse(
  await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
);
test("recordings replay the pinned deployed handler and pass the production parser", async () => {
  const source = await readFile(new URL("./fixtures/vendor-meetings/producer.txt", import.meta.url), "utf8");
  const provenance = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/provenance.json", import.meta.url), "utf8"),
  );
  assert.equal(createHash("sha256").update(source).digest("hex"), provenance.sha256);
  const handler = source
    .slice(source.indexOf("handler: async") + "handler: ".length, source.lastIndexOf("\n    },"))
    .replace(/,\s*$/, "");
  const recording = recordings.research;
  const context = vm.createContext({
    mailboxOwnerForActor: () => "joe",
    ToolError: Error,
    UUID: /^[a-f0-9-]{36}$/i,
    ZERO: "00000000-0000-0000-0000-000000000000",
    statement: "recorded SQL",
    btoa,
    atob,
    vendorCalendar: async () => recording.calendar,
  });
  const read = vm.runInContext(`(${handler})`, context);
  const result = await read(
    { query: async () => ({ rows: [{ total: recording.total, items: structuredClone(recording.items) }] }) },
    {},
    { view: "research", q: "", limit: 5 },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), recording);
  assert.equal(parseMeetingPage(result, 5).items[0]?.contact?.name, "Ada Synthetic");
});
test("parser refuses malformed identity, membership, calendar, cursor and view", () => {
  for (const patch of [
    { schema: "other" },
    { view: "suggested", items: [], total: 0 },
    { items: [{ ...recordings.research.items[0], contact: {} }] },
    { items: [{ ...recordings.research.items[0], missing: [] }] },
    { calendar: { state: "invented" } },
    { has_more: true, next_cursor: null },
    { items: [{ ...recordings.research.items[0], possible_meetings: [{ title: "Wrong" }] }] },
  ])
    assert.throws(() => parseMeetingPage({ ...recordings.research, ...patch }, 5));
});
