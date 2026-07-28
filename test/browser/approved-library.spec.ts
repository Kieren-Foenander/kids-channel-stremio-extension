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
  return page.evaluate(async ({ base }) => {
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch(base.replace(/^\/households/, "/api/households") + path, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      if (!response.ok) throw new Error(await response.text());
    };
    await request("/library", { method: "POST", body: JSON.stringify({ type: "show", imdbId: "tt1234567" }) });
    await request("/library", { method: "POST", body: JSON.stringify({ type: "show", imdbId: "tt1111111" }) });
    await request("/tv-schedule/regenerate", { method: "POST" });

    // Advance past a show's final released episode so its summary becomes Finished.
    const secret = base.split("/").at(-1)!;
    const channel = await fetch(`/addons/${secret}/meta/series/${encodeURIComponent("kids-channels:tv")}.json`).then((response) => response.json()) as {
      meta: { videos: Array<{ id: string }> };
    };
    const finalEpisodeIndex = channel.meta.videos.findIndex((episode, index) => episode.id.endsWith(":1:2") && index < channel.meta.videos.length - 1);
    const finalEpisode = channel.meta.videos[finalEpisodeIndex];
    const nextProgramme = channel.meta.videos[finalEpisodeIndex + 1];
    if (!finalEpisode || !nextProgramme) throw new Error(`Finished-show fixture was not scheduled: ${channel.meta.videos.map((episode) => episode.id).join(", ")}`);
    const finishedImdbId = finalEpisode.id.split(":")[0];
    const advancement = await fetch(`/addons/${secret}/stream/series/${encodeURIComponent(nextProgramme.id)}.json`);
    if (!advancement.ok) throw new Error(await advancement.text());

    await request("/library", { method: "POST", body: JSON.stringify({ type: "movie", imdbId: "tt7654321" }) });
    const library = await fetch(base.replace(/^\/households/, "/api/households") + "/library").then((response) => response.json()) as { programmes: Array<{ id: string; imdbId: string; type: string }> };
    const show = library.programmes.find((programme) => programme.type === "show" && programme.imdbId === finishedImdbId)!;
    await request(`/library/${show.id}`, { method: "PATCH", body: JSON.stringify({ paused: true }) });
    return finishedImdbId;
  }, { base });
}

test("an empty Approved Library links directly to Add Programmes", async ({ page }) => {
  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/approved-library`);

  await expect(page.getByRole("tab", { name: "Shows 0" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "No programmes approved yet" })).toBeVisible();
  await page.locator("#main").getByRole("link", { name: "Add Programmes" }).click();
  await expect(page).toHaveURL(/\/add-programmes$/);
  await expect(page.getByRole("heading", { name: "Search Cinemeta" })).toBeVisible();
  await expect(page.getByLabel("Search Cinemeta for shows and movies")).toBeVisible();
});

test("a Parent manages approved shows and deliberately removes programmes", async ({ page }) => {
  await page.route("https://placehold.co/**", (route) => route.abort());
  const parentUrl = await createHousehold(page);
  const finishedImdbId = await approveExamples(page, parentUrl);

  let libraryRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && /\/api\/households\/[^/]+\/library$/.test(new URL(request.url()).pathname)) libraryRequests++;
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${parentUrl}/approved-library`);
  const showsTab = page.getByRole("tab", { name: "Shows 2" });
  const moviesTab = page.getByRole("tab", { name: "Movies 1" });
  await expect(showsTab).toBeVisible();
  await expect(moviesTab).toBeVisible();
  const finishedTitle = finishedImdbId === "tt1234567" ? "The Example" : "The Example (1990)";
  const show = page.getByRole("article").filter({ has: page.getByRole("heading", { name: finishedTitle, exact: true }) });
  await expect(page.getByRole("article").getByText("Current", { exact: true })).toBeVisible();
  await expect(show.getByText("Paused", { exact: true })).toBeVisible();
  await expect(show.getByText("Finished", { exact: true })).toBeVisible();
  const cardBox = await show.boundingBox();
  const posterBox = await show.locator('[data-slot="library-poster"]').boundingBox();
  const titleBox = await show.getByRole("heading", { name: finishedTitle, exact: true }).boundingBox();
  expect(cardBox).not.toBeNull();
  expect(posterBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(320);
  expect(titleBox!.x).toBeGreaterThanOrEqual(posterBox!.x + posterBox!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(show.getByRole("button", { name: "Resume show" })).toBeVisible();
  await expect(show.getByRole("button", { name: "Restart show" })).toBeVisible();
  await expect(show.getByRole("button", { name: "Remove show" })).toBeVisible();

  await showsTab.focus();
  await showsTab.press("ArrowLeft");
  await expect(moviesTab).toBeFocused();
  await expect(moviesTab).toHaveAttribute("aria-selected", "true");
  await moviesTab.press("ArrowRight");
  await expect(showsTab).toBeFocused();
  await expect(showsTab).toHaveAttribute("aria-selected", "true");

  const requestsAfterLoad = libraryRequests;
  await page.getByLabel("Search shows").fill("does not match");
  await expect(page.getByRole("heading", { name: "No programmes match these filters" })).toBeVisible();
  await expect(show).toBeHidden();
  expect(libraryRequests).toBe(requestsAfterLoad);
  await page.getByLabel("Search shows").fill("Example");
  await page.getByLabel("State", { exact: true }).selectOption("paused");
  await expect(show).toBeVisible();
  await page.getByLabel("State", { exact: true }).selectOption("finished");
  await expect(show).toBeVisible();
  await expect(show.getByText("Finished", { exact: true })).toBeVisible();
  expect(libraryRequests).toBe(requestsAfterLoad);

  let liveMetadataRequests = 0;
  await page.route("**/cinemeta/title/**", (route) => {
    liveMetadataRequests++;
    return route.abort();
  });
  await show.getByRole("button", { name: "Restart show" }).click();
  const progressDialog = page.getByRole("dialog");
  await expect(progressDialog.getByRole("heading", { name: `Restart ${finishedTitle}` })).toBeVisible();
  await expect(progressDialog).toContainText("Current Programme and active playback are not interrupted");
  await expect(progressDialog.getByLabel("Season")).toHaveValue("1");
  await expect(progressDialog.getByLabel("Episode")).toHaveValue(`${finishedImdbId}:1:1`);
  await progressDialog.getByLabel("Episode").selectOption(`${finishedImdbId}:1:2`);
  await progressDialog.getByRole("button", { name: "Restart show" }).click();
  await expect(progressDialog).toBeHidden();
  expect(liveMetadataRequests).toBe(0);
  await expect(page.getByLabel("Stremio restart notice")).toBeVisible();

  await page.getByLabel("State", { exact: true }).selectOption("all");
  await expect(show.getByText(`Show Progress: S01E02`)).toBeVisible();
  await show.getByRole("button", { name: "Resume show" }).click();
  await expect(show.getByRole("button", { name: "Pause show" })).toBeVisible();
  await expect(show.getByText(`Show Progress: S01E02`)).toBeVisible();
  await show.getByRole("button", { name: "Pause show" }).click();
  await expect(show.getByRole("button", { name: "Resume show" })).toBeVisible();
  await expect(show.getByText(`Show Progress: S01E02`)).toBeVisible();
  await expect(page.getByLabel("Stremio restart notice")).toHaveCount(1);

  await show.getByRole("button", { name: "Remove show" }).click();
  const showRemoval = page.getByRole("dialog");
  await expect(showRemoval.getByRole("heading", { name: `Remove ${finishedTitle}?` })).toBeVisible();
  await showRemoval.getByRole("button", { name: "Cancel" }).click();
  await expect(show).toBeVisible();
  await show.getByRole("button", { name: "Remove show" }).click();
  await showRemoval.getByRole("button", { name: "Remove show" }).click();
  await expect(show).toBeHidden();

  await page.getByRole("tab", { name: "Movies 1" }).click();
  const movie = page.getByRole("article").filter({ hasText: "Example: The Movie" });
  await expect(movie.getByText("Current", { exact: true })).toBeVisible();
  await expect(movie.locator('[data-slot="library-poster"]').getByText("Movie", { exact: true })).toBeVisible();

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
