import { expect, test, type Page } from "@playwright/test";

async function createHousehold(page: Page) {
  await page.goto("/");
  await page.getByLabel("Choose a six-digit Parent PIN").fill("123456");
  await page.getByRole("button", { name: "Create Household" }).click();
  const parentUrl = await page.getByRole("link", { name: "Continue to Parent Page" }).getAttribute("href");
  expect(parentUrl).toBeTruthy();
  return parentUrl!;
}

const episode = (number: number) => ({
  id: `tt1234567:1:${number}`,
  season: 1,
  episode: number,
  title: `Episode ${number}`,
  released: "2024-01-01T00:00:00.000Z",
});

function channelState(canUndo = true) {
  const schedule = Array.from({ length: 20 }, (_, index) => ({
    position: index,
    programmeId: `programme-${index % 2}`,
    showTitle: index % 2 ? "Blue Adventures" : "Green Adventures",
    poster: index === 0 ? "https://placehold.co/300x450" : undefined,
    episode: episode(index + 1),
  }));
  return {
    current: schedule[0],
    schedule,
    recentPlayback: Array.from({ length: 8 }, (_, index) => ({
      showTitle: index % 2 ? "Blue Adventures" : "Green Adventures",
      episode: episode(index + 1),
      playedAt: new Date(Date.UTC(2024, 0, 8 - index)).toISOString(),
    })),
    canUndo,
  };
}

test("a Parent inspects and controls the TV Channel with progressive disclosure", async ({ page }) => {
  let state = channelState();
  let stateRequests = 0;
  let undoRequests = 0;
  let regenerationRequests = 0;

  await page.route("**/api/households/*/tv-state", async route => {
    stateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.route("**/api/households/*/tv-schedule/undo", async route => {
    undoRequests += 1;
    state = { ...state, canUndo: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Most recent advancement undone." }) });
  });
  await page.route("**/api/households/*/tv-schedule/regenerate", async route => {
    regenerationRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Upcoming TV selections regenerated." }) });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/tv-channel`);

  await expect(page.getByRole("heading", { name: "TV Channel" })).toBeVisible();
  const current = page.getByRole("heading", { name: "Current Programme" }).locator("..");
  await expect(current).toContainText("Green Adventures");
  await expect(current).toContainText("S01E01 — Episode 1");
  await expect(page.getByRole("list", { name: "Channel Schedule" }).getByRole("listitem")).toHaveCount(20);
  await expect(page.getByRole("list", { name: "Channel Schedule" }).getByRole("listitem").first()).toContainText("Current");

  const history = page.getByRole("list", { name: "Recent playback" });
  await expect(history.getByRole("listitem")).toHaveCount(5);
  const disclosure = page.getByRole("button", { name: "Show all 8" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(history.getByRole("listitem")).toHaveCount(8);
  await page.getByRole("button", { name: "Show fewer" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(5);

  await page.getByRole("button", { name: "Undo latest advancement" }).click();
  await expect.poll(() => undoRequests).toBe(1);
  await expect(page.getByRole("button", { name: "Undo latest advancement" })).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Most recent advancement undone" })).toBeVisible();
  await expect(page.getByLabel("Stremio restart notice")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByLabel("Stremio restart notice")).toBeHidden();

  await page.getByRole("button", { name: "Regenerate schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Regenerate upcoming selections?" });
  await expect(dialog).toContainText("Current Programme and Show Progress remain unchanged");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(regenerationRequests).toBe(0);

  await page.getByRole("button", { name: "Regenerate schedule" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Regenerate selections" }).click();
  await expect.poll(() => regenerationRequests).toBe(1);
  await expect(page.getByLabel("Stremio restart notice")).toBeVisible();
  expect(stateRequests).toBeGreaterThanOrEqual(3); // initial load plus one refresh after each mutation
});

test("a mutation queues a fresh state load behind an overlapping refresh", async ({ page }) => {
  let state = channelState();
  let stateRequests = 0;
  let undoRequests = 0;
  let releaseOverlappingRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const overlappingRefreshStarted = new Promise<void>(resolve => { markRefreshStarted = resolve; });
  const overlappingRefreshReleased = new Promise<void>(resolve => { releaseOverlappingRefresh = resolve; });

  await page.route("**/api/households/*/tv-state", async route => {
    stateRequests += 1;
    if (stateRequests === 2) {
      const staleState = state;
      markRefreshStarted();
      await overlappingRefreshReleased;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(staleState) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.route("**/api/households/*/tv-schedule/undo", async route => {
    undoRequests += 1;
    state = { ...state, canUndo: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Most recent advancement undone." }) });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/tv-channel`);
  const undo = page.getByRole("button", { name: "Undo latest advancement" });
  await expect(undo).toBeVisible();

  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await overlappingRefreshStarted;
  await undo.click();
  await expect.poll(() => undoRequests).toBe(1);

  releaseOverlappingRefresh();
  await expect.poll(() => stateRequests).toBe(3);
  await expect(undo).toBeHidden();
});

test("TV Channel refreshes on focus and polls only while visible", async ({ page }) => {
  await page.clock.install();
  let stateRequests = 0;
  await page.route("**/api/households/*/tv-state", async route => {
    stateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(channelState(false)) });
  });

  const parentUrl = await createHousehold(page);
  await page.goto(`${parentUrl}/tv-channel`);
  await expect(page.getByRole("heading", { name: "Channel Schedule" })).toBeVisible();
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
});
