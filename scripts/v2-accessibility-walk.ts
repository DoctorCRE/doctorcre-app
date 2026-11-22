import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import { inspectPhoneAccessibility } from "./phone-accessibility.ts";

export async function walkV2Accessibility(page: Page, origin: string, capture: (name: string) => Promise<void>) {
  const results: ({ name: string } & Awaited<ReturnType<typeof inspectPhoneAccessibility>>)[] = [];
  const inspect = async (name: string, frame?: Frame) => {
    await page.evaluate(() => document.fonts.ready);
    const result = { name, ...(await inspectPhoneAccessibility(page, frame)) };
    if (page.viewportSize()?.width === 390) {
      const failures = (row: Awaited<ReturnType<typeof inspectPhoneAccessibility>>) => ({
        small: [...row.small].sort((a, b) => a.selector.localeCompare(b.selector)),
        covered: [...row.covered].sort((a, b) => a.selector.localeCompare(b.selector)),
      });
      const repeated = await inspectPhoneAccessibility(page, frame);
      const reversed = await inspectPhoneAccessibility(page, frame, true);
      assert.deepEqual(failures(repeated), failures(result), `${name}: repeat inspection preserves results`);
      assert.deepEqual(failures(reversed), failures(result), `${name}: reverse inspection preserves results`);
    }
    await capture(name);
    results.push(result);
  };
  for (const [name, path, ready] of [
    ["Home", "/", ".inbox-row"],
    ["Deals board", "/deals", ".kanban-card .card-open:visible"],
    ["Tours library", "/tours", ".tour-button"],
    ["Vendors Research", "/vendors", "#recordList > li"],
    ["Relationships", "/relationships", "#networkRefresh"],
    ["Leads", "/leads", ".lead-card"],
  ] satisfies [string, string, string][]) {
    await page.goto(new URL(path, origin).href);
    await page.locator(ready).first().waitFor({ state: "visible", timeout: 10000 });
    if (name === "Vendors Research") {
      const region = page.getByRole("region", { name: "People worth meeting" });
      const details = page.locator(".vendor-meetings");
      if (!(await details.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
        await details.locator(":scope > summary").click();
      await region.getByRole("searchbox", { name: "Search people and offices" }).waitFor();
      await region.getByText("Loading people…", { exact: true }).waitFor({ state: "hidden" });
      const sentinel = page.locator("#scrollSentinel");
      for (let loaded = 0; loaded < 20; loaded++) {
        const count = await sentinel.evaluate((node) => {
          if (node.hasAttribute("hidden")) return null;
          const count = document.querySelectorAll("#recordList > li").length;
          // Automatic pagination can hide the marker while Playwright waits for it to settle.
          node.scrollIntoView({ block: "end", behavior: "instant" });
          return count;
        });
        if (count === null) break;
        await page.waitForFunction(
          (count) =>
            document.querySelector("#scrollSentinel")?.hasAttribute("hidden") ||
            document.querySelectorAll("#recordList > li").length > count,
          count,
        );
      }
      if ((await sentinel.getAttribute("hidden")) === null)
        throw Error("Vendor target discovery incomplete after 20 pages");
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    }
    await inspect(name);
    if (name === "Deals board") {
      await page.locator(".kanban-card .card-open:visible").first().click();
      await page.locator("#detailUpdateForm").waitFor({ state: "visible" });
      await inspect("Deal");
    }
    if (name === "Tours library") {
      const href = await page.locator(".tour-button").first().getAttribute("href");
      let frame = page.mainFrame();
      if (href?.startsWith("/deals?")) {
        await page.goto(new URL(href, origin).href);
        const editor = page.locator('iframe[title="Tour shortlist, route and packet"]');
        await editor.waitFor({ state: "visible" });
        const element = await editor.elementHandle();
        const embedded = await element?.contentFrame();
        if (!embedded) throw Error("Tour editor frame unavailable");
        frame = embedded;
      } else {
        await page.goto(new URL("/tours/route-editor.html", origin).href);
        await page.locator(".tour-button").first().click();
      }
      await frame.locator("#tour-panel").waitFor({ state: "visible", timeout: 10000 });
      const sheet = frame.locator("#internal-cheat-sheet");
      if (!(await sheet.evaluate((node) => node instanceof HTMLDetailsElement && node.open)))
        await sheet.locator(":scope > summary").click();
      await frame.locator("#cheat-content").waitFor({ state: "visible" });
      await inspect("Tour and cheat sheet", frame);
    }
  }
  return results;
}
