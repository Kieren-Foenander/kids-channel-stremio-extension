import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

async function approveExamples(page: Page, parentUrl: string) {
  const base = new URL(parentUrl).pathname.replace(/\/$/, "");
  await page.evaluate(async ({ base }) => {
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch(base.replace(/^\/households/, "/api/households") + path, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      if (!response.ok) throw new Error(await response.text());
    };
    await request("/library", { method: "POST", body: JSON.stringify({ type: "show", imdbId: "tt1234567" }) });
    await request("/library", { method: "POST", body: JSON.stringify({ type: "movie", imdbId: "tt7654321" }) });
    const library = await fetch(base.replace(/^\/households/, "/api/households") + "/library").then((response) => response.json()) as { programmes: Array<{ id: string; type: string }> };
    const show = library.programmes.find((programme) => programme.type === "show")!;
    await request(`/library/${show.id}`, { method: "PATCH", body: JSON.stringify({ paused: true }) });
  }, { base });
}

test("an empty Approved Library links directly to Add Programmes", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/approved-library`);

  await expect(page.getByRole("tab", { name: "Shows 0" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "No programmes approved yet" })).toBeVisible();
  await page.locator("#main").getByRole("link", { name: "Add Programmes" }).click();
  await expect(page).toHaveURL(/\/add-programmes$/);
});

test("a Parent filters summary cards and cancels or confirms named movie removal", async ({ page }) => {
  await page.route("https://placehold.co/**", (route) => route.abort());
  const parentUrl = await createHousehold(page);
  await approveExamples(page, parentUrl);

  let libraryRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && /\/api\/households\/[^/]+\/library$/.test(new URL(request.url()).pathname)) libraryRequests++;
  });
  await page.goto(`${parentUrl}/approved-library`);
  await expect(page.getByRole("tab", { name: "Shows 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Movies 1" })).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "The Example" }).getByText("Paused", { exact: true })).toBeVisible();

  const requestsAfterLoad = libraryRequests;
  await page.getByLabel("Search shows").fill("does not match");
  await expect(page.getByRole("heading", { name: "No programmes match these filters" })).toBeVisible();
  expect(libraryRequests).toBe(requestsAfterLoad);
  await page.getByLabel("Search shows").fill("Example");
  await page.getByLabel("State", { exact: true }).selectOption("paused");
  await expect(page.getByRole("article").filter({ hasText: "The Example" })).toBeVisible();
  expect(libraryRequests).toBe(requestsAfterLoad);

  await page.getByRole("tab", { name: "Movies 1" }).click();
  const movie = page.getByRole("article").filter({ hasText: "Example: The Movie" });
  await expect(movie.getByText("Current", { exact: true })).toBeVisible();
  await expect(movie.locator(".library-poster").getByText("Movie", { exact: true })).toBeVisible();

  await movie.getByRole("button", { name: "Remove movie" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Remove Example: The Movie?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(movie).toBeVisible();

  await movie.getByRole("button", { name: "Remove movie" }).click();
  await dialog.getByRole("button", { name: "Remove movie" }).click();
  await expect(page.getByRole("heading", { name: "No programmes approved yet" })).toBeVisible();
  await expect(page.getByLabel("Stremio restart notice")).toBeVisible();
});
