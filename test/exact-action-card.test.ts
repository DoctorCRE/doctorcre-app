import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseExactCard } from "../src/ui/exact-action-card.ts";

const reply: { ref: string; schema_version: string; card: { kind: string; id: string; source_version: number } } =
  JSON.parse(await readFile("test/fixtures/action-link-reply.v2.json", "utf8"));

test("reply lifecycle cards retain exact identity and suppress unavailable operations", () => {
  const { kind, id, source_version } = reply.card;
  const { ref, schema_version } = reply;
  for (const state of ["stale", "resolved", "retired"]) {
    const card = {
      kind,
      id,
      source_version,
      state,
      actions: [],
      ...(state === "stale" ? { subject: "Synthetic subject", body: "Synthetic reply", to: [], cc: [] } : {}),
    };
    const value = { schema_version, ref, card };
    assert.equal(parseExactCard(value, ref)?.state, state);
    assert.equal(parseExactCard(value, `${ref}A`), null);
    assert.equal(parseExactCard({ ...value, card: { ...card, id: `${id.slice(0, -1)}f` } }, ref), null);
    assert.equal(parseExactCard({ ...value, card: { ...card, actions: [{ action: "approve" }] } }, ref), null);
  }
});

test("exact review contracts retain the pinned producer bytes", async () => {
  for (const [name, digest] of [
    ["review-call-outcome.v1.json", "3035b88b8ad143541825ee0caf0e68c907137a19e46dd53e4b5457c61bc12cbe"],
    ["action-link-resolve.v2.json", "93e494323da2f9cc6d6184d6acd4bd475efd6681d17fdd1bb32ac64ed4f807bb"],
  ]) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(`contracts/carr-interface.v1/${name}`))
        .digest("hex"),
      digest,
    );
  }
});
