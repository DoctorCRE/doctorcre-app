import { expect } from "@playwright/test";
import { z } from "zod";
import { journeyTest as test } from "./journey-fixture.ts";

const stops = z.object({ stops: z.array(z.object({ property_id: z.uuid() })) });

test("Deals opens the saved tour plan and shows its stop", async ({ page, rehearsal }) => {
  test.setTimeout(180_000);
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), (dismiss) =>
    dismiss.click(),
  );
  await page.goto(`/deals?deal=${rehearsal.deal_id}`);
  await expect(page.locator("#panelTitle")).toHaveText(rehearsal.deal_name);
  await page.getByRole("tab", { name: "Tours", exact: true }).click();
  const [plan] = await Promise.all([
    page.waitForResponse(`**/api/engine/deals/${rehearsal.deal_id}/tours/${rehearsal.tour_id}`),
    page.locator(".tour-plan > summary").click(),
  ]);
  expect(plan.ok()).toBe(true);
  expect(stops.parse(await plan.json()).stops.map((stop) => stop.property_id)).toEqual([rehearsal.property_id]);
  await expect(page.getByRole("list", { name: "Tour stops" }).getByRole("listitem")).toContainText("1 Example Way");
});
