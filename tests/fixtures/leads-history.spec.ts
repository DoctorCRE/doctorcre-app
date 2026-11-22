import { expect, test } from "@playwright/test";
import { routeLeads } from "../../test/leads-browser-fixture.mjs";
import { detail, id, lead, workspace } from "../../test/leads-workspace-fixture.mjs";

test("Load older finishes while the open lead refreshes", async ({ page }) => {
  const row = lead(1);
  const name = "Dr. Example 1";
  let notes = "Synthetic initial lead plans";
  const board = { ...workspace(), leads: [row] };
  const older = {
    id: id(602),
    kind: "email_in",
    occurred_at: "2026-09-29T12:00:00Z",
    summary: "Synthetic older correspondence",
  };
  const cursor = { occurred_at: "2026-09-30T12:00:00Z", id: id(601) };
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  await routeLeads(page, {
    getBoard: () => board,
    getDetail: async (lead, args) => {
      const current = { ...detail(lead), notes };
      if (args.correspondence_cursor) {
        started.resolve();
        await held.promise;
        return {
          ...current,
          correspondence: [older],
          correspondence_page: { total: 3, has_more: false, next_cursor: null },
        };
      }
      return { ...current, correspondence_page: { total: 3, has_more: true, next_cursor: cursor } };
    },
  });

  const time = Date.UTC(2026, 10, 21, 12);
  await page.clock.install({ time });
  await page.clock.pauseAt(time + 1000);
  await page.goto("http://localhost/leads");
  await page.getByRole("button", { name, exact: true }).click();
  const drawer = page.getByRole("dialog", { name });
  const more = drawer.getByRole("button", { name: "Load older correspondence" });
  await expect(drawer.getByText(/Showing 2 of 3 captured entries/)).toBeVisible();
  await page.clock.fastForward(59_000);

  try {
    await more.click();
    await started.promise;
    notes = "Synthetic refreshed lead plans";
    board.leads.push(lead(2));
    await page.clock.fastForward(1_000);
    await expect(page.getByRole("button", { name: "Dr. Example 2", exact: true })).toHaveCount(1);
  } finally {
    held.resolve();
  }

  await expect(drawer.getByText(notes, { exact: true })).toBeVisible();
  await expect(page.locator("#leadBoard")).toHaveAttribute("aria-busy", "false");
  await expect(drawer.locator(".correspondence > li > p").filter({ hasText: older.summary })).toHaveCount(1);
  await expect(drawer.getByText("Showing 3 of 3 captured entries.")).toBeVisible();
  await expect(drawer.locator(".correspondence > li")).toHaveCount(3);
  await expect(more).toHaveCount(0);
});
