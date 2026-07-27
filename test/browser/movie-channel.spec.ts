import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

const movie = (number: number) => ({
  programmeId: `movie-${number}`,
  imdbId: `tt80000${String(number).padStart(2, "0")}`,
  title: `Movie ${number}`,
  poster: number === 1 ? "https://placehold.co/300x450" : undefined,
  releaseInfo: String(2010 + number),
  position: number - 1,
});

function channelState() {
  return {
    current: movie(1),
    remaining: Array.from({ length: 10 }, (_, index) => movie(index + 2)),
    recentPlayback: Array.from({ length: 8 }, (_, index) => ({
      ...movie(index + 20),
      playedAt: new Date(Date.UTC(2024, 0, 8 - index)).toISOString(),
    })),
  };
}

test("a Parent inspects the Movie Channel and deliberately resets its rotation", async ({ page }) => {
  let state = channelState();
  let stateRequests = 0;
  let resetRequests = 0;
  let releaseReset!: () => void;
  const resetReleased = new Promise<void>(resolve => { releaseReset = resolve; });

  await page.route("**/api/households/*/movie-state", async route => {
    stateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.route("**/api/households/*/movie-rotation/reset", async route => {
    resetRequests += 1;
    await resetReleased;
    state = { ...state, remaining: [...state.remaining].reverse() };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Movie rotation reset without interrupting the Current Programme." }),
    });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/movie-channel`);

  await expect(page.getByRole("heading", { name: "Movie Channel" })).toBeVisible();
  const current = page.getByRole("heading", { name: "Current Programme" }).locator("..");
  await expect(current).toContainText("Movie 1");
  await expect(current).toContainText("2011");

  const rotation = page.getByRole("list", { name: "Remaining rotation" });
  await expect(rotation.getByRole("listitem")).toHaveCount(6);
  const rotationDisclosure = page.getByRole("button", { name: "Show all 10 movies" });
  await expect(rotationDisclosure).toHaveAttribute("aria-expanded", "false");
  await rotationDisclosure.click();
  await expect(rotation.getByRole("listitem")).toHaveCount(10);
  await page.getByRole("button", { name: "Show fewer movies" }).click();
  await expect(rotation.getByRole("listitem")).toHaveCount(6);

  const history = page.getByRole("list", { name: "Recent playback" });
  await expect(history.getByRole("listitem")).toHaveCount(5);
  await page.getByRole("button", { name: "Show all 8", exact: true }).click();
  await expect(history.getByRole("listitem")).toHaveCount(8);
  await page.getByRole("button", { name: "Show fewer", exact: true }).click();
  await expect(history.getByRole("listitem")).toHaveCount(5);

  await page.getByRole("button", { name: "Reset rotation" }).click();
  let dialog = page.getByRole("dialog", { name: "Reset movie rotation?" });
  await expect(dialog).toContainText("Current Programme will not be interrupted");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(resetRequests).toBe(0);
  await expect(rotation.getByRole("listitem").first()).toContainText("Movie 2");

  await page.getByRole("button", { name: "Reset rotation" }).click();
  dialog = page.getByRole("dialog", { name: "Reset movie rotation?" });
  await dialog.getByRole("button", { name: "Reset rotation" }).click();
  await expect.poll(() => resetRequests).toBe(1);
  await expect(dialog.getByRole("button", { name: "Resetting…" })).toBeDisabled();
  await expect(rotation.getByRole("listitem").first()).toContainText("Movie 2");

  releaseReset();
  await expect(dialog).toBeHidden();
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(rotation.getByRole("listitem").first()).toContainText("Movie 11");
  await expect(page.getByRole("status").filter({ hasText: "Movie rotation reset without interrupting" })).toBeVisible();
  await expect(page.getByLabel("Stremio restart notice")).toBeVisible();
  await page.getByLabel("Stremio restart notice").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByLabel("Stremio restart notice")).toBeHidden();
});

test("a failed reset preserves the operational view and remains available to retry", async ({ page }) => {
  let resetRequests = 0;
  await page.route("**/api/households/*/movie-state", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(channelState()),
  }));
  await page.route("**/api/households/*/movie-rotation/reset", route => {
    resetRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Rotation service is unavailable." }) });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/movie-channel`);
  await expect(page.getByRole("heading", { name: "Current Programme" }).locator("..")).toContainText("Movie 1");

  await page.getByRole("button", { name: "Reset rotation" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset movie rotation?" });
  await dialog.getByRole("button", { name: "Reset rotation" }).click();
  await expect.poll(() => resetRequests).toBe(1);
  await expect(dialog).toContainText("Rotation service is unavailable.");
  await expect(dialog.getByRole("button", { name: "Reset rotation" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Current Programme" }).locator("..")).toContainText("Movie 1");
  await expect(page.getByLabel("Stremio restart notice")).toBeHidden();
});

test("Movie Channel refreshes on focus and polls only while visible", async ({ page }) => {
  await page.clock.install();
  let stateRequests = 0;
  await page.route("**/api/households/*/movie-state", async route => {
    stateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(channelState()) });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/movie-channel`);
  await expect(page.getByRole("heading", { name: "Remaining rotation" })).toBeVisible();
  const initialRequests = stateRequests;

  await page.clock.fastForward(30_000);
  await expect.poll(() => stateRequests).toBeGreaterThan(initialRequests);
  const afterVisiblePoll = stateRequests;

  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(50);
  expect(stateRequests).toBe(afterVisiblePoll);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => stateRequests).toBeGreaterThan(afterVisiblePoll);

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  const afterLeavingDestination = stateRequests;
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(50);
  expect(stateRequests).toBe(afterLeavingDestination);
});
