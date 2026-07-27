import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page, pin: string) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill(pin);
  await page.getByRole("button", { name: "Create Household" }).click();
  await expect(page.getByRole("heading", { name: "Save your details, then install" })).toBeVisible();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  const manifestUrl = await page.locator("code").first().textContent();
  expect(parentUrl).toBeTruthy();
  expect(manifestUrl).toBeTruthy();
  // Lifecycle journeys below deliberately exercise explicit PIN unlock.
  await page.context().clearCookies();
  return { parentUrl: parentUrl!, manifestUrl: manifestUrl! };
}

async function submitUnlock(page: Page, pin: string) {
  await page.getByLabel("Parent PIN").fill(pin);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/unlock"));
  await page.getByRole("button", { name: "Unlock Household" }).click();
  return responsePromise;
}

test("a Parent rotates the PIN, sees recovery limitations, and permanently deletes the Household", async ({ page }) => {
  const household = await createHousehold(page, "123456");
  await page.goto(household.parentUrl);
  await expect(page.getByText("There is no forgotten-PIN or account recovery flow").first()).toBeVisible();
  expect((await submitUnlock(page, "123456")).status()).toBe(200);
  await page.locator(".parent-sidebar").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Parent access" })).toBeVisible();

  await page.getByLabel("Current PIN", { exact: true }).fill("000000");
  await page.getByLabel("New six-digit PIN").fill("654321");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.locator("#pin-status")).toHaveText("Current PIN is incorrect.");

  await page.getByLabel("Current PIN", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.locator("#pin-status")).toContainText("Previous Parent sessions have been signed out");

  await expect(page.getByRole("heading", { name: "Permanently delete Household" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Household…" }).click();
  await expect(page.getByRole("dialog", { name: "Delete Household permanently?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Delete Household permanently?" })).toBeHidden();

  await page.getByRole("button", { name: "Delete Household…" }).click();
  await page.getByLabel("Current six-digit PIN").fill("654321");
  await page.getByLabel("Type DELETE to confirm").fill("delete");
  await page.getByRole("button", { name: "Permanently delete Household" }).click();
  await expect(page.locator("#delete-confirmation-error")).toHaveText("Type DELETE exactly to confirm permanent deletion.");

  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByLabel("Current six-digit PIN").fill("000000");
  await page.getByRole("button", { name: "Permanently delete Household" }).click();
  await expect(page.locator("#delete-current-pin-error")).toHaveText("Current PIN is incorrect.");
  await expect(page.getByRole("dialog", { name: "Delete Household permanently?" })).toBeVisible();

  await page.getByLabel("Current six-digit PIN").fill("654321");
  await page.getByRole("button", { name: "Permanently delete Household" }).click();
  await expect(page.getByRole("heading", { name: "Household deleted" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a new Household" })).toHaveAttribute("href", "/");
  await expect(page.getByRole("navigation", { name: "Parent Page" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(new URL(household.manifestUrl).pathname.split("/")[2]);

  for (const route of [household.parentUrl, household.manifestUrl,
    household.manifestUrl.replace("/manifest.json", "/catalog/series/kids-tv-channel.json")]) {
    const response = await page.request.get(route);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain(new URL(household.manifestUrl).pathname.split("/")[2]);
  }

  await page.goto(household.parentUrl);
  await expect(page.getByRole("heading", { name: "Household not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a new Household" })).toBeVisible();
  await expect(page.getByText(/PIN|Approved Library|Channel Schedule/)).toHaveCount(0);
});

test("browser PIN failures rate-limit only the targeted Household", async ({ page }) => {
  const limitedHousehold = await createHousehold(page, "123456");
  await page.goto(limitedHousehold.parentUrl);
  let limitedResponse;
  for (let attempt = 0; attempt < 5; attempt += 1) limitedResponse = await submitUnlock(page, "000000");
  expect(limitedResponse!.status()).toBe(429);
  expect(limitedResponse!.headers()["retry-after"]).toBe("900");
  await expect(page.locator("#unlock-error")).toContainText("Too many incorrect PIN attempts");
  expect(await limitedResponse!.text()).not.toContain(new URL(limitedHousehold.manifestUrl).pathname.split("/")[2]);

  const otherHousehold = await createHousehold(page, "654321");
  await page.goto(otherHousehold.parentUrl);
  expect((await submitUnlock(page, "654321")).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
