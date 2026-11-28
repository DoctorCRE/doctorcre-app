// V5-UX-B03 — the Deals board.
//
// Four kinds of test, and they are deliberately different kinds:
//
//   1. the model, called directly — the eight columns, the round trip that
//      defect 5e355b84 broke, the completion plan's ordering and its one
//      refusal, the wrapping keyboard;
//   2. the fixture round trip — a real move through patchDealField with the
//      board's own field_base, a stale base becoming a conflict, a replay under
//      one key, and the follow-ups landing only after the phase was accepted;
//   3. source-text assertions on js/pipeline.js, mirroring the ones
//      test/dealroom-board-sync.test.mjs makes about js/app.js, because the
//      properties they protect — one board read, no value from the feed, ids
//      rather than rows — cannot be observed from the outside;
import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { HEALTH, SYNC_STATES } from "../js/board-sync.mjs";
import { localDeals } from "../js/deal-review-model.js";
import { readFile } from "node:fs/promises";

import { createFixtureClient } from "../js/fixture-client.js";
import { PHASES, PHICON, phaseLabel } from "../js/client.js";
import {
  CLOSED_SLUG, COLUMNS, DEAL_OUTCOMES, closedColumnCaption,
  columnBySlug, columnByValue, columnLabel, completionPlan,
  boardHeadline, groupByColumn, isDealOutcome, keyboardTarget, moveIntent, moveSummary,
  moveTitle, presenceChip,
} from "../js/pipeline-model.js";
import {
  ingestChangeEvents, performUndo, receiptViews,
} from "../js/change-receipts.mjs";
import { carrInterface } from "./carr-contract.mjs";

const ROOT = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const seedText = await read("data/board-seed.json");
const seedUrl = `data:application/json;base64,${Buffer.from(seedText).toString("base64")}`;
const newClient = () => createFixtureClient({ seedUrl });

/* ------------------------------------------------------------------- the model */

test("the board has the eight deal phases, in the record layer's own order", () => {
  assert.deepEqual(COLUMNS.map((column) => column.slug), [
    "pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing", "closed",
  ]);
  assert.deepEqual(COLUMNS.map((column) => column.label), [
    "Prospective Client", "Research", "Site Selection", "Negotiating", "Legal", "Due Diligence", "Closing", "Closed",
  ]);
  // The board's labels are a display map OVER the client's UI values; the two
  // long-standing Deal Room names are untouched, which is what keeps the pinned
  // markup at /deals green.
  assert.equal(columnBySlug("pending").value, "On Deck");
  assert.equal(columnBySlug("due_diligence").value, "Diligence");
  assert.equal(columnLabel("On Deck"), "Prospective Client");
  assert.equal(columnLabel("Diligence"), "Due Diligence");
  // /deals now prints the same display words as the board. One map per word,
  // asserted against the other, so the two surfaces cannot drift apart.
  for (const column of COLUMNS) {
    assert.equal(phaseLabel(column.value), column.label, `${column.value} reads differently on the two surfaces`);
  }
});

test("the /deals phase select shows the display word and writes the wire word", async () => {
  assert.equal(phaseLabel("On Deck"), "Prospective Client");
  assert.equal(phaseLabel("Diligence"), "Due Diligence");
  for (const phase of PHASES) {
    if (!["On Deck","Diligence","Site selection","Negotiation"].includes(phase)) assert.equal(phaseLabel(phase), phase, `${phase} is renamed`);
  }
  // The option the /deals table renders: the wire word in the value attribute,
  // the display word in the text, so a write still sends 'On Deck'.

});

test("every phase slug round-trips through the map that defect 5e355b84 made lossy", () => {
  // The defect: research and site_selection both displayed as "Research", and
  // no UI value mapped back to site_selection — so writing the board's own
  // label back moved a site-selection deal into research.
  const values = COLUMNS.map((column) => column.value);
  assert.equal(new Set(values).size, COLUMNS.length, "no two phases share a UI value");
  for (const column of COLUMNS) {
    assert.equal(columnByValue(column.value).slug, column.slug, `${column.slug} does not round-trip`);
    assert.ok(PHASES.includes(column.value), `${column.value} is not an interface phase`);
    assert.ok(PHICON[column.value], `${column.value} has no icon`);
  }
  assert.equal(PHASES.length, 8);
  assert.equal(columnByValue("Site selection").slug, "site_selection");
});

test("grouping files every row under its column and never guesses at one it cannot place", () => {
  const deals = [
    { id: "a", name: "Demo A", phase: "On Deck" },
    { id: "b", name: "Demo B", phase: "Site selection" },
    { id: "c", name: "Demo C", phase: "Not a phase" },
  ];
  const { columns, unplaced } = groupByColumn(deals);
  assert.equal(columns.length, 7);
  assert.deepEqual(columns.find((c) => c.slug === "pending").deals.map((d) => d.id), ["a"]);
  assert.deepEqual(columns.find((c) => c.slug === "site_selection").deals.map((d) => d.id), ["b"]);
  assert.deepEqual(unplaced.map((d) => d.id), ["c"], "an unknown phase is reported, not filed under a guess");
  assert.deepEqual(groupByColumn(null).unplaced, []);
});

test("every parked deal goes to the parked lane whatever its phase, and never into a phase column", () => {
  const { columns, parked } = groupByColumn([
    { id: "open-prospect", phase: "On Deck", operating_state: "active" },
    { id: "parked-prospect", phase: "On Deck", operating_state: "parked" },
    { id: "parked-research", phase: "Research", operating_state: "parked" },
  ]);
  assert.deepEqual(parked.map((d) => d.id), ["parked-prospect", "parked-research"]);
  assert.deepEqual(columns.flatMap((c) => c.deals).map((d) => d.id), ["open-prospect"]);
});

test("the board headline counts exactly the cards in the columns and the parked lane", () => {
  const grouped = groupByColumn([
    { id: "a", phase: "On Deck", operating_state: "active" },
    { id: "b", phase: "Legal", operating_state: "active" },
    { id: "c", phase: "On Deck", operating_state: "parked" },
    { id: "d", phase: "Closing", operating_state: "parked" },
    { id: "e", phase: "Not a phase", operating_state: "active" },
  ]);
  const cards = grouped.columns.reduce((sum, c) => sum + c.deals.length, 0);
  assert.equal(boardHeadline(grouped), `${cards} open deals · ${grouped.parked.length} parked`);
  assert.equal(boardHeadline(grouped), "2 open deals · 2 parked");
});

test("a move intent names both ends, and a drop on the card's own column is not a move", () => {
  const deal = { id: "d20", name: "Demo Osteopathic Office", phase: "Diligence" };
  const intent = moveIntent(deal, "closing");
  assert.deepEqual({ ...intent }, {
    deal: "d20", name: "Demo Osteopathic Office", field: "phase", value: "Closing",
    from: "due_diligence", from_label: "Due Diligence", to: "closing", to_label: "Closing",
  });
  assert.equal(moveSummary(intent), "Demo Osteopathic Office → Closing");
  assert.equal(moveTitle(intent), "Move this deal to Closing?");
  assert.equal(moveIntent(deal, "due_diligence"), null, "the same column is not a move");
  assert.equal(moveIntent(deal, "not_a_phase"), null);
  assert.equal(moveIntent(null, "closing"), null);
  assert.equal(moveIntent({ ...deal, seen: 0 }, "closing").seen, 0);
});

test("a move plans one phase patch", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");

  const bare = completionPlan(intent, {});
  assert.deepEqual(bare.errors, []);
  assert.equal(bare.steps.length, 1, "an empty question is still a move");
  assert.deepEqual(bare.steps[0], {
    verb: "patch-deal-field",
    args: { deal: "d01", field: "phase", value: "Legal" },
    summary: "Demo Dental North → Legal",
  });
  // An untouched box sends nothing at all — not a key holding an empty string.
  assert.equal("change_reason" in bare.steps[0].args, false);

});

test("the phase patch carries the partner's reason when one was typed", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");
  const plan = completionPlan(intent, { changeReason: "  Countersigned  " });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.steps.length, 1, "the reason spawns no second verb");
  assert.deepEqual(plan.steps[0].args, {
    deal: "d01",
    field: "phase",
    value: "Legal",
    change_reason: "Countersigned",
  });
});

test("whitespace is not a sentence", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");
  const plan = completionPlan(intent, { changeReason: "   " });
  assert.equal("change_reason" in plan.steps[0].args, false);
  assert.deepEqual(completionPlan(null, {}).steps, []);
});

test("no sentence the dialog prints claims a gate, and Closed says what it writes", () => {
  assert.equal(closedColumnCaption(), "Records the outcome and the closing date on the deal.");
  const source = completionPlan(
    moveIntent({ id: "d01", name: "Demo", phase: "On Deck" }, "legal"),
    { changeReason: "x" },
  );
  for (const step of source.steps) {
    assert.doesNotMatch(step.summary, /blocked|required|gate|approve|permission/i);
  }
});

test("the arrow keys wrap at both ends and ignore every other key", () => {
  assert.equal(keyboardTarget("pending", "ArrowLeft"), "closed", "left from the first column wraps to the last");
  assert.equal(keyboardTarget("closed", "ArrowRight"), "pending", "right from the last wraps to the first");
  assert.equal(keyboardTarget("research", "ArrowRight"), "site_selection");
  assert.equal(keyboardTarget("research", "ArrowDown"), "site_selection", "down reads as forward");
  assert.equal(keyboardTarget("research", "ArrowUp"), "pending", "up reads as back");
  assert.equal(keyboardTarget("research", "Enter"), null);
  assert.equal(keyboardTarget("research", "Tab"), null);
  assert.equal(keyboardTarget("not_a_column", "ArrowRight"), "research", "an unknown start begins at the first column");
  assert.equal(keyboardTarget("pending", "ArrowRight", []), null);
});

test("a partner's lease reads as a chip, and the viewer's own never does", () => {
  const presence = [
    { actor: "joe", deal_id: "d01", field: "phase" },
    { actor: "dell", deal_id: "d02", field: "phase" },
    { actor: "dell", deal_id: "d03", field: "owner" },
  ];
  const label = (slug) => ({ joe: "Joe", dell: "Dell" }[slug]);
  assert.equal(presenceChip(presence, "d02", { selfActor: "joe", field: "phase", actorLabel: label }), "Dell is editing");
  assert.equal(presenceChip(presence, "d01", { selfActor: "joe", field: "phase", actorLabel: label }), null);
  assert.equal(presenceChip(presence, "d03", { selfActor: "joe", field: "phase", actorLabel: label }), null);
  assert.equal(presenceChip([], "d01", { selfActor: "joe" }), null);
});

/* -------------------------------------------------------- the fixture round trip */

async function boardRow(client, dealId) {
  const board = await client.getBoard();
  return board.deals.find((deal) => deal.id === dealId);
}

test("a drop sends the board's own field_base and comes back with the committed event", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d20");
  assert.equal(row.phase, "Diligence");
  const intent = moveIntent(row, "closing");
  const [phaseStep] = completionPlan(intent, {}).steps;

  const answer = await client.patchDealField({
    ...phaseStep.args,
    base_event_id: row.field_base?.phase?.id || null,
    idempotency_key: "key-move-1",
  });
  assert.equal(answer.status, "ok");
  assert.ok(answer.event_id, "the answer names the event it committed");
  assert.ok(answer.event_recorded_at);
  assert.equal((await boardRow(client, "d20")).phase, "Closing");
});

test("a stale base is a conflict, not a silent overwrite, and resolve-conflict settles it", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d01");
  await client.patchDealField({
    deal: "d01", field: "phase", value: "Research",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-first",
  });
  // The second write was built from the base the FIRST one superseded.
  const stale = await client.patchDealField({
    deal: "d01", field: "phase", value: "Legal",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-second",
  });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.conflict.field, "phase");
  assert.equal(stale.conflict.deal, "d01");
  assert.ok(stale.conflict.conflict_id);
  assert.equal(stale.conflict.a.value, "Research", "the server's side is what it holds now");
  assert.equal(stale.conflict.b.value, "Legal");

  const settled = await client.resolveConflict({
    conflict_id: stale.conflict.conflict_id, winner: "b", idempotency_key: "key-resolve",
  });
  assert.equal(settled.status, "ok");
  assert.equal((await boardRow(client, "d01")).phase, "Legal");
});

test("a re-send under the same key replays the stored answer instead of writing again", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d05");
  const request = {
    deal: "d05", field: "phase", value: "Closed",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-replay",
  };
  const first = await client.patchDealField({ ...request });
  const second = await client.patchDealField({ ...request });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(second.event_id, first.event_id, "the replay names the same event");
  const changes = await client.getChanges(null);
  const phaseEvents = changes.events.filter((event) => event.subject_id === "d05" && event.field === "phase");
  assert.equal(phaseEvents.length, 1, "the second send wrote nothing");
});

/**
 * Undo (V5-UX-B10a): a canonical correction through revert-deal-field, never a
 * local rollback. Exercised through performUndo — exactly what pipeline.js's
 * own runUndo calls — against the fixture client, which now mirrors the
 * record layer's own gate: the reverted event must still be the LATEST event
 * on that deal+field, or the server refuses `newer_change_exists`.
 */
test("an undo the actor made succeeds: revert-deal-field lands a canonical correction, not a rollback", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d05");
  const before = row.phase;
  const write = await client.patchDealField({
    deal: "d05", field: "phase", value: "Research",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-undo-write",
  });
  assert.equal(write.status, "ok");
  assert.equal((await boardRow(client, "d05")).phase, "Research");

  let undoState = {};
  const result = await performUndo({
    eventId: write.event_id,
    getState: () => undoState,
    setState: (next) => { undoState = next; },
    newKey: () => "key-undo-1",
    revert: (request) => client.revertDealField(request),
  });
  assert.equal(result.started, true);
  assert.equal(result.outcome.status, "succeeded");
  assert.equal((await boardRow(client, "d05")).phase, before, "the field reads back to what it held before");

  // A canonical correction, not a silent rewrite of history: the revert is
  // itself a new durable event, on the change feed like any other.
  const changes = await client.getChanges(null);
  const revertEvents = changes.events.filter((event) => event.subject_id === "d05" && event.verb === "revert-deal-field");
  assert.equal(revertEvents.length, 1);
  assert.equal(revertEvents[0].field, "phase");
  assert.equal(revertEvents[0].new_value, before);
});

test("undo is refused, not clobbered, when a newer edit landed on the same field first", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d01");
  const firstWrite = await client.patchDealField({
    deal: "d01", field: "phase", value: "Research",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-conflict-first",
  });
  assert.equal(firstWrite.status, "ok");
  // A partner's own later edit to the same field — the case an undo must never
  // overwrite.
  const secondWrite = await client.patchDealField({
    deal: "d01", field: "phase", value: "Legal",
    base_event_id: firstWrite.event_id, idempotency_key: "key-conflict-second",
  });
  assert.equal(secondWrite.status, "ok");

  let undoState = {};
  const result = await performUndo({
    eventId: firstWrite.event_id,
    getState: () => undoState,
    setState: (next) => { undoState = next; },
    newKey: () => "key-undo-refused",
    revert: (request) => client.revertDealField(request),
  });
  assert.equal(result.started, true);
  assert.equal(result.outcome.status, "refused");
  assert.equal(result.outcome.code, "newer_change_exists");
  assert.match(result.outcome.message, /newer value/i);
  // The newer edit is untouched — this is the whole point of the refusal.
  assert.equal((await boardRow(client, "d01")).phase, "Legal");

  // The Recent Changes view reflects the same refusal, via the shared kernel.
  const receipts = ingestChangeEvents([], (await client.getChanges(null)).events, {
    dealName: () => "Riverbank Dental",
    actorLabel: (slug) => slug,
  });
  const views = receiptViews(receipts, { selfActor: client.selfActor, undo: undoState, now: Date.now() });
  const view = views.find((v) => v.event_id === firstWrite.event_id);
  assert.equal(view.undo_status, "refused");
  assert.equal(view.can_undo, false, "a refused undo does not offer to retry the same clobber");
  assert.match(view.message, /newer value/i);
});

test("a change to a field revert-deal-field cannot act on shows in Recent Changes with no undo button", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d02");
  const write = await client.setNextStep({
    deal: "d02", text: "Confirm rent roll with landlord", base_version: row.version, idempotency_key: "key-next-step",
  });
  assert.ok(write.event?.id || write.event_id, "the fixture recorded the next-step event");

  const changes = await client.getChanges(null);
  const receipts = ingestChangeEvents([], changes.events, {
    dealName: () => row.name,
    actorLabel: (slug) => slug,
  });
  const nextStepReceipt = receipts.find((r) => r.field === "next_step");
  assert.ok(nextStepReceipt, "the change appears in the feed this view is built from");
  assert.equal(nextStepReceipt.revertible_field, false);

  const views = receiptViews(receipts, { selfActor: client.selfActor, undo: {}, now: Date.now() });
  const view = views.find((v) => v.event_id === nextStepReceipt.event_id);
  assert.equal(view.undo_status, "unsupported");
  assert.equal(view.can_undo, false);
  assert.equal(view.badge, null, "not offering undo is silent here, not a refusal badge");
});

test("a lost response is reconciled by resending the SAME idempotency key, not by writing twice", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d20");
  const write = await client.patchDealField({
    deal: "d20", field: "phase", value: "Legal",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-undo-lost-write",
  });
  assert.equal(write.status, "ok");

  // A transport that commits the revert on the server but loses the answer on
  // the way back — exactly the case classifyUndoOutcome treats as "unknown",
  // never as a refusal and never as a silent success.
  let dropNextAnswer = true;
  const flakyRevert = async (request) => {
    const response = await client.revertDealField(request);
    if (dropNextAnswer) { dropNextAnswer = false; throw new Error("connection reset"); }
    return response;
  };

  let undoState = {};
  const lost = await performUndo({
    eventId: write.event_id,
    getState: () => undoState,
    setState: (next) => { undoState = next; },
    newKey: () => "key-undo-retry",
    revert: flakyRevert,
  });
  assert.equal(lost.outcome.status, "unknown");
  assert.match(lost.outcome.message, /could not be confirmed/);
  // The write already landed even though the answer was lost.
  assert.equal((await boardRow(client, "d20")).phase, row.phase);

  // The SAME event, retried: beginUndo keeps the entry retryable while it is
  // unknown, and reuses the same idempotency key rather than minting a new one.
  const retried = await performUndo({
    eventId: write.event_id,
    getState: () => undoState,
    setState: (next) => { undoState = next; },
    newKey: () => "should-not-be-used",
    revert: flakyRevert,
  });
  assert.equal(retried.started, true);
  assert.equal(retried.idempotency_key, "key-undo-retry", "the retry replays under the original key");
  assert.equal(retried.outcome.status, "succeeded");
  assert.equal((await boardRow(client, "d20")).phase, row.phase, "reverted exactly once");

  const changes = await client.getChanges(null);
  const revertEvents = changes.events.filter((event) => event.subject_id === "d20" && event.verb === "revert-deal-field");
  assert.equal(revertEvents.length, 1, "the reconciled retry replayed the stored answer instead of writing a second time");
});

test("the fixture accepts every one of the eight phases by its board value", async () => {
  const client = await newClient();
  let base = (await boardRow(client, "d07")).field_base?.phase?.id || null;
  for (const [index, column] of COLUMNS.entries()) {
    const answer = await client.patchDealField({
      deal: "d07", field: "phase", value: column.value, base_event_id: base, idempotency_key: `k-walk-${index}`,
    });
    assert.equal(answer.status, "ok", `${column.slug} was refused`);
    base = answer.event_id;
  }
  assert.equal((await boardRow(client, "d07")).phase, "Closed");
});

/* ------------------------------------------------------- what js/pipeline.js is */

/* ------------------------------------------------------------ what the page says */

test("the route and the verbs this surface needs are pinned in the contracts", async () => {
  const routes = (await import("../js/routes.js")).routeContract;
  assert.equal(routes.redirects["/pipeline"], "/deals?view=board");
  assert.equal(routes.routes["/deals"], "pipeline.html", "the existing Deal Room keeps its route");
  const contract = carrInterface;
  for (const verb of ["patch-deal-field", "add-deal-note", "set-next-step", "add-critical-date", "resolve-conflict", "presence-lease", "revert-deal-field"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
});

/* ------------------------------------------------- Closed records an outcome */

const closedIntent = () => moveIntent({ id: "d05", name: "Demo Family Clinic", phase: "Closing" }, CLOSED_SLUG);

test("a move into Closed plans the outcome write, and only into Closed", () => {
  assert.equal(CLOSED_SLUG, "closed");
  assert.deepEqual(DEAL_OUTCOMES.map((entry) => entry.value), ["won", "lost", "paused"]);
  assert.ok(isDealOutcome("paused"));
  assert.equal(isDealOutcome("closed"), false, "the phase is not an outcome");

  const won = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "48000" });
  assert.deepEqual(won.errors, []);
  assert.deepEqual(won.steps.map((step) => step.verb), ["patch-deal-field", "update-deal"]);
  assert.deepEqual(won.steps[1].args, {
    deal: "d05",
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
  });
  assert.equal(won.steps[1].summary, "Outcome won on Demo Family Clinic");
  assert.ok(!("base_version" in won.steps[1].args),
    "the version is read fresh at send time, never planned from a stale read");

  // The money belongs to a won record and to nothing else.
  const lost = completionPlan(closedIntent(), { outcome: "lost", closedOn: "2026-09-17", wonValue: "48000" });
  assert.deepEqual(lost.steps[1].args.fields, { outcome: "lost", closed_on: "2026-09-17" });
  const paused = completionPlan(closedIntent(), { outcome: "paused", closedOn: "2026-09-17" });
  assert.deepEqual(paused.steps[1].args.fields, { outcome: "paused", closed_on: "2026-09-17" });
  const noValue = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "  " });
  assert.deepEqual(noValue.steps[1].args.fields, { outcome: "won", closed_on: "2026-09-17" });

  // Every other column is untouched by this slice.
  const legal = completionPlan(moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal"),
    { outcome: "won", closedOn: "2026-09-17" });
  assert.deepEqual(legal.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.deepEqual(legal.errors, []);
});

test("a new-database close needs a date and a loss reason or an optional positive win value", () => {
  const intent = { ...closedIntent(), seen: 0 };
  const lost = completionPlan(intent, { outcome: "lost", closedOn: "2026-11-18", lostReason: "The client chose another site" });
  assert.deepEqual(lost.errors, []);
  assert.deepEqual(lost.steps.map(step => [step.verb, step.args]), [["update-deal", {
    deal: intent.deal, phase_from: intent.from, seen_change_id: 0,
    fields: { outcome: "lost", closed_on: "2026-11-18", lost_reason: "The client chose another site" },
  }]]);
  for (const form of [
    { outcome: "lost", closedOn: "2026-11-18" },
    { outcome: "won" },
    { outcome: "won", closedOn: "2026-11-18", wonValue: "0" },
    { outcome: "paused", closedOn: "2026-11-18" },
  ]) {
    const plan = completionPlan(intent, form);
    assert.equal(plan.errors.length, 1);
    assert.deepEqual(plan.steps, []);
  }
});

test("Closed refuses without an outcome, and refuses an outcome the record layer would bounce", () => {
  const missing = completionPlan(closedIntent(), { closedOn: "2026-09-17" });
  assert.deepEqual(missing.steps.map((step) => step.verb), ["patch-deal-field"],
    "nothing beyond the move is planned");
  assert.ok(missing.errors.some((line) => /outcome/i.test(line)), "the sentence names the missing outcome");
  assert.match(missing.errors[0], /Won, Lost or Paused/);

  const invented = completionPlan(closedIntent(), { outcome: "settled", closedOn: "2026-09-17" });
  assert.deepEqual(invented.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.ok(invented.errors.some((line) => /won, lost, or paused/.test(line)));

  const nonsense = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "lots" });
  assert.deepEqual(nonsense.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.ok(nonsense.errors.some((line) => /must be a number/.test(line)));
});

test("the fixture takes the outcome write only against the version the deal holds now", async () => {
  const client = await newClient();
  const before = await client.getDeal("d05");
  assert.equal(before.deal.version, 1);
  assert.equal(before.deal.outcome, null);

  await assert.rejects(
    () => client.updateDeal({ deal: "d05", fields: { outcome: "won" }, idempotency_key: "k-no-base" }),
    (error) => error.payload.error === "missing_base_version",
  );
  await assert.rejects(
    () => client.updateDeal({ deal: "d05", base_version: 7, fields: { outcome: "won" }, idempotency_key: "k-stale" }),
    (error) => error.payload.error === "version_conflict",
  );
  await assert.rejects(
    () => client.updateDeal({ deal: "d05", base_version: 1, fields: { outcome: "settled" }, idempotency_key: "k-enum" }),
    (error) => error.payload.error === "deal_outcome_check",
  );

  const answer = await client.updateDeal({
    deal: "d05", base_version: 1,
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
    idempotency_key: "k-outcome",
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.version, 2);
  const after = await client.getDeal("d05");
  assert.equal(after.deal.outcome, "won");
  assert.equal(after.deal.closed_on, "2026-09-17");
  assert.equal(after.deal.won_value, 48000);

  // A replay under the same key returns the stored answer instead of writing again.
  const replay = await client.updateDeal({
    deal: "d05", base_version: 1,
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
    idempotency_key: "k-outcome",
  });
  assert.equal(replay.version, 2, "the second send wrote nothing");
  assert.equal((await client.getDeal("d05")).deal.version, 2);
});

test("the Closed dialog offers the three outcomes, a picker for the date, and both adapters can send it", async () => {

  const contract = carrInterface;
  assert.ok(contract.mcp_operations.includes("update-deal"), "the CARR contract exposes update-deal");
});

test("the fixture carries the reason onto the phase event, word for word", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d20");
  const intent = moveIntent(row, "closing");
  const plan = completionPlan(intent, { changeReason: "Countersigned" });
  const answer = await client.patchDealField({
    ...plan.steps[0].args,
    base_event_id: row.field_base?.phase?.id || null,
    idempotency_key: "key-words-1",
  });
  assert.equal(answer.status, "ok");

  const changes = await client.getChanges(null);
  const event = changes.events.find((entry) => entry.id === answer.event_id);
  assert.ok(event, "the committed event is on the feed");
  assert.equal(event.field, "phase");
  assert.equal(event.change_reason, "Countersigned");

  // A move with no reason is not refused; it simply records none.
  const plain = await client.patchDealField({
    deal: "d01", field: "phase", value: "Research",
    base_event_id: (await boardRow(client, "d01")).field_base?.phase?.id || null,
    idempotency_key: "key-words-2",
  });
  assert.equal(plain.status, "ok");
  const plainEvent = (await client.getChanges(null)).events.find((entry) => entry.id === plain.event_id);
  assert.equal(plainEvent.change_reason, null);
});

// Run the page's status renderer against a DOM without booting its network or
// polling. The coordinator's transitions are covered in dealroom-board-sync.
for (const status of [503, 401, 403]) test(`QA008 Deals freshness settles after failed read and retry: ${status}`, async () => {
  const source = await read("js/pipeline.js");
  const renderer = source.slice(source.indexOf("function visibleBoardDeals("), source.indexOf("function renderBoard("))
    + source.slice(source.indexOf("function renderStatus("), source.indexOf("function renderPendingWrites("));
  const dom = new JSDOM('<p id="boardLive"></p><span id="boardAsOf"></span><span id="boardStatusLabel"></span><span id="boardOrb"></span><span id="boardStatus"></span>');
  try {
    const paint = status => runInNewContext(`${renderer}renderStatus(status);`, { state: {deals:new Map(),filter:'all'}, HEALTH, SYNC_STATES, localDeals, boardHeadline, groupByColumn, status, say:text=>{dom.window.document.getElementById('boardLive').textContent=text;}, $: id => dom.window.document.getElementById(id) });
    const freshness = () => dom.window.document.getElementById('boardAsOf').textContent;
    const { createBoardSync } = await import('../js/board-sync.mjs');
    let failing = true;
    const sync = createBoardSync({
      readBoard: async () => {
        if (failing) throw Object.assign(new Error('Synthetic refusal'), { status });
        return { deals: [], accounts: [] };
      },
      readChanges: async () => ({ events: [], cursor: 'demo-cursor' }),
      applyBoard() {}, onStatus: paint,
    });
    await sync.requestRefresh('initial');
    assert.equal(freshness(), 'Unavailable');
    assert.match(dom.window.document.getElementById('boardLive').textContent,/unavailable/i);
    await sync.requestRefresh('retry');
    assert.equal(freshness(), 'Unavailable');
    failing = false;
    await sync.requestRefresh('recovery');
    assert.match(freshness(), /^Updated .* (AM|PM)$/);
  } finally { dom.window.close(); }
});

test('fixture deal reads preserve every note and put undated entries after dated updates', async () => {
  const seed = JSON.parse(seedText);
  seed.threads.d14 = [
    {id:'undated',kind:'note',text:'Synthetic undated note'},
    {id:'old',kind:'note',at:'2026-10-01T12:00:00Z',text:'Synthetic older note'},
    {id:'latest',kind:'note',created_at:'2026-10-26T12:00:00Z',text:'Synthetic latest note'},
  ];
  const client = await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`});
  assert.deepEqual((await client.getDeal('d14')).thread.map(row=>row.id),['latest','old','undated']);
});

test('Home Recent moves retains precise newest-first receipt order with undated entries last', () => {
 const events = [
  {id:'undated',recorded_at:null},
  {id:'older',recorded_at:'2026-10-26T12:00:00.000001Z'},
  {id:'newer',recorded_at:'2026-10-26T07:00:00.000002-05:00'},
  {id:'historic',recorded_at:'1969-12-31T12:00:00Z'},
 ].map(event=>({...event,subject_type:'deal',subject_id:'d14',actor:'joe',field:'next_step',new_value:'Synthetic updated step'}));
 const receipts = ingestChangeEvents([],events,{dealName:()=> 'Synthetic Practice'});
 assert.deepEqual(receiptViews(receipts).map(row=>row.event_id),['newer','older','historic','undated']);
});
