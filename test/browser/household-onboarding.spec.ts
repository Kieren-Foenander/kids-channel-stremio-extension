import { expect, test } from "@playwright/test";

test("a Parent creates a Household and saves truthful onboarding details", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8790" });
  await page.goto("/");

  await page.getByLabel("Choose a six-digit Parent PIN").fill("12345");
  await page.getByRole("button", { name: "Create Household" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter exactly six digits.");

  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/households") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Household" }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  expect(await response.json()).not.toHaveProperty("parentToken");
  const parentSession = (await context.cookies()).find((cookie) => cookie.name === "kids_parent_session");
  expect(parentSession).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("kids_parent_session");

  await expect(page).toHaveURL(/\/households\/[A-Za-z0-9_-]+\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Save your details, then install" })).toBeVisible();
  await expect(page.getByText("Neither your six-digit PIN nor your private Household URL can be recovered")).toBeVisible();
  await expect(page.getByText("Parent session confirmed for one hour.")).toBeVisible();

  const install = page.getByRole("link", { name: "Install in Stremio" });
  await expect(install).toHaveAttribute("href", /^stremio:\/\//);
  await install.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await expect(page.getByRole("status").last()).toContainText("this page cannot verify success");

  const manifest = await page.locator("code").first().textContent();
  await page.getByRole("button", { name: "Copy manifest URL" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Manifest URL copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(manifest);

  const parentUrl = await page.locator("code").nth(1).textContent();
  await page.getByRole("button", { name: "Copy Parent Page URL" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Private Parent Page URL copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(parentUrl);

  await page.getByRole("link", { name: "Continue to Parent Page" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlock Household" })).toBeHidden();
});

test("onboarding remains usable at 320px and directs phone installation to desktop", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("654321");
  await page.getByRole("button", { name: "Create Household" }).click();

  await expect(page.getByText("Complete installation on desktop")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy manifest URL" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
