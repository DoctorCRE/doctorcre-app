import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { expect } from "@playwright/test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium, pausedClock } from "./browser-harness.mjs";
import { FixtureHtmlRewriter } from "./fixtures/worker-html.ts";

Object.defineProperty(globalThis, "HTMLRewriter", { configurable: true, value: FixtureHtmlRewriter });

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
  draft_review: null,
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  t.after(async () => {
    try {
      await page?.unrouteAll({ behavior: "ignoreErrors" });
      await browser?.close();
    } finally {
      await server.close();
    }
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
    await page.getByRole("button", { name: "Recent chats", exact: true }).click();
    await expect(page.getByRole("link", { name: question })).toBeVisible();
  });
}

for (const scenario of ["send", "retry", "send with an empty conversation ID"] as const) {
  test(`A malformed 200 from Doc ${scenario} keeps the question and offers a send retry`, async (t) => {
    const asks: unknown[] = [];
    const malformedAttempt = scenario === "retry" ? 2 : 1;
    const emptyId = scenario === "send with an empty conversation ID";
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: emptyId ? [conversation] : [], next_before: null });
        case `/api/engine/doc/conversations/${id}`:
          return Response.json({ conversation, turns: [] });
        case "/api/engine/doc/turns": {
          const ask: unknown = await request.json();
          asks.push(ask);
          assert.ok(ask && typeof ask === "object" && "idempotency_key" in ask);
          if (asks.length < malformedAttempt) return Response.json({}, { status: 503 });
          const malformed = asks.length === malformedAttempt;
          return Response.json({
            conversation_id: malformed && emptyId ? "" : id,
            turn: {
              ...answeredTurn,
              position: malformed && !emptyId ? 0 : 1,
              idempotency_key: ask.idempotency_key,
            },
          });
        }
        default:
          return Response.json({}, { status: 404 });
      }
    });
    const chatUrl = `${origin}/doc-chats?mode=live${emptyId ? `&chat=${id}` : ""}`;
    await page.goto(chatUrl);
    const composer = page.getByLabel("Question for Doc");
    const status = page.getByRole("status");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await composer.fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (scenario === "retry") {
      await expect(status).toHaveText("The question couldn’t be sent. Try again.");
      await retry.click();
    }
    await expect(status).toHaveText("The question couldn’t be sent. Try again.");
    await expect(composer).toHaveValue(question);
    await expect(page).toHaveURL(chatUrl);
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
  await page.clock.install();
  const evalViolations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.blockedURI === "eval") console.error("Doc chat attempted to evaluate JavaScript");
    });
  });
  page.on("console", (message) => {
    if (message.text() === "Doc chat attempted to evaluate JavaScript") evalViolations.push(message.text());
  });
  const navigation = await page.goto(`${origin}/doc-chats?mode=live`);
  assert.match(navigation?.headers()["content-security-policy"] ?? "", /script-src 'self'/);
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
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("link", { name: question }).click();
  await expect(page.getByText("Doc couldn’t answer.")).toBeVisible();
  state = "queued";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  assert.deepEqual(payloads[1], payloads[0]);
  state = "answered";
  await page.clock.fastForward(5_000);
  await expect(page.getByText("One example deal is open.")).toBeVisible();
  await composer.fill("Any follow-ups?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Doc is working.")).toBeVisible();
  assert.deepEqual(payloads[2], {
    question: "Any follow-ups?",
    idempotency_key: Reflect.get(Object(payloads[2]), "idempotency_key"),
    conversation_id: id,
  });
  await composer.fill("An unsent follow-up");
  actor = "dell";
  await page.clock.fastForward(5_000);
  await expect(page).toHaveURL(`${origin}/public-shell/session-ended.html`);
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(page.getByText("One example deal is open.")).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  const foreign = await page.request.get(`${origin}/api/engine/doc/conversations/${id}`);
  assert.equal(foreign.status(), 404);
  assert.deepEqual(evalViolations, []);
});

for (const storageBlocked of [false, true]) {
  test(`Ask Doc question drafts ${storageBlocked ? "are optional when storage is blocked" : "survive reload until sent or the session ends"}`, async (t) => {
    let actor = "joe";
    const errors: Error[] = [];
    const { page, origin } = await docChatFixture(
      t,
      async (request) => {
        switch (new URL(request.url).pathname) {
          case "/api/engine/doc/conversations":
            return Response.json({ conversations: [conversation], next_before: null });
          case detailPath:
            return Response.json({ conversation, turns: [] });
          case "/api/engine/doc/turns": {
            const { idempotency_key } = await request.json();
            return Response.json({ conversation_id: id, turn: { ...answeredTurn, idempotency_key } });
          }
          default:
            return new Response(null, { status: 404 });
        }
      },
      () => actor,
    );
    if (storageBlocked) {
      await page.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", {
          get() {
            throw new DOMException("Storage blocked", "SecurityError");
          },
        });
      });
    }
    page.on("pageerror", (error) => errors.push(error));
    const start = `${origin}/doc-chats?mode=live`;
    const chat = `${start}&chat=${id}`;
    const composer = page.getByLabel("Question for Doc");
    await page.goto(chat);
    await composer.fill(question);
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue(storageBlocked ? "" : question);
    if (storageBlocked) {
      await composer.fill(question);
    } else {
      await page.goto(start);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.getByRole("button", { name: "Recent chats", exact: true }).click();
      await page.getByRole("link", { name: question }).click();
      await expect(composer).toHaveValue(question);
    }
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("");

    if (!storageBlocked) {
      await composer.fill("Draft before account change");
      await page.goto(start);
      await composer.fill("Unsent first question");
      await page.reload();
      await expect(composer).toHaveValue("Unsent first question");
      actor = "dell";
      await page.reload();
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.goto(chat);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await composer.fill("Draft before sign-out");
    }
    await page.evaluate(async () => {
      const { privateSession } = await import(String("/js/private-session.js"));
      privateSession().revoke("signed-out");
    });
    await expect(page).toHaveURL(`${origin}/public-shell/session-ended.html`);
    await page.goto(chat);
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("");
    if (!storageBlocked) {
      actor = "joe";
      await page.goto(chat);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.goto(start);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
    }
    assert.deepEqual(errors, []);
  });
}

test("Doc accepts engine IDs without RFC version or variant bits", async (t) => {
  const engineId = "11111111-2222-3333-4444-555555555555";
  const engineConversation = { ...conversation, id: engineId };
  const { page, origin } = await docChatFixture(t, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [engineConversation], next_before: engineId });
    if (path === `/api/engine/doc/conversations/${engineId}`)
      return Response.json({ conversation: engineConversation, turns: [] });
    if (path === "/api/engine/doc/turns") {
      const ask = await request.json();
      assert.equal(ask.conversation_id, engineId);
      return Response.json({
        conversation_id: engineId,
        turn: { ...answeredTurn, id: engineId, idempotency_key: engineId },
      });
    }
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("link", { name: question }).click();
  await page.getByLabel("Question for Doc").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
});

test("Backup answers are marked while Mac answers and waiting questions are not", async (t) => {
  let source: "backup" | "mac" | null = "backup";
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === `/api/engine/doc/conversations/${id}`)
      return Response.json({
        conversation,
        turns: [
          {
            ...answeredTurn,
            idempotency_key: id,
            answered_by: source,
            state: source ? "answered" : "queued",
            answer: source ? answeredTurn.answer : null,
            waiting_reason: source ? null : "Doc answers when your Mac is on.",
          },
        ],
      });
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Answered by the backup.")).toBeVisible();
  source = "mac";
  await page.reload();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(page.getByText("Answered by the backup.")).toHaveCount(0);
  source = null;
  await page.reload();
  await expect(page.getByText("Doc answers when your Mac is on.")).toBeVisible();
  await expect(page.getByText("Answered by the backup.")).toHaveCount(0);
});

test("A reopened Doc question keeps its place and lets the partner draft a follow-up as it refreshes", async (t) => {
  const waitingLines = [
    "Doc answers when your Mac is on.",
    "Doc is paused until your Claude plan resets.",
    "Sign in to Claude Code on your Mac.",
    "Doc is waiting for a free slot on your Mac.",
  ] as const;
  const saved = { ...answeredTurn, idempotency_key: id };
  let state = "queued";
  let waitingReason: string | null = waitingLines[0];
  const detailPath = `/api/engine/doc/conversations/${id}`;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === detailPath)
      return Response.json({
        conversation,
        turns: [{ ...saved, state, waiting_reason: waitingReason, answer: state === "answered" ? saved.answer : null }],
      });
    return Response.json({}, { status: 404 });
  });
  const docReads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/engine/doc/")) docReads.push(path);
  });
  await pausedClock(page, new Date(created_at));
  const url = `${origin}/doc-chats?mode=live&chat=${id}`;
  await page.goto(url);
  await expect(page.getByText(waitingLines[0], { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await composer.fill("Any follow-ups?");
  await expect(send).toBeDisabled();

  for (const waiting_reason of waitingLines.slice(1)) {
    waitingReason = waiting_reason;
    await page.clock.runFor(5_000);
    await expect(page.getByText(waiting_reason, { exact: true })).toBeVisible();
  }
  state = "working";
  waitingReason = null;
  await page.clock.runFor(5_000);
  await expect(page.getByText("Doc is working.")).toBeVisible();

  state = "answered";
  await page.clock.runFor(5_000);
  await expect(page.getByText(saved.answer.text)).toBeVisible();
  await expect(page.getByText(question, { exact: true }).and(page.locator("p"))).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Check for answer|Refresh chat/ })).toHaveCount(0);
  await expect(page).toHaveURL(url);
  await expect(composer).toHaveValue("Any follow-ups?");
  await expect(composer).toBeFocused();
  await expect(send).toBeEnabled();

  await page.clock.runFor(15_000);
  assert.deepEqual(docReads, ["/api/engine/doc/conversations", ...Array(6).fill(detailPath)]);
});

const detailPath = `/api/engine/doc/conversations/${id}`;
const queuedTurn = { ...answeredTurn, idempotency_key: id, state: "queued", answer: null };
const answered = { ...answeredTurn, idempotency_key: id };

function waitingChat(t: TestContext) {
  return docChatFixture(t, (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [conversation], next_before: null });
      case detailPath:
        return Response.json({ conversation, turns: [queuedTurn] });
      default:
        return Response.json({}, { status: 404 });
    }
  });
}

test("Back reloads Ask Doc once and a failed session check cannot read the saved chat", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  const url = `${origin}/doc-chats?mode=live&chat=${id}`;
  await page.goto(url);
  await expect(page.getByText("Doc is waiting.", { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  await composer.fill("An unsent Back follow-up");

  let reloads = 0;
  let detailReads = 0;
  await page.route(url, (route) => {
    reloads++;
    return route.continue();
  });
  await page.route(`**${detailPath}`, (route) => {
    detailReads++;
    return route.fulfill({ json: { conversation, turns: [answered] } });
  });
  const sessionUrl = "**/auth/session";
  await page.route(sessionUrl, (route) => route.fulfill({ status: 503 }));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
  assert.equal(reloads, 0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible({ timeout: 5_000 });
  await page.clock.runFor(5_000);
  assert.equal(reloads, 1);
  assert.equal(detailReads, 0);
  await expect(page.getByText("Doc is waiting.", { exact: true })).toHaveCount(0);

  await page.unroute(sessionUrl);
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  await expect(composer).toHaveValue("An unsent Back follow-up");
  assert.equal(detailReads, 1);
  assert.equal(reloads, 1);
});

test("A visible Ask Doc chat can receive its answer after three idle hours", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Doc is waiting.", { exact: true })).toBeVisible();

  const reads = await page.evaluateHandle(
    ({ detailPath, conversation, queuedTurn, answered }) => {
      const requests: { path: string; minute: number }[] = [];
      const started = Date.now();
      window.fetch = async (input) => {
        const path = String(input);
        const minute = (Date.now() - started) / 60_000;
        requests.push({ path, minute });
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "joe-test" });
        if (path !== detailPath) return Response.json({}, { status: 404 });
        const waiting_reason =
          minute >= 120
            ? "Doc is paused until your Claude plan resets."
            : minute >= 60
              ? "Doc answers when your Mac is on."
              : null;
        return Response.json({
          conversation,
          turns: [minute >= 180 ? answered : { ...queuedTurn, waiting_reason }],
        });
      };
      return requests;
    },
    { detailPath, conversation, queuedTurn, answered },
  );
  await page.clock.runFor(182 * 60_000);
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  const requests = await reads.jsonValue();
  await reads.dispose();
  assert.deepEqual([...new Set(requests.map(({ path }) => path))], [detailPath]);
  for (const [start, end, expected] of [
    [0, 1, 12],
    [1, 60, 118],
    [60, 120, 30],
    [120, 180, 30],
  ] as const) {
    const count = requests.filter(({ minute }) => minute > start && minute <= end).length;
    assert.ok(
      Math.abs(count - expected) <= 2,
      `Expected about ${expected} reads from minute ${start} to ${end}, got ${count}`,
    );
  }
});

test("An unavailable chat keeps the unsent question and other recent chats for the same account", async (t) => {
  const other = { ...conversation, id: answeredTurn.id, title: "Another example chat" };
  let unavailable = false;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation, other], next_before: null });
    if (path === detailPath && !unavailable) return Response.json({ conversation, turns: [queuedTurn] });
    return Response.json({}, { status: 404 });
  });
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Doc is waiting.", { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  const otherChat = page.getByRole("link", { name: other.title });
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await expect(otherChat).toBeVisible();
  await composer.fill("An unsent follow-up");

  unavailable = true;
  await page.clock.runFor(5_000);
  await expect(page.getByRole("status")).toHaveText("Conversation unavailable");
  await expect(composer).toHaveValue("An unsent follow-up");
  await expect(composer).toBeEnabled();
  await expect(otherChat).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("Ask Doc retries an exhausted read after a quick tab return with input", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Doc is waiting.", { exact: true })).toBeVisible();

  await page.clock.runFor(500);
  await page.evaluate(() => {
    for (const value of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.clock.runFor(4_999);

  const reads = await page.evaluateHandle(
    async ({ detailPath, conversation, answered }) => {
      const { privateSession } = await import(String("/js/private-session.js"));
      const session = privateSession();
      const paths: string[] = [];
      window.fetch = async (input) => {
        const path = String(input);
        if (path === "/fixture/other-read") return Response.json({});
        paths.push(path);
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "joe-test" });
        if (path === detailPath) return Response.json({ conversation, turns: [answered] });
        return Response.json({}, { status: 404 });
      };
      await Promise.allSettled(Array.from({ length: 600 }, () => session.fetch("/fixture/other-read")));
      return paths;
    },
    { detailPath, conversation, answered },
  );
  const paused = page.getByRole("status", { includeHidden: true }).filter({ hasText: /paused/i });
  await page.clock.runFor(1);
  assert.deepEqual(await reads.jsonValue(), [], "the first chat read is refused");
  await expect(paused).toHaveCount(1);
  await page.keyboard.press("Shift");
  const noticesAfterInput = await paused.count();
  await page.clock.runFor(5_000);
  assert.deepEqual(await reads.jsonValue(), [detailPath], "the next tick reads without another visibility event");
  assert.equal(noticesAfterInput, 1, "input does not clear the pause");
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  await expect(paused).toHaveCount(0);
  await reads.dispose();
});

test("Doc links to app records and renders other source labels as text", async (t) => {
  const ref = { kind: "deal", id };
  const href = `/deals?deal=${id}`;
  const unsafe = [
    { ref, label: "Script source", href: "javascript:void(0)" },
    { ref, label: "External source", href: "https://example.test/deal" },
    { ref, label: "Network-path source", href: "//example.test/deal" },
    { ref, label: "Backslash source", href: "/\\example.test/deal" },
    { ref, label: "Data source", href: "data:text/plain,example" },
  ];
  const turn = {
    ...answeredTurn,
    idempotency_key: id,
    answer: {
      ...answeredTurn.answer,
      sources: [{ ref, label: "Example deal record", href }, ...unsafe],
    },
  };
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === `/api/engine/doc/conversations/${id}`) return Response.json({ conversation, turns: [turn] });
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByRole("link", { name: "Example deal record" })).toHaveAttribute("href", href);
  for (const { label } of unsafe) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: label })).toHaveCount(0);
  }
});

test("Session invalidation aborts an in-flight Doc refresh and clears the chat", async (t) => {
  const waiting = "Doc answers when your Mac is on.";
  const turn = { ...answeredTurn, idempotency_key: id, state: "queued", answer: null, waiting_reason: waiting };
  const detailPath = `/api/engine/doc/conversations/${id}`;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === detailPath) return Response.json({ conversation, turns: [turn] });
    return Response.json({}, { status: 404 });
  });
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText(waiting, { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  await composer.fill("Any follow-ups?");

  let requests = 0;
  await page.route(`${origin}${detailPath}`, () => {
    requests++;
  });
  const started = page.waitForRequest(`${origin}${detailPath}`);
  await page.clock.runFor(5_000);
  const request = await started;
  const aborted = page.waitForEvent("requestfailed", (failed) => failed === request);
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  await aborted;
  await expect(page.getByRole("status")).toHaveText("Sign in again to open your chats.");
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await page.clock.runFor(15_000);
  assert.equal(requests, 1);
});

const confirmationPath = `/api/engine/doc/turns/${answeredTurn.id}/confirmation`;
const deal = { ref: { kind: "deal", id }, label: "Example deal", href: `/deals?deal=${id}` };
const savedId = "00000000-0000-4000-8000-000000000004";
const draftHref = `/inbox/card/${encodeURIComponent(`reply_draft:${savedId}`)}`;

for (const scenario of ["note", "next step", "reply", "unavailable"] as const) {
  test(`Doc confirms an edited proposal for ${scenario}`, async (t) => {
    const note = { kind: "note", target: deal, text: "A proposed note" };
    const proposal =
      scenario === "next step"
        ? { kind: "next_step", target: deal, what: "A proposed step", due_on: "2026-01-02" }
        : scenario === "reply"
          ? {
              kind: "reply_draft",
              target: { ref: { kind: "email", id }, label: "Example email", href: "/inbox" },
              subject: "A proposed subject",
              body: "A proposed reply",
            }
          : note;
    const askKey = "00000000-0000-4000-8000-000000000003";
    const turn = { ...answeredTurn, idempotency_key: askKey, answer: { ...answeredTurn.answer, proposal } };
    const attempts: { idempotency_key: string; edits: unknown }[] = [];
    let result: { kind: string; id: string; href: string; existing?: boolean } | null = null;
    let saves = 0;
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case detailPath:
          return Response.json({ conversation, turns: [{ ...turn, confirmation: result }] });
        case confirmationPath: {
          assert.equal(request.method, "POST");
          assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
          const command: unknown = await request.json();
          assert.ok(
            command &&
              typeof command === "object" &&
              "idempotency_key" in command &&
              typeof command.idempotency_key === "string" &&
              "edits" in command,
          );
          attempts.push({ idempotency_key: command.idempotency_key, edits: command.edits });
          if (scenario === "unavailable") return Response.json({ error: "not_found" }, { status: 404 });
          if (scenario === "next step")
            return Response.json(
              { error: "open_step_exists", next_step_id: savedId, href: deal.href },
              { status: 409 },
            );
          if (!result) {
            saves++;
            result =
              scenario === "reply"
                ? { kind: "reply_draft", id: savedId, href: draftHref, existing: true }
                : { kind: "note", id: savedId, href: deal.href };
          }
          return Response.json({ result });
        }
        default:
          return Response.json({}, { status: 404 });
      }
    });
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
    await expect(page.getByRole("link", { name: proposal.target.label, exact: true })).toHaveAttribute(
      "href",
      proposal.target.href,
    );
    assert.equal(attempts.length, 0);
    const save = (name: string) => page.getByRole("button", { name, exact: true }).click();

    if (scenario === "next step") {
      await expect(page.getByText("Owner: You")).toBeVisible();
      await page.getByLabel("Next step", { exact: true }).fill("An edited step");
      await page.getByLabel("Due date").fill("");
      await save("Save next step");
      await expect(page.getByRole("link", { name: "Open existing next step" })).toHaveAttribute("href", deal.href);
      await expect(page.getByLabel("Next step", { exact: true })).toHaveValue("An edited step");
      assert.deepEqual(
        attempts.map(({ edits }) => edits),
        [{ what: "An edited step", due_on: null }],
      );
      assert.equal(saves, 0);
      return;
    }

    if (scenario === "reply") {
      await page.getByLabel("Subject").fill("An edited subject");
      await page.getByLabel("Reply", { exact: true }).fill("An edited reply");
      await page.route(`${origin}${draftHref}`, (route) => route.fulfill({ body: "Example reply review" }));
      await save("Save draft and open review");
      await expect(page).toHaveURL(`${origin}${draftHref}`);
      assert.deepEqual(
        attempts.map(({ edits }) => edits),
        [{ subject: "An edited subject", body: "An edited reply" }],
      );
      return;
    }

    const field = page.getByLabel("Note", { exact: true });
    await field.fill("An edited note");
    await page.reload();
    await expect(field).toHaveValue("An edited note");
    if (scenario === "unavailable") {
      await save("Save note");
      await expect(page.getByRole("alert")).toHaveText("This record is no longer available.");
      await expect(field).toHaveValue("An edited note");
      assert.equal(saves, 0);
      return;
    }

    await page.route(
      `${origin}${confirmationPath}`,
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort();
      },
      { times: 1 },
    );
    await save("Save note");
    await expect(page.getByRole("alert")).toHaveText("Doc couldn’t tell if this saved. Try again.");
    await expect(field).toHaveValue("An edited note");
    assert.equal(saves, 1);
    await save("Retry save");
    const saved = page.getByRole("link", { name: "Open saved note" });
    await expect(saved).toHaveAttribute("href", deal.href);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(saves, 1);
    const [command] = attempts;
    assert.ok(command);
    assert.notEqual(command.idempotency_key, askKey);
    assert.deepEqual(command.edits, { text: "An edited note" });
    await page.reload();
    await expect(saved).toHaveCount(1);
    await expect(field).toHaveCount(0);
  });
}

test("Doc identifies refused reply fields and keeps edits", async (t) => {
  const proposal = {
    kind: "reply_draft",
    target: { ref: { kind: "email", id }, label: "Example email", href: "/inbox" },
    subject: "Subject",
    body: "Reply",
  };
  const turn = {
    ...answeredTurn,
    idempotency_key: "00000000-0000-4000-8000-000000000003",
    answer: { ...answeredTurn.answer, proposal },
  };
  const { page, origin } = await docChatFixture(t, async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [conversation], next_before: null });
      case detailPath:
        return Response.json({ conversation, turns: [turn] });
      case confirmationPath:
        return Response.json(
          {
            error: "invalid_field_value",
            fields: ["body"],
            hint: "Check the named fields against the tool’s documented input.",
          },
          { status: 400 },
        );
      default:
        return Response.json({}, { status: 404 });
    }
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const subject = page.getByLabel("Subject");
  await expect(subject).toHaveAttribute("maxlength", "998");
  await subject.fill("Edited subject");
  const reply = page.getByLabel("Reply", { exact: true });
  await reply.fill("Edited reply");
  await page.getByRole("button", { name: "Save draft and open review" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a reply.");
  await expect(page.getByText("Check the named fields against the tool’s documented input.")).toHaveCount(0);
  await expect(reply).toHaveValue("Edited reply");
  await expect(subject).toHaveValue("Edited subject");
});

test("Recent chats pages on a phone and opens the chosen conversation", async (t) => {
  const older = { ...conversation, id: "00000000-0000-4000-8000-000000000003", title: "An older question" };
  let failOlder = true;
  const { page, origin } = await docChatFixture(t, (request) => {
    const url = new URL(request.url);
    if (url.searchParams.has("before") && failOlder) return Response.json({}, { status: 503 });
    if (url.pathname === "/api/engine/doc/conversations")
      return Response.json(
        url.searchParams.has("before")
          ? { conversations: [older], next_before: null }
          : { conversations: [conversation], next_before: id },
      );
    return Response.json({ conversation: older, turns: [] });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("button", { name: "Show older chats" }).click();
  await expect(page.getByRole("status")).toHaveText("Chats couldn’t be loaded.");
  failOlder = false;
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByRole("link", { name: older.title })).toBeVisible();
  await page.getByRole("link", { name: older.title }).click();
  await expect(page.getByLabel("Question for Doc")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const path of [`/doc-chats?id=${id}`, `/doc/conversations/${id}/turns/${id}`]) {
  test(`An unavailable legacy link offers a new chat: ${path}`, async (t) => {
    const { page, origin } = await docChatFixture(t, (request) =>
      new URL(request.url).pathname === "/api/engine/doc/conversations"
        ? Response.json({ conversations: [], next_before: null })
        : Response.json({}, { status: 404 }),
    );
    await page.goto(`${origin}${path}${path.includes("?") ? "&" : "?"}mode=live`);
    await expect(page.getByRole("status")).toHaveText("This older conversation wasn't kept");
    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page.getByLabel("Question for Doc")).toBeEnabled();
  });
}

for (const [width, theme, conflict, unavailable] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
  [1440, "dark"],
  [390, "light", "version_conflict"],
  [1440, "dark", "draft_changed"],
  [390, "light", undefined, ["not_set_up", "Doc isn't set up on your Mac yet."]],
  [390, "dark", undefined, ["mac_off", "Doc answers when your Mac is on."]],
  [1440, "light", undefined, ["signed_out", "Sign in to Claude Code on your Mac."]],
  [1440, "dark", undefined, ["plan_limited", "Doc is paused until your Claude plan resets."]],
  [390, "dark", undefined, ["legacy", "Sign in with DoctorCRE to talk to Doc."]],
  [1440, "light", undefined, ["read_failed", "Couldn't check whether Doc is ready."]],
] as const) {
  const scenario = unavailable ? ` with Doc link ${unavailable[0]}` : conflict ? ` after ${conflict}` : "";
  test(`Home reviews a Doc draft revision at ${width}px in ${theme}${scenario}`, async (t) => {
    const version = 7;
    const emailId = "00000000-0000-4000-8000-000000000005";
    const reviewKey = `reply_draft:${savedId}`;
    const email = { kind: "email", subject: "Floor plan request", body: "Can you send the east suite plan?" };
    const draft = { draft_id: savedId, version, subject: "Re: Floor plan request", body: "I will send the plan." };
    const field = width === 1440 && !conflict ? "subject" : "body";
    const proposed = field === "subject" ? "East suite plan" : "I can send the plan tomorrow.";
    const edited = field === "subject" ? "East suite floor plan" : "I can send the plan by noon tomorrow.";
    const result = { kind: "reply_revision", id: savedId, href: draftHref, version: version + 1 };
    const context = { kind: "reply_draft", id: savedId, version };
    const target = { ref: { kind: "reply_draft", id: savedId }, version, href: draftHref, label: "Reply draft" };
    let linkReads = 0;
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/link":
          linkReads++;
          return unavailable?.[0] === "read_failed"
            ? new Response(null, { status: 503 })
            : Response.json({ status: unavailable?.[0] ?? "ready" });
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [], next_before: null });
        case "/api/engine/doc/turns": {
          const ask = await request.json();
          assert.deepEqual(ask.context, context);
          assert.equal(ask.conversation_id, undefined);
          return Response.json({
            conversation_id: id,
            turn: {
              ...answeredTurn,
              question: ask.question,
              idempotency_key: ask.idempotency_key,
              context: { ...context, activity_id: emailId, mailbox_user_id: id },
              draft_review: { draft_id: savedId, version, current: "pending_same" },
              answer: {
                kind: "answer",
                text: "I made the timing more specific.",
                sources: [target],
                proposal: { kind: "reply_revision", target, [field]: proposed },
              },
            },
          });
        }
        case confirmationPath: {
          const command = await request.json();
          assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
          assert.deepEqual(command.edits, { [field]: edited });
          if (conflict)
            return Response.json(
              { error: conflict, version: conflict === "draft_changed" ? version : version + 1 },
              { status: 409 },
            );
          Object.assign(draft, { [field]: edited, version: result.version });
          return Response.json({ result });
        }
        default:
          return new Response(null, { status: 404 });
      }
    });
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((theme) => {
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
    }, theme);
    // Use the app's live hostname while keeping every request on the loopback fixture.
    const app = "https://app.doctorcre.com";
    await page.route(`${app}/**`, async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(app, origin), maxRedirects: 0 });
      if (unavailable?.[0] === "legacy" && new URL(route.request().url()).pathname === "/auth/session") {
        const headers = response.headers();
        delete headers["x-doctorcre-partner-sign-in"];
        await route.fulfill({ response, headers });
      } else {
        await route.fulfill({ response });
      }
    });
    await page.route("**/mcp", async (route) => {
      const {
        id,
        params: { name, arguments: args },
      } = route.request().postDataJSON();
      if (!["read-engine-home-card", "read-engine-home-draft"].includes(name))
        return route.fulfill({ json: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } } });
      const payload =
        name === "read-engine-home-card"
          ? {
              item_id: reviewKey,
              source_type: "email_proposal",
              source_id: savedId,
              reply_draft_id: savedId,
              reply_draft_status: "pending",
              source_version: String(draft.version),
              source_state: "needs_attention",
              title: "Reply about the floor plan",
              base_version: `${draft.version}:0:inbox`,
              activity_at: created_at,
              section: "inbox",
              disposition: "inbox",
              unseen: false,
              snoozed_until: null,
              hold_until: null,
              kind_label: "Reply draft",
              context_label: null,
              due_on: null,
              open_url: null,
              deal_id: null,
              action_id: null,
              action_version: null,
              completed_at: null,
              waiting_version: 0,
              waiting_on: null,
              merged_source_ids: [],
            }
          : {
              ...draft,
              status: "pending",
              to: "sender@example.test",
              cc: "partner@example.test",
              attachments: [],
              source_activity: email,
              thread: [{ ...email, activity_id: emailId, happened_at: created_at, sender_name: "Maya Example" }],
            };
      assert.equal(
        name === "read-engine-home-card" ? args.item_id : args.id,
        name === "read-engine-home-card" ? reviewKey : savedId,
      );
      await route.fulfill({
        json: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    });
    const fits = async () => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    await page.goto(app + draftHref);
    await expect(page.getByText(email.body, { exact: true })).toBeVisible();
    await expect(page.getByText(draft.body, { exact: true })).toBeVisible();
    await fits();
    const talk = page.getByRole("link", { name: "Talk to Doc about this draft", exact: true });
    if (unavailable) {
      await expect(talk).toHaveCount(0);
      await expect(page.getByText(unavailable[1], { exact: true })).toBeVisible({ timeout: 3000 });
      assert.equal(linkReads, unavailable[0] === "legacy" ? 0 : 1);
      await fits();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Subject", exact: true })).toBeEditable();
      return;
    }
    await talk.click({ timeout: 3000 });
    await expect(page.getByRole("link", { name: "Open reply review" })).toHaveAttribute("href", draftHref);
    await page.getByLabel("Question for Doc").fill("Can you clarify when I'll send the floor plan?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const revision = page.getByRole("textbox", { name: field === "subject" ? "Subject" : "Reply", exact: true });
    await expect(revision).toHaveValue(proposed);
    await expect(page.getByRole("button", { name: "Send reply", exact: true })).toHaveCount(0);
    await fits();
    await revision.fill(edited);
    const save = page.getByRole("button", { name: "Save revision", exact: true });
    await save.click();
    if (conflict) {
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(
        conflict === "version_conflict" ? "This draft has a newer revision." : "This draft is no longer pending.",
      );
      await expect(alert.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
      await expect(revision).toHaveValue(edited);
      await expect(save).toBeDisabled();
      return;
    }
    await expect(page).toHaveURL(app + draftHref);
    await expect(page.getByText(edited, { exact: true })).toBeVisible();
    await expect(page.getByText(draft[field === "subject" ? "body" : "subject"], { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeVisible();
    await fits();
  });
}

for (const current of ["changed", "gone", "pending_same"] as const) {
  test(`A second Doc tab opens a failed draft turn with current status ${current}`, async (t) => {
    const version = 7;
    let draftStatus: "changed" | "gone" | "pending_same" = "pending_same";
    const { page, origin } = await docChatFixture(t, (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case detailPath:
          return Response.json({
            conversation,
            turns: [
              {
                ...answeredTurn,
                idempotency_key: id,
                state: "failed",
                answer: null,
                context: { kind: "reply_draft", id: savedId, version, activity_id: id, mailbox_user_id: id },
                draft_review: { draft_id: savedId, version, current: draftStatus },
              },
            ],
          });
        default:
          return new Response(null, { status: 404 });
      }
    });
    const chatUrl = `${origin}/doc-chats?mode=live&chat=${id}`;
    await page.goto(chatUrl);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

    draftStatus = current;
    const secondTab = await page.context().newPage();
    await secondTab.goto(chatUrl);
    const chat = secondTab.getByRole("region", { name: "Conversation" });
    await expect(chat.getByText(question, { exact: true })).toBeVisible();
    const retry = chat.getByRole("button", { name: "Retry", exact: true });
    const freshReview = chat.getByRole("link", { name: "Open fresh review" });
    if (current === "pending_same") {
      await expect(retry).toBeVisible();
      await expect(freshReview).toHaveCount(0);
    } else {
      await expect(retry).toHaveCount(0);
      await expect(freshReview).toHaveAttribute("href", draftHref);
    }
  });
}

for (const [position, conflict, current, message] of [
  [1, "version_conflict", "changed", "This draft has a newer revision."],
  [2, "draft_changed", "gone", "This draft is no longer pending."],
] as const) {
  test(`Doc retries draft question ${position} with its original context and keeps a new unsent question`, async (t) => {
    const version = 7;
    const context = { kind: "reply_draft", id: savedId, version };
    let draftStatus: "pending_same" | typeof current = "pending_same";
    const turn = {
      ...answeredTurn,
      position,
      idempotency_key: "00000000-0000-4000-8000-000000000003",
      state: "failed",
      answer: null,
      context: { ...context, activity_id: id, mailbox_user_id: id },
    };
    const { page, origin } = await docChatFixture(t, async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/engine/doc/conversations") {
        if (url.searchParams.has("before"))
          return Response.json({
            conversations: [{ ...conversation, id: turn.id, title: "An older example chat" }],
            next_before: null,
          });
        return Response.json({ conversations: [conversation], next_before: id });
      }
      if (path === detailPath)
        return Response.json({
          conversation,
          turns: [{ ...turn, draft_review: { draft_id: savedId, version, current: draftStatus } }],
        });
      assert.equal(path, "/api/engine/doc/turns");
      assert.deepEqual(await request.json(), {
        question,
        idempotency_key: turn.idempotency_key,
        ...(position === 1 ? { context } : { conversation_id: id }),
      });
      draftStatus = current;
      return Response.json(
        { error: conflict, version: current === "changed" ? version + 1 : version },
        { status: 409 },
      );
    });
    await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
    const composer = page.getByLabel("Question for Doc");
    await composer.fill("One more thing to ask");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.click();
    await expect(page.getByRole("status")).toHaveText(message);
    await expect(page.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
    await expect(composer).toHaveValue("One more thing to ask");
    await expect(retry).toHaveCount(0);
    await page.getByRole("button", { name: "Recent chats", exact: true }).click();
    await page.getByRole("button", { name: "Show older chats" }).click();
    await expect(page.getByRole("link", { name: "An older example chat" })).toBeVisible();
    await page.getByRole("button", { name: "Back to conversation" }).click();
    await expect(page.getByRole("link", { name: "Open fresh review" })).toBeVisible({ timeout: 3000 });
    await expect(retry).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
    await expect(retry).toHaveCount(0);
    await expect(composer).toHaveValue("One more thing to ask");
  });
}
