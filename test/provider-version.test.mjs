import assert from "node:assert/strict";
import test from "node:test";

import { promoteVersion, uploadedVersionId } from "../scripts/provider-version.mjs";

test("staging promotion uses one exact provider version ID", () => {
  assert.equal(uploadedVersionId("Worker Version ID: B9122521-99A1-42F5-BCC5-6D78B4B89DD3\n"),
    "b9122521-99a1-42f5-bcc5-6d78b4b89dd3");
  assert.throws(() => uploadedVersionId("upload complete"), /no unique Worker Version ID/);
  assert.throws(() => uploadedVersionId("Worker Version ID: 11111111-1111-4111-8111-111111111111\nWorker Version ID: 22222222-2222-4222-8222-222222222222"), /no unique Worker Version ID/);
});

const notFound = { status: 1, stdout: "", stderr: "The requested Worker version could not be found [code: 100146]\n" };
const promoted = { status: 0, stdout: "Deployed\n", stderr: "" };

function recordingProvider(results) {
  const calls = [];
  const waits = [];
  const provider = (args, options) => { calls.push({ args, options }); return results[calls.length - 1]; };
  return { provider, calls, waits, wait: async ms => { waits.push(ms); } };
}

test("promotion retries the same version every 10 seconds while Cloudflare cannot find it yet", async () => {
  const fake = recordingProvider([notFound, notFound, promoted]);
  await promoteVersion(fake.provider, ["versions", "deploy", "v@100%"], { wait: fake.wait });
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls.every(call => call.args.join(" ") === "versions deploy v@100%"));
  assert.deepEqual(fake.waits, [10_000, 10_000]);
});

test("promotion stops after six tries of code 100146", async () => {
  const fake = recordingProvider(Array(7).fill(notFound));
  await assert.rejects(promoteVersion(fake.provider, ["versions", "deploy", "v@100%"], { wait: fake.wait }), /Wrangler failed \(1\)/);
  assert.equal(fake.calls.length, 6);
  assert.equal(fake.waits.length, 5);
});

test("promotion stops at once on any other provider error", async () => {
  const fake = recordingProvider([{ status: 1, stdout: "", stderr: "Authentication error [code: 10000]\n" }, promoted]);
  await assert.rejects(promoteVersion(fake.provider, ["versions", "deploy", "v@100%"], { wait: fake.wait }), /Wrangler failed \(1\)/);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.waits, []);
});
