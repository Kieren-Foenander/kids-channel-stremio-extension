import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

async function errorContrastRatio(page: Page) {
  return page.getByRole("alert").evaluate((alert) => {
    const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const [red, green, blue] = channels(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = luminance(getComputedStyle(alert.querySelector("p")!).color);
    const background = luminance(getComputedStyle(alert).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

test("empty Overview explains setup gaps and offers direct next actions at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const parentUrl = await createHousehold(page);
  await page.goto(parentUrl);

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build your Approved Library" })).toBeVisible();
  await expect(page.getByText("Approve a show to start the TV Channel.")).toBeVisible();
  await expect(page.getByText("Approve a movie to start the Movie Channel.")).toBeVisible();
  await expect(page.getByText("Shows").locator("..")).toContainText("0");
  await expect(page.getByText("Movies").locator("..")).toContainText("0");

  const actions = page.getByRole("navigation", { name: "Overview quick actions" });
  const parentPath = new URL(parentUrl).pathname;
  await expect(actions.getByRole("link", { name: "Add Programmes" })).toHaveAttribute("href", `${parentPath}/add-programmes`);
  await expect(actions.getByRole("link", { name: "Approved Library" })).toHaveAttribute("href", `${parentPath}/approved-library`);
  await expect(actions.getByRole("link", { name: "Install in Stremio" })).toHaveAttribute("href", `${parentPath}/settings#installation`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("populated Overview shows compact Current Programmes and immediate TV schedule", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  const apiBase = parentUrl.replace("/households/", "/api/households/");
  const approved = await page.evaluate(async (base) => {
    const request = (body: unknown) => fetch(`${base}/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return Promise.all([
      request({ type: "show", imdbId: "tt1234567" }).then((response) => response.status),
      request({ type: "movie", imdbId: "tt7654321" }).then((response) => response.status),
    ]);
  }, apiBase);
  expect(approved).toEqual([201, 201]);

  await page.goto(parentUrl);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const currents = page.locator('section[aria-labelledby="channels-heading"]');
  await expect(currents).toContainText("The Example");
  await expect(currents).toContainText("S01E01 — First");
  await expect(currents).toContainText("Example: The Movie");
  await expect(page.locator('section[aria-labelledby="next-tv-heading"]')).toContainText("S01E02 — Second");
  await expect(page.getByText("Shows").locator("..")).toContainText("1");
  await expect(page.getByText("Movies").locator("..")).toContainText("1");
  await expect(page.getByRole("heading", { name: "Build your Approved Library" })).toBeHidden();
});

test("Overview keeps its structure while loading and reports API failure accessibly in dark themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const parentUrl = await createHousehold(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/households/*/overview", async (route) => {
    await held;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Summary service is temporarily unavailable." }) });
  });

  await page.goto(parentUrl);
  await expect(page.getByLabel("Loading Household overview")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".skeleton-card")).toHaveCount(2);
  release!();
  await expect(page.getByRole("alert")).toContainText("Summary service is temporarily unavailable.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  expect(await errorContrastRatio(page)).toBeGreaterThanOrEqual(4.5);

  await page.locator(".parent-sidebar").getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await errorContrastRatio(page)).toBeGreaterThanOrEqual(4.5);
});

test("Overview gives concise feedback for a non-JSON API failure", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  await page.route("**/api/households/*/overview", (route) => route.fulfill({
    status: 502,
    contentType: "text/plain",
    body: "Upstream gateway failure",
  }));

  await page.goto(parentUrl);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The Household summary could not be loaded.");
  await expect(alert).not.toContainText(/JSON|Unexpected token|gateway failure/i);
});
