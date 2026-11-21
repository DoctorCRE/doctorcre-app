import assert from "node:assert/strict";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { reproTest } from "./support.mjs";

const test = reproTest();
const viewports = [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
];

async function preferenceGeometry(browser: Browser) {
  return browser.evaluate(() => {
    const control = document.querySelector("#deviceOptIn");
    const tabbar = document.querySelector(".app-layout-tabbar");
    if (!control || !tabbar) throw new Error("Missing notification preference controls");
    const box = control.getBoundingClientRect();
    const tabs = tabbar.getBoundingClientRect();
    return {
      controlTop: box.top,
      controlBottom: box.bottom,
      tabbarBottom: tabs.bottom,
      viewportHeight: innerHeight,
      clear: box.top >= tabs.bottom && box.bottom < innerHeight,
      uncovered: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === control,
    };
  });
}

for (const viewport of viewports) {
  test(`QA-010 notification preferences navigation brings controls into view at ${viewport.width}px`, {
    tags: ["regression"],
    requires: ["browser"],
    retries: 0,
  }, async ({ app, browser, screen }) => {
    await browser.setViewport(viewport);
    await app.open("/");
    await screen.getByRole("button", /account and settings/i).tap();
    await screen.getByRole("link", "Notification preferences").tap();
    await expect(browser).toHaveURL("/updates#prefForm");
    await expect(screen.getByRole("heading", "Your notification preferences")).toBeVisible();
    await expect(browser.locator("#prefSave")).toBeEnabled();
    // Enabling the fields precedes the next animation frame that anchors them.
    await expect.poll(async () => (await preferenceGeometry(browser)).clear).toBe(true);
    await expect.poll(async () => (await preferenceGeometry(browser)).uncovered).toBe(true);
    const form = await browser.locator("#prefForm").boundingBox();
    assert.ok(form);
    expect(form.y, JSON.stringify({ form, viewport })).toBeGreaterThanOrEqual(0);
    expect(form.y, JSON.stringify({ form, viewport })).toBeLessThan(viewport.height);
    await browser.locator("#deviceOptIn").focus();
    await expect(browser.locator("#deviceOptIn")).toBeFocused();
    await app.screenshot(`preferences-navigation-${viewport.width}`);
  });
}

for (const viewport of viewports) {
  for (const initialFailure of [false, true]) {
    test(`QA-010 preferences anchor once after first success at ${viewport.width}px (failure: ${initialFailure})`, {
      tags: ["regression"],
      requires: ["browser"],
      retries: 0,
    }, async ({ app, browser }) => {
      await browser.setViewport(viewport);
      assert.ok(app.baseUrl);
      const { promise: feedGate, resolve: releaseFeed } = Promise.withResolvers<void>();
      if (!initialFailure)
        await browser.route(`${new URL(app.baseUrl).origin}/mcp`, async (route) => {
          const request = JSON.parse(route.request.postData || "{}");
          if (request.params?.name === "notification-feed" && request.params.arguments?.limit === 25) await feedGate;
          return route.continue();
        });
      if (initialFailure) {
        await browser.route(`${new URL(app.baseUrl).origin}/mcp`, (route) => {
          const request = JSON.parse(route.request.postData || "{}");
          return request.params?.name === "read-notification-preferences"
            ? route.fulfill({ status: 503, json: { ok: false, error: "temporarily_unavailable" } })
            : route.continue();
        });
      }
      await app.open("/updates?mode=live#prefForm");
      await expect(browser.locator("#docMorningBrief")).toBeHidden();
      if (initialFailure) {
        await expect(browser.locator("#prefForm")).toBeHidden();
        await expect(browser.locator("#prefState")).toContainText(/unavailable|could not/i);
        await browser.unroute(`${new URL(app.baseUrl).origin}/mcp`);
        await browser.locator("#selfAvatar").tap();
        await browser.locator("#appSyncRefresh").tap();
      }
      await expect(browser.locator("#deviceOptIn")).toBeEnabled();
      if (!initialFailure) {
        // Let an early preference anchor run before the feed changes page height.
        await browser.evaluate(
          () =>
            new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))),
        );
        releaseFeed();
        await expect(browser.locator("#feedList li").first()).toBeVisible();
      }
      // Wait on geometry, including the actual first control under sticky tabs.
      await expect.poll(async () => (await preferenceGeometry(browser)).clear).toBe(true);
      await expect.poll(async () => (await preferenceGeometry(browser)).uncovered).toBe(true);
      // Anchoring scrolls without taking focus from the user's retry control.
      if (initialFailure) await expect(browser.locator("#selfAvatar")).toBeFocused();
      await app.screenshot(`preferences-anchor-${viewport.width}`);
      const observed = await browser.evaluate(
        async () => (await import(new URL("/js/notifications.js", location.href).href)).view.preference.observed_at,
      );
      await browser.locator("#deviceOptIn").focus();
      await browser.evaluate(() => {
        window.scrollTo({ top: 0, behavior: "instant" });
        return scrollY;
      });
      const before = await browser.evaluate(() => scrollY);
      // A later successful background refresh must not anchor again.
      await browser.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect
        .poll(async () =>
          browser.evaluate(
            async () => (await import(new URL("/js/notifications.js", location.href).href)).view.preference.observed_at,
          ),
        )
        .not.toBe(observed);
      await expect(browser.locator("#prefSave")).toBeEnabled();
      await expect.poll(async () => browser.evaluate(() => scrollY)).toBe(before);
      await expect(browser.locator("#deviceOptIn")).toBeFocused();
    });
  }
}
