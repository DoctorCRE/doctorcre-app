import { expect } from '@playwright/test';

async function acceptedRoute(request, fixture) {
  const response = await request.get(`/api/tours/detail?tour_id=${fixture.tour.id}`);
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  const route = data.routes.find(route => route.id === fixture.tour.route_id);
  expect(route?.accepted).toBe(true);
  expect(data.route_version_id).toBe(fixture.tour.route_id);
  expect(route.stops.map(stop => stop.property_id)).toEqual(fixture.tour.property_ids);
  expect(route.stops.map(stop => stop.id)).toEqual(fixture.tour.stop_ids);
  expect(route.stops.map(stop => stop.route_sequence)).toEqual([1, 2]);
  expect(route.stops.map(stop => stop.route_label)).toEqual(['A', 'B']);
  return route;
}

export async function tourDay(page, fixture) {
  const before = await acceptedRoute(page.request, fixture);
  await page.goto(`/tours/day.html?tour=${fixture.tour.id}`);
  const stops = page.locator('#day-stops .day-stop');
  await expect(stops).toHaveCount(2, { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.stopId))).toEqual(fixture.tour.stop_ids);
  await expect(stops.locator('strong')).toHaveText(fixture.tour.property_names);
  await stops.nth(1).click();
  await expect(stops.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#day-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close property', exact: true }).click();
  await expect(page.locator('#day-current')).toContainText(fixture.tour.property_names[1]);
  await page.locator('#day-current .property-open').click();
  await expect(page.locator('#day-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close property', exact: true }).click();
  await expect(page.locator('#day-dialog')).toBeHidden();
  await page.reload();
  await expect(stops.nth(1)).toHaveAttribute('aria-current', 'step', { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.stopId))).toEqual(fixture.tour.stop_ids);
  expect(await acceptedRoute(page.request, fixture)).toEqual(before);
}

export async function itinerary(page, fixture) {
  const before = await acceptedRoute(page.request, fixture);
  await page.goto(`/tours/route-editor.html?tour=${fixture.tour.id}`);
  await expect(page.locator('#tour-name')).toHaveAttribute('title', fixture.tour.name, { timeout: 27000 });
  const stops = page.locator('#route-stops .composer-stop');
  await expect(stops).toHaveCount(2);
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  await page.locator('#route-editing > summary').click();
  await stops.first().locator('[data-field="route_label"]').fill('X');
  await page.locator('#reload-composer').click();
  await expect(page.locator('#composer-state')).toHaveText('Saved route reloaded. Local edits were discarded.');
  await expect(stops.first().locator('[data-field="route_label"]')).toHaveValue('A');
  await expect(stops.last().locator('[data-field="route_label"]')).toHaveValue('B');
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  await page.reload();
  await expect(stops).toHaveCount(2, { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  expect(await acceptedRoute(page.request, fixture)).toEqual(before);
}

export async function parkedDeals(page, deal = page.locator('.card-open').first()) {
  await page.goto('/deals');
  await expect(deal).toBeVisible();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'false');
  const today = page.getByRole('button', { name: 'Today sidebar', exact: true });
  if (await today.getAttribute('aria-expanded') === 'true') await today.click();
  await expect(page.locator('#appToday')).toBeHidden();
  await today.click();
  await expect(page.locator('#appToday')).toBeVisible();
}
