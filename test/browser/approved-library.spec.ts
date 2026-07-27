import { expect, test } from "@playwright/test";

interface ChannelMetadata {
  meta: null | { behaviorHints: { defaultVideoId: string } };
}

async function unlockHousehold(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  await expect(page.getByRole("heading", { name: "Save your details, then install" })).toBeVisible();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();

  // This journey covers explicit PIN unlock independently of creation's automatic session.
  await page.context().clearCookies();
  await page.goto(parentUrl!);
  await page.getByLabel("Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Unlock Household" }).click();
  await expect(page.getByRole("heading", { name: "Approved Library" })).toBeVisible();
  await expect(page.getByText("fully close and reopen Stremio")).toBeVisible();
}

// Approved Library UI moves to its focused destination in the follow-up ticket.
test.skip("a Parent searches Cinemeta and approves a movie and a show from another starting episode", async ({ page }) => {
  await unlockHousehold(page);

  const search = async () => {
    await page.getByLabel("Search Cinemeta for shows and movies").fill("Example");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#search-results .programme")).toHaveCount(3);
  };
  await search();

  const movie = page.locator("#search-results .programme").filter({ hasText: "Example: The Movie" });
  await expect(movie).toContainText("2022 · Family · IMDb 7.1");
  await movie.getByRole("button", { name: "Approve movie" }).click();
  await expect(page.locator("#library .programme").filter({ hasText: "Example: The Movie" })).toBeVisible();

  await search();
  const duplicateMovie = page.locator("#search-results .programme").filter({ hasText: "Example: The Movie" });
  await duplicateMovie.getByRole("button", { name: "Approve movie" }).click();
  await expect(duplicateMovie.getByRole("button")).toHaveText(/already in the Approved Library/);
  await expect(page.locator("#library .programme").filter({ hasText: "Example: The Movie" })).toHaveCount(1);

  const show = page.locator("#search-results .programme").filter({ hasText: "The Example2020" });
  await show.getByRole("button", { name: "Choose starting episode" }).click();
  const startingEpisode = show.getByRole("combobox", { name: "Starting episode for The Example" });
  await expect(startingEpisode.locator("option")).toHaveCount(2);
  await expect(startingEpisode.locator("option").first()).toContainText("S01E01 — First");
  await startingEpisode.selectOption("tt1234567:1:2");
  await show.getByRole("button", { name: "Approve show" }).click();

  const approvedShow = page.locator("#library .programme").filter({ hasText: "The Example" });
  await expect(approvedShow).toContainText("Show Progress: S01E02 — Second");

  const manifestUrl = await page.locator("#manifest").textContent();
  expect(manifestUrl).toBeTruthy();
  const addonBase = manifestUrl!.replace(/\/manifest\.json$/, "");
  const channelMetadata = () => page.evaluate(async (base) => {
    const [tv, movie] = await Promise.all([
      fetch(base + "/meta/series/" + encodeURIComponent("kids-channels:tv") + ".json").then(async (response) => await response.json() as ChannelMetadata),
      fetch(base + "/meta/movie/" + encodeURIComponent("kids-channels:movie") + ".json").then(async (response) => await response.json() as ChannelMetadata),
    ]);
    return { tv, movie };
  }, addonBase);

  const active = await channelMetadata();
  expect(active.tv.meta?.behaviorHints.defaultVideoId).toBe("tt1234567:1:2");
  expect(active.movie.meta?.behaviorHints.defaultVideoId).toBe("tt7654321");
  await expect(page.locator("#movie-current")).toHaveText("Example: The Movie");
  await expect(page.locator("#movie-rotation")).toHaveText("No movies remaining.");

  await page.evaluate(async (base) => {
    const metadata = await fetch(base + "/meta/movie/" + encodeURIComponent("kids-channels:movie") + ".json").then(response => response.json()) as any;
    await fetch(metadata.meta.videos[1].streams[0].url);
    await (globalThis as unknown as { loadMovieState(): Promise<void> }).loadMovieState();
  }, addonBase);
  await expect(page.locator("#movie-history")).toContainText("Example: The Movie");
  await page.getByRole("button", { name: "Reset movie rotation" }).click();
  await expect(page.locator("#movie-status")).toContainText("without interrupting the Current Programme");

  await approvedShow.getByRole("button", { name: "Pause show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show paused");
  expect((await channelMetadata()).tv.meta).toBeNull();
  const pausedShow = page.locator("#library .programme").filter({ hasText: "The Example" });
  await pausedShow.getByRole("button", { name: "Resume show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show resumed");
  expect((await channelMetadata()).tv.meta?.behaviorHints.defaultVideoId).toBe("tt1234567:1:2");

  await page.getByRole("button", { name: "Regenerate upcoming TV selections" }).click();
  await expect(page.locator("#library-status")).toContainText("without changing the Current Programme or Show Progress");
  await expect(page.locator("#library-status")).toContainText("Restart Stremio");
  expect((await channelMetadata()).tv.meta?.behaviorHints.defaultVideoId).toBe("tt1234567:1:2");
  await expect(page.locator("#tv-current")).toContainText("The Example — S01E02 — Second");
  await expect(page.locator("#tv-schedule li").first()).toContainText("The Example — S01E02 — Second");

  const progressShow = page.locator("#library .programme").filter({ hasText: "The Example" });
  await progressShow.getByRole("combobox", { name: "Next episode for The Example" }).selectOption("tt1234567:1:1");
  await progressShow.getByRole("button", { name: "Set Show Progress" }).click();
  await expect(page.locator("#library-status")).toContainText("incompatible future selections repaired");
  await expect(page.locator("#tv-current")).toContainText("S01E02 — Second");
  await expect(page.locator("#tv-schedule li").nth(1)).toContainText("S01E01 — First");

  await page.evaluate(async (base) => {
    await fetch(base + "/stream/series/" + encodeURIComponent("tt1234567:1:1") + ".json");
    await (globalThis as unknown as { loadTvState(): Promise<void> }).loadTvState();
  }, addonBase);
  await expect(page.locator("#tv-history")).toContainText("S01E02 — Second");
  await page.getByRole("button", { name: "Undo most recent advancement" }).click();
  await expect(page.locator("#tv-status")).toContainText("Most recent advancement undone");
  await expect(page.locator("#tv-current")).toContainText("S01E02 — Second");

  await page.locator("#library .programme").filter({ hasText: "The Example" })
    .getByRole("button", { name: "Remove show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show removed");
  expect((await channelMetadata()).tv.meta).toBeNull();

  await page.locator("#library .programme").filter({ hasText: "Example: The Movie" })
    .getByRole("button", { name: "Remove movie" }).click();
  await expect(page.locator("#library-status")).toContainText("Movie removed");
  expect((await channelMetadata()).movie.meta).toBeNull();
});
