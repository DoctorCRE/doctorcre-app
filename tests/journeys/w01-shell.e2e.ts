import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// The shell shows when Today last updated and remembers display settings.
test("W1 shell shows freshness and keeps its controls across a reload", async ({ app, browser, screen }) => {
  const expectTodayUpdate = async () => {
    const today = browser.locator("#appToday");
    const openDrawer = !(await today.isVisible());
    if (openDrawer) await screen.getByRole("button", "Today sidebar").tap();
    const stamp = browser.locator("#appTodayTitle + time#appSyncTime");
    await expect(stamp).toBeVisible();
    await expect(stamp).toHaveText(/^Updated \d{1,2}:\d{2} (AM|PM)$/);
    if (openDrawer) await screen.getByRole("button", "Close Today").tap();
  };
  await app.open("/?actor=dell");

  await expect(browser.locator("#selfAvatar")).toHaveText("D");
  await expect(browser.locator("#appToday")).toBeHidden();
  await app.open("/invoices?actor=dell");
  await expectTodayUpdate();
  if (!(await browser.locator("[data-pref=theme]").isVisible())) await browser.locator("#selfAvatar").tap();
  await expect(screen.getByLabel("Dark mode", { exact: true })).toHaveAttribute("aria-pressed", "true");

  await screen.getByLabel("Dark mode", { exact: true }).tap();
  await expect(browser.locator("html")).toHaveAttribute("data-theme", "light");
  await browser.reload();
  await expect(browser.locator("html")).toHaveAttribute("data-theme", "light");
  await expectTodayUpdate();
});

// Local live mode reads the cookie session; this one is synthetic.
test("W1 a live session signs in as its partner and signs out with its token", async ({ app, browser, screen }) => {
  const signOuts: string[] = [];
  let signedOut = false;
  await browser.route("**/api/system-work/session", (route) =>
    route.fulfill({
      status: signedOut ? 401 : 200,
      json: signedOut ? {} : { actor: { slug: "dell" }, csrf_token: "synthetic-e2e-token" },
    }),
  );
  await browser.route("**/auth/session", (route) =>
    route.fulfill({
      status: signedOut ? 401 : 200,
      json: signedOut ? {} : { actor: { slug: "dell" }, csrf_token: "synthetic-e2e-token" },
    }),
  );
  await browser.route("**/auth/signout", (route) => {
    signOuts.push(route.request.headers["x-carr-csrf"] ?? "");
    signedOut = true;
    return route.fulfill({ status: 302, headers: { location: "/" } });
  });
  await app.open("/?mode=live");

  await expect(browser.locator("#selfAvatar")).toHaveText("D");
  await expect(browser.locator("#selfAvatar")).toHaveAttribute("aria-label", "Dell: account and settings");
  await browser.locator("#selfAvatar").tap();
  await expect(browser.locator("#accountMenu")).toBeVisible();
  await screen.getByText("Sign out", { exact: true }).tap();
  await expect(screen.getByRole("heading", "Session ended")).toBeVisible();
  await expect(screen.getByRole("link", "Sign in again")).toHaveAttribute("href", "/auth/login");
  await expect(browser.locator("#selfAvatar")).toHaveCount(0);
  expect(signOuts).toEqual(["synthetic-e2e-token"]);
});
