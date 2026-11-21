import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { expect } from "@playwright/test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const question = "Which example deals are open?";
const created_at = "2026-01-01T00:00:00Z";
const conversation = { id, title: question, created_at };
const answeredTurn = {
  id: "00000000-0000-4000-8000-000000000002",
  position: 1,
  created_at,
  question,
  state: "answered",
  context: null,
  waiting_reason: null,
  answer: { kind: "answer", text: "One example deal is open.", sources: [], proposal: null },
  confirmation: null,
};

async function docChatFixture(
  t: TestContext,
  respond: (request: Request) => Response | Promise<Response>,
  actor = () => "joe",
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      PARTNER_SIGN_IN: "engine",
      PARTNER_APP: {
        async fetch(request: Request) {
          const slug = actor();
          if (new URL(request.url).pathname === "/auth/session") {
            return Response.json({ actor: { slug }, csrf_token: `${slug}-test` });
          }
          return respond(request);
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  return { page, origin: server.origin };
}

for (const path of ["list", "detail"] as const) {
  test(`A malformed 200 from the Doc chat ${path} offers a load retry`, async (t) => {
    let malformed = true;
    const { page, origin } = await docChatFixture(t, (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: malformed && path === "list" ? 1 : null });
        case `/api/engine/doc/conversations/${id}`:
          return Response.json({ conversation: malformed ? null : conversation, turns: [] });
        default:
          return Response.json({}, { status: 404 });
      }
    });
    await page.goto(`${origin}/doc-chats?mode=live${path === "detail" ? `&chat=${id}` : ""}`);
    await expect(page.getByRole("status")).toHaveText("Chats couldn’t be loaded.");
    malformed = false;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(page.getByLabel("Question for Doc")).toBeEnabled();
    await expect(page.getByRole("link", { name: question })).toBeVisible();
  });
}

for (const path of ["send", "retry"] as const) {
  test(`A malformed 200 from Doc ${path} keeps the question and offers a send retry`, async (t) => {
    const asks: unknown[] = [];
    const malformedAttempt = path === "send" ? 1 : 2;
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [], next_before: null });
        case "/api/engine/doc/turns": {
          const ask: unknown = await request.json();
          asks.push(ask);
          assert.ok(ask && typeof ask === "object" && "idempotency_key" in ask);
          if (asks.length < malformedAttempt) return Response.json({}, { status: 503 });
          return Response.json({
            conversation_id: id,
            turn: {
              ...answeredTurn,
              position: asks.length === malformedAttempt ? 0 : 1,
              idempotency_key: ask.idempotency_key,
            },
          });
        }
        default:
          return Response.json({}, { status: 404 });
      }
    });
    await page.goto(`${origin}/doc-chats?mode=live`);
    const composer = page.getByLabel("Question for Doc");
    const status = page.getByRole("status");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await composer.fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (path === "retry") {
      await expect(status).toHaveText("The question couldn’t be sent. Try again.");
      await retry.click();
    }
    await expect(status).toHaveText("The question couldn’t be sent. Try again.");
    await expect(composer).toHaveValue(question);
    await retry.click();
    await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
    assert.equal(asks.length, malformedAttempt + 1);
    for (const ask of asks) assert.deepEqual(ask, asks[0]);
  });
}

test("Ask Doc opens saved turns, retries the first ask with its original payload, and clears on account change", async (t) => {
  const payloads: unknown[] = [];
  let actor = "joe";
  let state = "queued";
  let firstKey = "";
  let malformed = false;
  const first = () => ({
    ...answeredTurn,
    idempotency_key: firstKey,
    state,
    waiting_reason: state === "queued" ? "Doc isn't set up on your Mac yet." : null,
    answer: state === "answered" ? answeredTurn.answer : null,
  });
  const { page, origin } = await docChatFixture(
    t,
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/engine/doc/conversations")
        return Response.json({ conversations: firstKey && actor === "joe" ? [conversation] : [], next_before: null });
      if (path === `/api/engine/doc/conversations/${id}`)
        return actor === "joe"
          ? Response.json(malformed ? { conversation } : { conversation, turns: [first()] })
          : Response.json({}, { status: 404 });
      if (path !== "/api/engine/doc/turns") return Response.json({}, { status: 404 });
      assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
      const ask: unknown = await request.json();
      payloads.push(ask);
      assert.ok(ask && typeof ask === "object" && "idempotency_key" in ask && typeof ask.idempotency_key === "string");
      if (!firstKey) firstKey = ask.idempotency_key;
      if (payloads.length < 3) return Response.json({ conversation_id: id, turn: first() }, { status: 202 });
      return Response.json(
        {
          conversation_id: id,
          turn: {
            ...answeredTurn,
            id: "00000000-0000-4000-8000-000000000003",
            position: 2,
            question: "Any follow-ups?",
            state: "working",
            idempotency_key: ask.idempotency_key,
            context: null,
            answer: null,
            waiting_reason: null,
          },
        },
        { status: 202 },
      );
    },
    () => actor,
  );
  await page.goto(`${origin}/doc-chats?mode=live`);
  const composer = page.getByLabel("Question for Doc");
  await expect(composer).toBeEnabled();
  await composer.fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  assert.match(page.url(), /[?&]chat=/);
  await page.reload();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  malformed = true;
  await page.reload();
  await expect(page.getByText("Chats couldn’t be loaded.")).toBeVisible();
  malformed = false;
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  await page.getByRole("link", { name: "New chat" }).click();
  state = "failed";
  await page.getByRole("link", { name: question }).click();
  await expect(page.getByText("Doc couldn’t answer.")).toBeVisible();
  state = "queued";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  assert.deepEqual(payloads[1], payloads[0]);
  state = "answered";
  await page.getByRole("button", { name: "Check for answer" }).click();
  await expect(page.getByText("One example deal is open.")).toBeVisible();
  await composer.fill("Any follow-ups?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Doc is working.")).toBeVisible();
  assert.deepEqual(payloads[2], {
    question: "Any follow-ups?",
    idempotency_key: Reflect.get(Object(payloads[2]), "idempotency_key"),
    conversation_id: id,
  });
  actor = "dell";
  await page.getByRole("button", { name: "Check for answer" }).click();
  await expect(page.getByText("One example deal is open.")).toHaveCount(0);
  const foreign = await page.request.get(`${origin}/api/engine/doc/conversations/${id}`);
  assert.equal(foreign.status(), 404);
});
