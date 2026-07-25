import { expect, test } from "@playwright/test";

interface ChannelMetadata {
  meta: null | { behaviorHints: { defaultVideoId: string } };
}

async function unlockHousehold(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Open Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();

  await page.goto(parentUrl!);
  await page.getByLabel("Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Unlock Household" }).click();
  await expect(page.getByRole("heading", { name: "Approved Library" })).toBeVisible();
}

test("a Parent searches Cinemeta and approves a movie and a show from another starting episode", async ({ page }) => {
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
  await expect(approvedShow).toContainText("Starts at S01E02 — Second");

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

  await approvedShow.getByRole("button", { name: "Pause show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show paused");
  expect((await channelMetadata()).tv.meta).toBeNull();
  const pausedShow = page.locator("#library .programme").filter({ hasText: "The Example" });
  await pausedShow.getByRole("button", { name: "Resume show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show resumed");
  expect((await channelMetadata()).tv.meta?.behaviorHints.defaultVideoId).toBe("tt1234567:1:2");

  await page.getByRole("button", { name: "Regenerate upcoming TV selections" }).click();
  await expect(page.locator("#library-status")).toContainText("without changing the Current Programme or Show Progress");
  expect((await channelMetadata()).tv.meta?.behaviorHints.defaultVideoId).toBe("tt1234567:1:2");

  await page.locator("#library .programme").filter({ hasText: "The Example" })
    .getByRole("button", { name: "Remove show" }).click();
  await expect(page.locator("#library-status")).toContainText("Show removed");
  expect((await channelMetadata()).tv.meta).toBeNull();

  await page.locator("#library .programme").filter({ hasText: "Example: The Movie" })
    .getByRole("button", { name: "Remove movie" }).click();
  await expect(page.locator("#library-status")).toContainText("Movie removed");
  expect((await channelMetadata()).movie.meta).toBeNull();
});
