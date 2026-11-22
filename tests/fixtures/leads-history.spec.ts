import { expect, type Page, test } from "@playwright/test";
import { routeLeads } from "../../test/leads-browser-fixture.mjs";
import { detail, id, lead, workspace } from "../../test/leads-workspace-fixture.mjs";

const name = "Dr. Example 1";
const correspondence = [0, 1, 2, 3, 4].map((index) => ({
  id: id(700 + index),
  kind: "email_in",
  occurred_at: new Date(Date.UTC(2026, 9, 7 - index)).toISOString(),
  summary: `Synthetic correspondence ${index}`,
}));

function detailPage(row: Parameters<typeof detail>[0], notes: string, from: number, cursor: unknown, pageSize = 2) {
  const rows = correspondence.slice(from);
  const start =
    rows.findIndex((entry) => cursor && typeof cursor === "object" && "id" in cursor && entry.id === cursor.id) + 1;
  const page = rows.slice(start, start + pageSize);
  const tail = page.at(-1);
  const has_more = start + page.length < rows.length;
  return {
    ...detail(row),
    notes,
    correspondence: page,
    correspondence_page: {
      total: rows.length,
      has_more,
      next_cursor: has_more && tail ? { id: tail.id, occurred_at: tail.occurred_at } : null,
    },
  };
}

async function openLead(page: Page) {
  const time = Date.UTC(2026, 10, 21, 12);
  await page.clock.install({ time });
  await page.clock.pauseAt(time + 1000);
  await page.goto("http://localhost/leads");
  await page.getByRole("button", { name, exact: true }).click();
  const drawer = page.getByRole("dialog", { name });
  await expect(drawer.getByText(/Showing 2 of 4 captured entries/)).toBeVisible();
  return { drawer, more: drawer.getByRole("button", { name: "Load older correspondence" }) };
}

test("refresh keeps the older rows when new correspondence shifts the pages", async ({ page }) => {
  const board = { ...workspace(), leads: [lead(1)] };
  let notes = "Synthetic initial lead plans";
  let from = 1;
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await routeLeads(page, {
    getBoard: () => board,
    getDetail: async (row, args) => {
      const result = detailPage(row, notes, from, args.correspondence_cursor);
      if (args.correspondence_cursor) {
        requested.resolve();
        await release.promise;
      }
      return result;
    },
  });

  const { drawer, more } = await openLead(page);
  await page.clock.fastForward(59_000);

  try {
    await more.click();
    await requested.promise;
    from = 0;
    notes = "Synthetic refreshed lead plans";
    board.leads.push(lead(2));
    await page.clock.fastForward(1_000);
    await expect(page.getByRole("button", { name: "Dr. Example 2", exact: true })).toHaveCount(1);
  } finally {
    release.resolve();
  }

  await expect(drawer.getByText(notes, { exact: true })).toBeVisible();
  await expect(page.locator("#leadBoard")).toHaveAttribute("aria-busy", "false");
  await expect(drawer.locator(".correspondence > li > p")).toHaveText(correspondence.map((entry) => entry.summary));
  await expect(drawer.getByText("Showing 5 of 5 captured entries.")).toBeVisible();
  await expect(more).toHaveCount(0);
});

for (const fullHistory of [false, true]) {
  const outcome = fullHistory ? "clears Retry after recovering all rows" : "keeps Retry when more rows remain";
  test(`a refresh after failed Load older ${outcome}`, async ({ page }) => {
    const board = { ...workspace(), leads: [lead(1)] };
    const freshNotes = "Synthetic refreshed lead plans";
    let refreshing = false;
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await routeLeads(page, {
      getBoard: () => board,
      getDetail: async (row, args) => {
        if (args.correspondence_cursor) {
          return { ...detailPage(row, freshNotes, 1, args.correspondence_cursor), correspondence_page: null };
        }
        if (!refreshing) return detailPage(row, "Synthetic initial lead plans", 1, null);
        requested.resolve();
        await release.promise;
        return detailPage(row, freshNotes, 1, null, fullHistory ? 4 : 2);
      },
    });

    const { drawer, more } = await openLead(page);
    const unavailable = drawer.getByText("Older entries unavailable. Try again.");
    refreshing = true;
    try {
      await page.clock.fastForward(60_000);
      await requested.promise;
      await more.click();
      await expect(unavailable).toBeVisible();
    } finally {
      release.resolve();
    }

    await expect(page.locator("#leadBoard")).toHaveAttribute("aria-busy", "false");
    await expect(drawer.getByText(freshNotes, { exact: true })).toBeVisible();
    if (fullHistory) {
      await expect(drawer.getByText("Showing 4 of 4 captured entries.")).toBeVisible();
      await expect(more).toHaveCount(0);
      await expect(unavailable).toHaveCount(0);
    } else {
      await expect(drawer.getByText(/Showing 2 of 4 captured entries/)).toBeVisible();
      await expect(unavailable).toBeVisible();
      await expect(more).toBeEnabled();
    }
  });
}
