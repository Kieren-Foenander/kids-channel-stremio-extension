import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page, pin = "123456") {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill(pin);
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

async function unlock(page: Page, pin = "123456") {
  await page.getByLabel("Parent PIN").fill(pin);
  await page.getByRole("button", { name: "Unlock Household" }).click();
}

test("browser and Stremio configure entry points use the hardened SPA shell", async ({ page }) => {
  const rootResponse = await page.goto("/");
  expect(rootResponse?.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(rootResponse?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(rootResponse?.headers()["content-security-policy"]).not.toContain("unsafe-inline");
  expect(rootResponse?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  await expect(page.locator("style")).toHaveCount(0);
  await expect(page.locator('script[src^="/assets/"]')).not.toHaveCount(0);

  const parentUrl = await createHousehold(page);
  const secret = new URL(parentUrl, "http://127.0.0.1:8790").pathname.split("/")[2];
  const configure = await page.request.get(`/addons/${secret}/configure`, { maxRedirects: 0 });
  expect(configure.status()).toBe(302);
  expect(configure.headers().location).toBe(`http://127.0.0.1:8790/households/${secret}`);

  const deepResponse = await page.goto(`${parentUrl}/settings`);
  expect(deepResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#unlock-form")).toHaveCount(0);
});

test("a Parent unlocks with a cookie and keeps access across routes, reloads, and tabs", async ({ page, context }) => {
  const parentUrl = await createHousehold(page);
  await context.clearCookies();
  await page.goto(`${parentUrl}/tv-channel`);
  await expect(page.getByRole("heading", { name: "Unlock your Household" })).toBeVisible();
  await unlock(page);
  await expect(page.getByRole("heading", { name: "TV Channel" })).toBeVisible();

  const session = (await context.cookies()).find((cookie) => cookie.name === "kids_parent_session");
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("kids_parent_session");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${parentUrl}/settings`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const otherTab = await context.newPage();
  await otherTab.goto(`${parentUrl}/movie-channel`);
  await expect(otherTab.getByRole("heading", { name: "Movie Channel" })).toBeVisible();
});

test("expiry preserves the intended route and manual lock clears access", async ({ page, context }) => {
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/approved-library`);
  await expect(page.getByRole("heading", { name: "Approved Library", exact: true })).toBeVisible();

  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Your Parent session expired" })).toBeVisible();
  await unlock(page);
  await expect(page).toHaveURL(`${parentUrl}/approved-library`);
  await expect(page.getByRole("heading", { name: "Approved Library", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Lock Parent Page" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your Household" })).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === "kids_parent_session")).toBeUndefined();
  await page.reload();
  await expect(page.getByRole("button", { name: "Unlock Household" })).toBeVisible();
});

test("a failed manual lock keeps authenticated access and reports the failure", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  await page.goto(parentUrl);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.route("**/api/households/*/lock", async route => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Lock failed." }) });
  });
  await page.getByRole("button", { name: "Lock Parent Page" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "The Parent Page could not be locked. Try again." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.unroute("**/api/households/*/lock");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("narrow navigation is keyboard accessible and theme choice persists", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 320, height: 700 });
  const parentUrl = await createHousehold(page);
  await page.goto(parentUrl);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const menu = page.getByText("Menu", { exact: true });
  await menu.focus();
  await page.keyboard.press("Enter");
  await page.locator(".mobile-menu-panel").getByRole("link", { name: "Add Programmes" }).click();
  await expect(page.getByRole("heading", { name: "Add Programmes" })).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 800 });
  const theme = page.locator(".parent-sidebar").getByLabel("Theme");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.locator(".eyebrow").first().evaluate(element => getComputedStyle(element).color)).toBe("rgb(53, 96, 75)");
  expect(await page.getByRole("button", { name: "Lock Parent Page" }).first().evaluate(element => getComputedStyle(element).color)).toBe("rgb(32, 35, 31)");

  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
