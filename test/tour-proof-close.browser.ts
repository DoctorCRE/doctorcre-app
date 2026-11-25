import assert from "node:assert/strict";
import test from "node:test";
import { chromium as driver } from "playwright";
import { signedInReplyEngine } from "../scripts/prove-reply-action-link.ts";
import { prove } from "../scripts/prove-tour-stop-drag.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { fixtureDeal, startTourDragFixture, tourDragRoutes } from "./tour-stop-drag-proof-fixture.ts";

test("Tour proof fails clearly when Chrome never closes its tab", async (t) => {
  const server = await startTourDragFixture(await tourDragRoutes());
  t.after(() => server.close());
  const browserFixture = await ownedCdpFixture();
  t.after(() => browserFixture.close());
  t.after(() => browserFixture.browser.close());
  const engine = signedInReplyEngine(browserFixture.endpoint, {
    async connectOverCDP(...args) {
      const connection = await driver.connectOverCDP(...args);
      const context = connection.contexts()[0];
      assert.ok(context);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.close = () => new Promise<void>(() => {});
        return page;
      };
      return connection;
    },
  });
  await assert.rejects(
    prove({
      origin: server.origin,
      expectedCommit: "1".repeat(40),
      tourUrl: `${server.origin}/deals?deal=${fixtureDeal}`,
      engine,
      timeoutMs: 20_000,
    }),
    { exitCode: 78, message: /did not close/ },
  );
});
