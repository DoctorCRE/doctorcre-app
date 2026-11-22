import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEngineWatchClient, createWatchClient } from "../src/ui/watches/client.ts";

const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"));
const { readWithDeadline } = await import(new URL("../js/current-read.mjs", import.meta.url).href);
const subject = { subject_type: "deal", subject_id: "3c8b7e16-50f8-40de-a757-bf9583df4dd2" } as const;
test("watch transport validates producer payload and classifies stale or unknown outcomes", async () => {
  const client = createWatchClient(async () => ({ kind: "payload", payload: fixture, isError: false }));
  assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, "confirmed");
  for (const [payload, kind] of [
    [{ error: "watch_stale_version" }, "conflict"],
    [{}, "unknown"],
    [{ error: "human_caller_required" }, "denied"],
  ] as const) {
    const client = createWatchClient(async () => ({ kind: "payload", payload, isError: true }));
    assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, kind);
  }
});

test("a retired session reported by the shared transport asks for sign-in", async () => {
  const client = createWatchClient(async () => ({
    kind: "unconfirmed",
    reason: "network",
    cause: { status: 401, code: "authentication_required" },
  }));
  assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, "denied");
});

test("engine watch route reads settings and sends each command with its original key", async () => {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"));
  const request: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: String(input), body });
    if (body?.base_version === 99) return Response.json({ error: "watch_stale_version" }, { status: 409 });
    return Response.json(body ? { ...recorded, rows_changed: [0, 1] } : { watch: recorded.watch, health: null });
  };
  const client = createEngineWatchClient(request, readWithDeadline);
  const signal = new AbortController().signal;
  assert.equal((await client("read-subject-watch-v2", subject, signal)).kind, "confirmed");
  for (const [verb, command] of [
    ["watch-subject-v2", "watch"],
    ["replace-subject-watch-policy-v2", "replace-policy"],
    ["pause-subject-watch-v2", "pause"],
    ["resume-subject-watch-v2", "resume"],
    ["unwatch-subject-v2", "unwatch"],
  ] as const) {
    const args = { ...subject, idempotency_key: "key" };
    assert.equal((await client(verb, args, signal)).kind, "confirmed");
    assert.deepEqual(calls.at(-1)?.body, { command, idempotency_key: "key" });
  }
  const stale = { ...subject, base_version: 99 };
  assert.equal((await client("pause-subject-watch-v2", stale, signal)).kind, "conflict");
  assert.equal(calls.length, 7);
  assert.equal(calls[0]?.path, `/api/engine/deals/${subject.subject_id}/watch`);
});

test("engine request deadline returns unknown and aborts a stalled request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const client = createEngineWatchClient(async (_input, init) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    started?.();
    return new Promise<Response>(() => {});
  }, readWithDeadline);
  const pending = client("read-subject-watch-v2", subject, new AbortController().signal);
  await ready;
  t.mock.timers.tick(10_000);
  assert.equal((await pending).kind, "unknown");
  assert.equal(aborted, true);
});
