import assert from "node:assert/strict";
import { test } from "node:test";
import { docLinkMessage, readDocLinkStatus, waitingMessage } from "../src/ui/doc-link.ts";

const cases = [
  ["doc_not_set_up", "Doc isn't set up on your Mac yet."],
  ["doc_mac_off", "Doc answers when your Mac is on."],
  ["doc_signed_out", "On your Mac, sign in to the app you use for Doc: Claude Code or Codex."],
  ["doc_plan_limit", "Doc is paused until your model's plan resets."],
  ["doc_ready", "Doc is ready on your Mac."],
] as const;

test("Doc codes take precedence and unknown or absent codes use the text", async () => {
  for (const [code, expected] of cases) {
    assert.equal(waitingMessage("old text", code, null), expected);
    const link = await readDocLinkStatus(async () =>
      Response.json({ status: "mac_off", readiness_code: code, backend: null }),
    );
    assert.ok(link);
    assert.equal(docLinkMessage(link.status, link.backend), expected);
  }
  for (const code of [null, undefined, "future_code"]) {
    assert.equal(waitingMessage("new text", code, null), "new text");
    const link = await readDocLinkStatus(async () => Response.json({ status: "mac_off", readiness_code: code }));
    assert.deepEqual(link, { status: "mac_off", backend: null });
  }
});

test("Doc names the configured model when sign-in or a plan limit blocks it", () => {
  for (const [backend, model] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ] as const) {
    assert.equal(waitingMessage("old", "doc_signed_out", backend), `Sign in to ${model} on your Mac.`);
    assert.equal(waitingMessage("old", "doc_plan_limit", backend), `Doc is paused until your ${model} plan resets.`);
    assert.equal(docLinkMessage("signed_out", backend), `Sign in to ${model} on your Mac.`);
  }
  assert.equal(waitingMessage("Sign in to Claude Code on your Mac.", null, null), docLinkMessage("signed_out", null));
});
