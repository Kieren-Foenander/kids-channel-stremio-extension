import { expect, test, type Browser, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  await expect(page.getByRole("heading", { name: "Save your details, then install" })).toBeVisible();
  return page.url().replace(/\/onboarding$/, "");
}

async function openOlderSession(browser: Browser, parentUrl: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(parentUrl);
  await page.getByLabel("Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Unlock Household" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  return { context, page };
}

test("Settings provides installation details and securely rotates the Parent PIN", async ({ page, context, browser }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8790" });
  const parentUrl = await createHousehold(page);
  const older = await openOlderSession(browser, parentUrl);

  await page.goto(`${parentUrl}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configure a separate stream addon" })).toBeVisible();

  const install = page.getByRole("link", { name: "Install in Stremio" });
  await expect(install).toHaveAttribute("href", /^stremio:\/\//);
  await install.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await expect(page.getByRole("status").filter({ hasText: "cannot verify success" })).toBeVisible();

  const manifestUrl = await page.locator("code").first().textContent();
  await page.getByRole("button", { name: "Copy manifest URL" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Manifest URL copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(manifestUrl);

  await page.getByRole("button", { name: "Copy Parent Page URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(parentUrl);

  await page.getByLabel("Current PIN").fill("12345");
  await page.getByLabel("New six-digit PIN").fill("654321");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.locator("#current-pin-error")).toHaveText("Enter your current six-digit PIN.");

  await page.getByLabel("Current PIN").fill("123456");
  await page.getByLabel("New six-digit PIN").fill("123456");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.locator("#new-pin-error")).toHaveText("Choose a new PIN that differs from the current PIN.");

  await page.route("**/api/households/*/pin", (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({ error: "Too many incorrect PIN attempts. Try again in 15 minutes." }),
  }), { times: 1 });
  await page.getByLabel("New six-digit PIN").fill("654321");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many incorrect PIN attempts" })).toBeVisible();

  await page.getByLabel("Current PIN").fill("000000");
  await page.getByLabel("New six-digit PIN").fill("654321");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Current PIN is incorrect" })).toBeVisible();

  await page.route("**/api/households/*/pin", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  }, { times: 1 });
  await page.getByLabel("Current PIN").fill("123456");
  await page.getByRole("button", { name: "Change Parent PIN" }).click();
  await expect(page.getByRole("button", { name: "Changing PIN…" })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Previous Parent sessions have been signed out" })).toBeVisible();

  await older.page.goto(parentUrl);
  await expect(older.page.getByRole("heading", { name: "Unlock your Household" })).toBeVisible();
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await older.context.close();
});

test("Settings gives phone visitors desktop installation guidance", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/settings`);
  await expect(page.getByText("Complete installation on desktop")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy manifest URL" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
