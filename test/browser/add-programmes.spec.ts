import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

test("movie search state, details, pagination, and approval survive navigation", async ({ page }) => {
  await page.route("https://placehold.co/**", (route) => route.abort());
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/add-programmes`);

  let searches = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/cinemeta/search")) searches++;
  });
  const input = page.getByLabel("Search Cinemeta for shows and movies");
  await input.fill("E");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Search must contain between 2 and 100 characters.");
  expect(searches).toBe(0);

  await input.fill("Example");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\?q=Example&type=show&page=1$/);
  await expect(page.getByRole("tab", { name: "Shows 2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Movies 14" })).toBeVisible();
  expect(searches).toBe(1);

  await page.getByRole("tab", { name: "Movies 14" }).click();
  await expect(page).toHaveURL(/\?q=Example&type=movie&page=1$/);
  await expect(page.getByRole("tabpanel").getByRole("article")).toHaveCount(12);
  const movie = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Example: The Movie" }) });
  await expect(movie).not.toContainText("A family film.");

  await movie.getByRole("button", { name: "View details for Example: The Movie" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Example: The Movie" })).toBeVisible();
  await expect(dialog.getByText("A family film.")).toBeVisible();
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\?q=Example&type=movie&page=1$/);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/\?q=Example&type=movie&page=2$/);
  await expect(page.getByRole("tabpanel").getByRole("article")).toHaveCount(2);
  await page.goBack();
  await expect(page).toHaveURL(/\?q=Example&type=movie&page=1$/);
  await expect(page.getByRole("tabpanel").getByRole("article")).toHaveCount(12);

  await movie.getByRole("button", { name: "View details for Example: The Movie" }).click();
  const approvalResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/households\/[^/]+\/library$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Approve movie" }).click();
  expect((await approvalResponse).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("added to the Approved Library.")).toBeVisible();
  await expect(movie.getByText("Already approved")).toBeVisible();
  await movie.getByRole("button", { name: "View details for Example: The Movie" }).click();
  await expect(dialog.getByRole("button", { name: "Already approved" })).toBeDisabled();
});

test("a movie can be approved in one click from the search results", async ({ page }) => {
  await page.route("https://placehold.co/**", (route) => route.abort());
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/add-programmes?q=Example&type=movie&page=1`);

  const movie = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Example: The Movie" }) });
  const approvalResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/households\/[^/]+\/library$/.test(new URL(response.url()).pathname));
  await movie.getByRole("button", { name: "Approve Example: The Movie" }).click();
  expect((await approvalResponse).status()).toBe(201);
  await expect(page.getByText("added to the Approved Library.")).toBeVisible();
  await expect(page.locator("[data-sonner-toaster]")).toHaveCSS("position", "fixed");
  await expect(movie.getByText("Already approved")).toBeVisible();
  await expect(movie.getByRole("button", { name: "Approve Example: The Movie" })).toHaveCount(0);
});

test("a show can be approved from a non-default released episode without losing search context", async ({ page }) => {
  await page.route("https://placehold.co/**", (route) => route.abort());
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/add-programmes?q=Example&type=show&page=1`);

  const show = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "The Example", exact: true }) });
  const metadataResponse = page.waitForResponse((response) => /\/cinemeta\/title\/show\/tt1234567$/.test(new URL(response.url()).pathname));
  await show.getByRole("button", { name: "View details for The Example" }).click();
  expect((await metadataResponse).status()).toBe(200);

  const dialog = page.getByRole("dialog");
  const season = dialog.getByLabel("Season");
  const episode = dialog.getByLabel("Episode");
  await expect(season).toHaveValue("1");
  await expect(episode).toHaveValue("tt1234567:1:1");
  await expect(episode.getByRole("option", { name: "E02 — Second — 8 Jan 2020" })).toBeAttached();
  await expect(episode.getByRole("option", { name: /Special|Unreleased/ })).toHaveCount(0);

  await episode.selectOption("tt1234567:1:2");
  const approvalResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/households\/[^/]+\/library$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Approve show" }).click();
  const approval = await approvalResponse;
  expect(approval.status()).toBe(201);
  expect((await approval.json()).programme.showProgress.id).toBe("tt1234567:1:2");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("added to the Approved Library.")).toBeVisible();
  await expect(page).toHaveURL(/\?q=Example&type=show&page=1$/);
  await expect(show.getByText("Already approved")).toBeVisible();
});

test("a restored URL reruns search and search failures are announced", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/add-programmes?q=Example&type=movie&page=2`);
  await expect(page.getByRole("tab", { name: "Movies 14" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Showing 2 of 14 movies, page 2 of 2")).toBeVisible();
  await expect(page.getByLabel("Search Cinemeta for shows and movies")).toHaveValue("Example");

  await page.getByLabel("Search Cinemeta for shows and movies").fill("failure");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\?q=failure&type=movie&page=1$/);
  await expect(page.getByRole("alert")).toContainText("Cinemeta search is temporarily unavailable");
});
