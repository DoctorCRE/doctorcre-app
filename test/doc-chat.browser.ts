import assert from "node:assert/strict";
import test from "node:test";
import { expect } from "@playwright/test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("Ask Doc opens saved turns, retries the first ask with its original payload, and clears on account change", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const question = "Which example deals are open?";
  const conversation = { id, title: question };
  const payloads: unknown[] = [];
  let actor = "joe";
  let state = "queued";
  let firstKey = "";
  const first = () => ({
    id: "first",
    position: 1,
    idempotency_key: firstKey,
    question,
    state,
    context: null,
    waiting_reason: state === "queued" ? "Doc isn't set up on your Mac yet." : null,
    answer: state === "answered" ? { text: "One example deal is open." } : null,
  });
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      PARTNER_SIGN_IN: "engine",
      PARTNER_APP: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          if (path === "/auth/session") return Response.json({ actor: { slug: actor }, csrf_token: `${actor}-test` });
          if (path === "/api/engine/doc/conversations")
            return Response.json({ conversations: firstKey && actor === "joe" ? [conversation] : [] });
          if (path === `/api/engine/doc/conversations/${id}`)
            return actor === "joe"
              ? Response.json({ conversation, turns: [first()] })
              : Response.json({}, { status: 404 });
          if (path !== "/api/engine/doc/turns") return Response.json({}, { status: 404 });
          assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
          const ask: unknown = await request.json();
          payloads.push(ask);
          assert.ok(
            ask && typeof ask === "object" && "idempotency_key" in ask && typeof ask.idempotency_key === "string",
          );
          if (!firstKey) firstKey = ask.idempotency_key;
          if (payloads.length < 3) return Response.json({ conversation_id: id, turn: first() }, { status: 202 });
          return Response.json(
            {
              conversation_id: id,
              turn: { id: "second", position: 2, question: "Any follow-ups?", state: "working" },
            },
            { status: 202 },
          );
        },
      },
    },
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.origin}/doc-chats?mode=live`);
    const composer = page.getByLabel("Question for Doc");
    await expect(composer).toBeEnabled();
    await composer.fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
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
    const foreign = await page.request.get(`${server.origin}/api/engine/doc/conversations/${id}`);
    assert.equal(foreign.status(), 404);
  } finally {
    await browser.close();
    await server.close();
  }
});
