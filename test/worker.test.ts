import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CreatedHousehold {
  householdId: string;
  manifestUrl: string;
  installUrl: string;
  parentUrl: string;
}

beforeEach(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY NOT NULL,
    secret TEXT UNIQUE NOT NULL,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS approved_programmes (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, imdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, poster TEXT, background TEXT,
    release_info TEXT, genres_json TEXT NOT NULL DEFAULT '[]', imdb_rating TEXT, approved_at TEXT NOT NULL,
    UNIQUE (household_id, content_type, imdb_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS show_episodes (
    programme_id TEXT NOT NULL, video_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
    title TEXT NOT NULL, released_at TEXT NOT NULL, overview TEXT,
    PRIMARY KEY (programme_id, video_id), UNIQUE (programme_id, season, episode)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS show_progress (
    programme_id TEXT PRIMARY KEY NOT NULL, next_video_id TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS current_programmes (
    household_id TEXT NOT NULL, channel TEXT NOT NULL, programme_id TEXT NOT NULL,
    video_id TEXT NOT NULL, selected_at TEXT NOT NULL, PRIMARY KEY (household_id, channel)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_state (
    household_id TEXT NOT NULL, channel TEXT NOT NULL, current_position INTEGER NOT NULL,
    selection_seed TEXT NOT NULL, initialized_at TEXT NOT NULL, PRIMARY KEY (household_id, channel)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_schedule (
    household_id TEXT NOT NULL, channel TEXT NOT NULL, position INTEGER NOT NULL,
    programme_id TEXT NOT NULL, video_id TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    PRIMARY KEY (household_id, channel, position)
  )`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS channel_schedule_video_idx
    ON channel_schedule (household_id, channel, video_id)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_advancements (
    household_id TEXT NOT NULL, channel TEXT NOT NULL, from_position INTEGER NOT NULL,
    target_position INTEGER NOT NULL, owner_token TEXT NOT NULL, advanced_at TEXT NOT NULL,
    PRIMARY KEY (household_id, channel, from_position)
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS households_secret_idx ON households (secret)").run();
  await env.DB.prepare("DELETE FROM channel_advancements").run();
  await env.DB.prepare("DELETE FROM channel_schedule").run();
  await env.DB.prepare("DELETE FROM channel_state").run();
  await env.DB.prepare("DELETE FROM current_programmes").run();
  await env.DB.prepare("DELETE FROM show_progress").run();
  await env.DB.prepare("DELETE FROM show_episodes").run();
  await env.DB.prepare("DELETE FROM approved_programmes").run();
  await env.DB.prepare("DELETE FROM households").run();
  vi.restoreAllMocks();
});

async function create(pin = "123456"): Promise<CreatedHousehold> {
  const response = await SELF.fetch("https://kids.test/api/households", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  expect(response.status).toBe(201);
  return response.json<CreatedHousehold>();
}

function secretFrom(created: CreatedHousehold): string {
  return new URL(created.manifestUrl).pathname.split("/")[2];
}

describe("Parent Page Household creation", () => {
  it("serves a minimal creation page and rejects any PIN other than six digits", async () => {
    const page = await SELF.fetch("https://kids.test/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("There is no forgotten-PIN recovery");

    for (const pin of ["12345", "1234567", "abcdef", 123456]) {
      const response = await SELF.fetch("https://kids.test/api/households", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("creates an isolated Household with an opaque high-entropy secret and hashed PIN", async () => {
    const first = await create();
    const second = await create("654321");
    const firstSecret = secretFrom(first);
    const secondSecret = secretFrom(second);

    expect(firstSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstSecret).not.toBe(secondSecret);
    expect(first.manifestUrl).not.toContain("123456");
    expect(first.installUrl).toBe(`stremio://kids.test/addons/${firstSecret}/manifest.json`);

    const stored = await env.DB.prepare("SELECT pin_hash, pin_salt FROM households WHERE id = ?")
      .bind(first.householdId)
      .first<{ pin_hash: string; pin_salt: string }>();
    expect(stored?.pin_hash).not.toContain("123456");
    expect(stored?.pin_hash.length).toBeGreaterThan(30);
    expect(stored?.pin_salt.length).toBeGreaterThan(20);
  });

  it("protects the existing Household Parent Page with its PIN", async () => {
    const created = await create();
    const secret = secretFrom(created);

    const parentPage = await SELF.fetch(created.parentUrl);
    expect(parentPage.status).toBe(200);
    const parentHtml = await parentPage.text();
    expect(parentHtml).toContain("Enter your six-digit PIN");
    expect(parentHtml).toContain("Stremio resolves streams on your device");

    const denied = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "000000" }),
    });
    expect(denied.status).toBe(401);

    const unlocked = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
    expect(unlocked.status).toBe(200);
    expect(await unlocked.json()).toMatchObject({ manifestUrl: created.manifestUrl });
  });
});

describe("Cinemeta Approved Library", () => {
  const showMeta = {
    id: "tt1234567", imdb_id: "tt1234567", type: "series", name: "The Example",
    description: "A recognisable family show.", poster: "https://images.example/show.jpg",
    background: "https://images.example/show-background.jpg", releaseInfo: "2020–", genres: ["Family", "Animation"], imdbRating: "8.4",
    videos: [
      { id: "tt1234567:0:1", season: 0, episode: 1, title: "Special", released: "2019-12-01T00:00:00.000Z" },
      { id: "tt1234567:1:1", season: 1, episode: 1, title: "First", released: "2020-01-01T00:00:00.000Z" },
      { id: "tt1234567:1:2", season: 1, episode: 2, title: "Second", released: "2020-01-08T00:00:00.000Z" },
      { id: "tt1234567:1:3", season: 1, episode: 3, title: "Unreleased", released: "2999-01-01T00:00:00.000Z" },
    ],
  };
  const movieMeta = {
    id: "tt7654321", imdb_id: "tt7654321", type: "movie", name: "Example: The Movie",
    description: "A family film.", poster: "https://images.example/movie.jpg", releaseInfo: "2022", genres: ["Family"], imdbRating: "7.1",
  };

  function mockCinemeta() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.startsWith("/catalog/series/top/search=")) return Response.json({ metas: [showMeta, { ...showMeta, id: "tt1111111", imdb_id: "tt1111111", name: "The Example (1990)", releaseInfo: "1990" }] });
      if (path.startsWith("/catalog/movie/top/search=")) return Response.json({ metas: [movieMeta] });
      if (path === "/meta/series/tt1234567.json") return Response.json({ meta: showMeta });
      if (path === "/meta/movie/tt7654321.json") return Response.json({ meta: movieMeta });
      return Response.json({}, { status: 404 });
    });
  }

  async function parentAccess(created: CreatedHousehold) {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const { parentToken } = await response.json<{ parentToken: string }>();
    return { authorization: `Bearer ${parentToken}` };
  }

  it("searches shows and movies with distinguishing metadata and artwork", async () => {
    const created = await create();
    const denied = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/cinemeta/search?q=Example`);
    expect(denied.status).toBe(401);

    mockCinemeta();
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/cinemeta/search?q=Example`, { headers: await parentAccess(created) });
    const body = await response.json<any>();
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(3);
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tt1234567", type: "show", title: "The Example", poster: "https://images.example/show.jpg", releaseInfo: "2020–", genres: ["Family", "Animation"] }),
      expect.objectContaining({ id: "tt7654321", type: "movie", title: "Example: The Movie", description: "A family film." }),
    ]));
  });

  it("approves a show with regular released episodes and defaults Show Progress to S01E01", async () => {
    const created = await create(); const headers = await parentAccess(created); mockCinemeta();
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "show", imdbId: "tt1234567" }),
    });
    const approved = await response.json<any>();
    expect(response.status).toBe(201);
    expect(approved.programme).toMatchObject({ imdbId: "tt1234567", type: "show", showProgress: { id: "tt1234567:1:1", season: 1, episode: 1 } });

    const library = await (await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, { headers })).json<any>();
    expect(library.programmes).toHaveLength(1);
    expect(library.programmes[0].episodes.map((episode: any) => episode.id)).toEqual(["tt1234567:1:1", "tt1234567:1:2"]);
    expect(library.programmes[0].showProgress.id).toBe("tt1234567:1:1");
  });

  it("accepts another valid starting episode and rejects specials, unreleased, and unknown episodes", async () => {
    mockCinemeta();
    const choices = ["tt1234567:0:1", "tt1234567:1:3", "tt1234567:9:9"];
    for (const startingEpisodeId of choices) {
      const created = await create(); const headers = await parentAccess(created);
      const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ type: "show", imdbId: "tt1234567", startingEpisodeId }),
      });
      expect(response.status).toBe(400);
    }

    const created = await create(); const headers = await parentAccess(created);
    const accepted = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "show", imdbId: "tt1234567", startingEpisodeId: "tt1234567:1:2" }),
    });
    expect(await accepted.json<any>()).toMatchObject({ programme: { showProgress: { id: "tt1234567:1:2" } } });
  });

  it("approves a movie once and reports a duplicate without another Cinemeta request", async () => {
    const created = await create(); const headers = await parentAccess(created); mockCinemeta();
    const request = () => SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ type: "movie", imdbId: "tt7654321" }),
    });
    expect((await request()).status).toBe(201);
    const duplicate = await request();
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: expect.stringContaining("already") });
    const library = await (await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, { headers })).json<any>();
    expect(library.programmes).toHaveLength(1);
    expect(library.programmes[0]).toMatchObject({ imdbId: "tt7654321", type: "movie" });
  });
});

describe("TV Channel client-side stream resolution", () => {
  const canonicalEpisodeId = "tt2468101:1:1";
  const showMeta = {
    id: "tt2468101", imdb_id: "tt2468101", type: "series", name: "Playback Show",
    description: "The approved family show.", poster: "https://images.example/playback.jpg",
    videos: [
      { id: canonicalEpisodeId, season: 1, episode: 1, title: "Beginning", released: "2020-01-01T00:00:00.000Z" },
      { id: "tt2468101:1:2", season: 1, episode: 2, title: "Later", released: "2020-01-08T00:00:00.000Z" },
    ],
  };

  async function arrangePlayback() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(new URL(input instanceof Request ? input.url : input.toString()).pathname);
      if (path === "/meta/series/tt2468101.json") return Response.json({ meta: showMeta });
      throw new Error(`unexpected outbound request: ${path}`);
    });

    const created = await create();
    const secret = secretFrom(created);
    const unlocked = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const { parentToken } = await unlocked.json<{ parentToken: string }>();
    const approved = await SELF.fetch(`https://kids.test/api/households/${secret}/library`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${parentToken}` },
      body: JSON.stringify({ type: "show", imdbId: "tt2468101" }),
    });
    expect(approved.status).toBe(201);
    return created;
  }

  it("exposes the canonical episode as a standard series and delegates streams to installed addons", async () => {
    const created = await arrangePlayback();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");

    const catalog = await (await SELF.fetch(`${base}/catalog/series/kids-tv-channel.json`)).json<any>();
    expect(catalog.metas).toHaveLength(1);
    const metadata = await (await SELF.fetch(`${base}/meta/series/${encodeURIComponent(catalog.metas[0].id)}.json`)).json<any>();
    expect(metadata.meta).toMatchObject({
      id: "kids-channels:tv",
      type: "series",
      behaviorHints: { defaultVideoId: canonicalEpisodeId },
    });
    expect(metadata.meta.videos).toEqual([
      expect.objectContaining({ id: canonicalEpisodeId, season: 1, episode: 1, title: "Playback Show — Beginning" }),
      expect.objectContaining({ id: "tt2468101:1:2", season: 1, episode: 2, title: "Playback Show — Later" }),
    ]);

    const stream = await SELF.fetch(`${base}/stream/series/${encodeURIComponent(canonicalEpisodeId)}.json`);
    expect(stream.status).toBe(200);
    expect(await stream.json()).toEqual({ streams: [], behaviorHints: { bingeGroup: "kids-channels-tv" } });
    expect(await env.DB.prepare("SELECT next_video_id FROM show_progress").first()).toMatchObject({ next_video_id: canonicalEpisodeId });
    expect(await env.DB.prepare("SELECT video_id FROM current_programmes WHERE channel = 'tv'").first()).toMatchObject({ video_id: canonicalEpisodeId });
  });
});

describe("rolling TV Channel Schedule", () => {
  async function arrangeShows(showCount: number, episodeCount = 30) {
    const created = await create();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (let show = 1; show <= showCount; show += 1) {
      const programmeId = `programme-${show}`;
      statements.push(env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
        VALUES (?, ?, ?, 'show', ?, '[]', ?)`)
        .bind(programmeId, created.householdId, `tt900000${show}`, `Show ${show}`, `${now}-${show}`));
      for (let episode = 1; episode <= episodeCount; episode += 1) {
        statements.push(env.DB.prepare(`INSERT INTO show_episodes
          (programme_id, video_id, season, episode, title, released_at)
          VALUES (?, ?, 1, ?, ?, ?)`)
          .bind(programmeId, `tt900000${show}:1:${episode}`, episode, `Episode ${episode}`, now));
      }
      statements.push(env.DB.prepare("INSERT INTO show_progress (programme_id, next_video_id) VALUES (?, ?)")
        .bind(programmeId, `tt900000${show}:1:1`));
    }
    await env.DB.batch(statements);
    return { created, base: created.manifestUrl.replace(/\/manifest\.json$/, "") };
  }

  async function metadata(base: string) {
    return (await SELF.fetch(`${base}/meta/series/${encodeURIComponent("kids-channels:tv")}.json`)).json<any>();
  }

  it("alternates eligible shows deterministically and inspects twenty programmes without advancing Show Progress", async () => {
    const { base } = await arrangeShows(3);
    const first = await metadata(base);
    const second = await metadata(base);
    expect(first).toEqual(second);
    expect(first.meta.videos).toHaveLength(20);
    expect(first.meta.videos.map((video: any) => video.episode)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const showIds = first.meta.videos.map((video: any) => video.id.split(":")[0]);
    for (let index = 1; index < showIds.length; index += 1) expect(showIds[index]).not.toBe(showIds[index - 1]);
    const progress = await env.DB.prepare("SELECT next_video_id FROM show_progress ORDER BY programme_id").all<{ next_video_id: string }>();
    expect(progress.results.map((row) => row.next_video_id)).toEqual([
      "tt9000001:1:1", "tt9000002:1:1", "tt9000003:1:1",
    ]);
  });

  it("schedules one eligible show's regular episodes consecutively in order", async () => {
    const { base } = await arrangeShows(1, 25);
    const result = await metadata(base);
    expect(result.meta.videos.map((video: any) => video.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `tt9000001:1:${index + 1}`),
    );
  });

  it("advances naturally or through Next exactly once and replenishes the shared schedule", async () => {
    const { base } = await arrangeShows(2);
    const before = await metadata(base);
    const currentId = before.meta.videos[0].id;
    const nextId = before.meta.videos[1].id;

    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(currentId)}.json`);
    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toBe(currentId);

    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      SELF.fetch(`${base}/stream/series/${encodeURIComponent(nextId)}.json`)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).toBe(nextId);
    expect(after.meta.videos).toHaveLength(20);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_advancements").first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_schedule").first()).toMatchObject({ count: 20 });
    expect(await env.DB.prepare("SELECT COUNT(DISTINCT video_id) AS count FROM channel_schedule").first()).toMatchObject({ count: 20 });
  });

  it("plays a distant visible programme and treats every bypassed programme as skipped", async () => {
    const { base } = await arrangeShows(3);
    const before = await metadata(base);
    const target = before.meta.videos[8];
    const bypassed = before.meta.videos.slice(0, 8).map((video: any) => video.id);

    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(target.id)}.json`);
    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).toBe(target.id);
    expect(after.meta.videos).toHaveLength(20);

    for (let show = 1; show <= 3; show += 1) {
      const skippedEpisodes = bypassed
        .filter((id: string) => id.startsWith(`tt900000${show}:`))
        .map((id: string) => Number(id.split(":")[2]));
      const expected = skippedEpisodes.length === 0 ? 1 : Math.max(...skippedEpisodes) + 1;
      expect(await env.DB.prepare("SELECT next_video_id FROM show_progress WHERE programme_id = ?")
        .bind(`programme-${show}`).first()).toMatchObject({ next_video_id: `tt900000${show}:1:${expected}` });
    }
  });
});

describe("Stremio protocol", () => {
  it("serves a configurable household-specific manifest", async () => {
    const created = await create();
    const response = await SELF.fetch(created.manifestUrl);
    const manifest = await response.json<Record<string, any>>();

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(manifest).toMatchObject({
      version: "0.3.0",
      name: "Kids Channels",
      resources: ["catalog", "meta", "stream"],
      types: ["series", "movie"],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
    expect(manifest.id).toMatch(/^community\.kids-channels\.[0-9a-f-]{36}$/);
    expect(manifest.catalogs).toEqual([
      { type: "series", id: "kids-tv-channel", name: "Kids Channels - TV" },
      { type: "movie", id: "kids-movie-channel", name: "Kids Channels - Movies" },
    ]);
  });

  it("exposes exactly one clearly identifiable TV tile and one Movie tile", async () => {
    const created = await create();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");

    const tv = await (await SELF.fetch(`${base}/catalog/series/kids-tv-channel.json`)).json<any>();
    const movies = await (await SELF.fetch(`${base}/catalog/movie/kids-movie-channel.json`)).json<any>();

    expect(tv.metas).toHaveLength(1);
    expect(tv.metas[0]).toMatchObject({ id: "kids-channels:tv", type: "series", name: "TV Channel" });
    expect(movies.metas).toHaveLength(1);
    expect(movies.metas[0]).toMatchObject({ id: "kids-channels:movie", type: "movie", name: "Movie Channel" });
  });

  it("does not expose one Household through another secret", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const missing = await SELF.fetch(created.manifestUrl.replace(secret, `${secret}x`));
    expect(missing.status).toBe(404);
  });
});
