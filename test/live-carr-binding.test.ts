import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "../scripts/fixture-http.mjs";
import { carrBinding } from "../tests/live/carr-binding.ts";

const turn = () => new Promise(setImmediate);

test("a CARR request the browser abandons is answered before the binding settles", async (t) => {
  const route = { body: "{}", contentType: "application/json", hold: "answer" };
  const local = await startFixture({ routes: new Map([["/pipeline/changes", route]]) });
  t.after(() => local.close());
  const carr = carrBinding(local.origin);
  const abandoned = new AbortController();
  const reply = carr.fetch(new Request("http://carr/pipeline/changes", { signal: abandoned.signal }));
  while (!local.requests.length) await turn();

  abandoned.abort();
  const order: string[] = [];
  const settled = carr.settled().then(() => order.push("settled"));
  await turn();
  order.push("answered");
  local.release("answer");
  await settled;

  assert.deepEqual(order, ["answered", "settled"]);
  assert.equal((await reply).status, 200);
});
