import { env, SELF as worker } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SELF = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/households") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const headers = new Headers(request.headers);
      if (!headers.has("origin")) headers.set("origin", url.origin);
      request = new Request(request, { headers });
    }
    return worker.fetch(request);
  },
};

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
    created_at TEXT NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pin_attempts (
    household_id TEXT NOT NULL, origin_hash TEXT NOT NULL, failed_attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL, blocked_until INTEGER,
    PRIMARY KEY (household_id, origin_hash)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS approved_programmes (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, imdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, poster TEXT, background TEXT,
    release_info TEXT, genres_json TEXT NOT NULL DEFAULT '[]', imdb_rating TEXT, approved_at TEXT NOT NULL,
    paused_at TEXT, UNIQUE (household_id, content_type, imdb_id)
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
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_advancement_history (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, from_position INTEGER NOT NULL,
    target_position INTEGER NOT NULL, previous_programme_id TEXT NOT NULL, previous_video_id TEXT NOT NULL,
    target_programme_id TEXT NOT NULL, target_video_id TEXT NOT NULL, progress_before_json TEXT NOT NULL,
    progress_after_json TEXT NOT NULL, advanced_at TEXT NOT NULL, undone_at TEXT, undo_owner_token TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_channel_state (
    household_id TEXT PRIMARY KEY NOT NULL, cycle INTEGER NOT NULL, current_position INTEGER NOT NULL,
    selection_seed TEXT NOT NULL, initialized_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_rotation (
    household_id TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    programme_id TEXT NOT NULL, consumed_at TEXT,
    PRIMARY KEY (household_id, cycle, position), UNIQUE (household_id, cycle, programme_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_advancements (
    household_id TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    owner_token TEXT NOT NULL, advanced_at TEXT NOT NULL,
    PRIMARY KEY (household_id, cycle, position)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_channel_mutations (
    household_id TEXT NOT NULL, revision INTEGER NOT NULL, owner_token TEXT NOT NULL, claimed_at TEXT NOT NULL,
    PRIMARY KEY (household_id, revision)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_playback_history (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, programme_id TEXT NOT NULL,
    imdb_id TEXT NOT NULL, title TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    played_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS households_secret_idx ON households (secret)").run();
  await env.DB.prepare("DELETE FROM pin_attempts").run();
  await env.DB.prepare("DELETE FROM movie_playback_history").run();
  await env.DB.prepare("DELETE FROM movie_channel_mutations").run();
  await env.DB.prepare("DELETE FROM movie_advancements").run();
  await env.DB.prepare("DELETE FROM movie_rotation").run();
  await env.DB.prepare("DELETE FROM movie_channel_state").run();
  await env.DB.prepare("DELETE FROM tv_advancement_history").run();
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

function sessionHeaders(response: Response): { cookie: string } {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Parent session cookie was not issued");
  return { cookie };
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

  it("rejects cross-origin Parent mutations and does not expose private API CORS", async () => {
    const missingOrigin = await worker.fetch("https://kids.test/api/households", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const crossOrigin = await worker.fetch("https://kids.test/api/households", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.kids.test" },
      body: JSON.stringify({ pin: "123456" }),
    });
    expect(crossOrigin.status).toBe(403);

    const preflight = await worker.fetch("https://kids.test/api/households", {
      method: "OPTIONS",
      headers: { origin: "https://other.kids.test" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const createdResponse = await worker.fetch("https://kids.test/api/households", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://kids.test" },
      body: JSON.stringify({ pin: "123456" }),
    });
    const created = await createdResponse.json<CreatedHousehold>();
    const cookie = createdResponse.headers.get("set-cookie")!.split(";")[0];
    const cookieAttack = await worker.fetch(
      `https://kids.test/api/households/${secretFrom(created)}/tv-schedule/regenerate`,
      { method: "POST", headers: { cookie, origin: "https://other.kids.test" } },
    );
    expect(cookieAttack.status).toBe(403);
  });

  it("creates a one-hour HttpOnly Parent session without returning its credential", async () => {
    const response = await SELF.fetch("https://kids.test/api/households", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
    const created = await response.clone().json<CreatedHousehold & { parentToken?: string }>();
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(201);
    expect(created.parentToken).toBeUndefined();
    expect(cookie).toMatch(/^kids_parent_session=[^;]+;/);
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const session = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/session`, {
      headers: { cookie: cookie!.split(";")[0] },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: true, expiresIn: 3600 });
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
    expect(parentHtml).toContain("fully close and reopen Stremio");

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
    expect(await unlocked.clone().json()).toMatchObject({ manifestUrl: created.manifestUrl });
    expect(await unlocked.json()).not.toHaveProperty("parentToken");
    const session = sessionHeaders(unlocked);
    expect(unlocked.headers.get("set-cookie")).toContain("Max-Age=3600");

    const locked = await SELF.fetch(`https://kids.test/api/households/${secret}/lock`, {
      method: "POST", headers: session,
    });
    expect(locked.status).toBe(200);
    expect(locked.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/session`, { headers: session })).status).toBe(200);
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/session`)).status).toBe(401);
  });

  it("rate-limits PIN failures by Household and request origin without exposing secrets", async () => {
    const first = await create();
    const second = await create("654321");
    const unlock = (created: CreatedHousehold, pin: string, origin: string) => SELF.fetch(
      `https://kids.test/api/households/${secretFrom(created)}/unlock`,
      { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": origin }, body: JSON.stringify({ pin }) },
    );

    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect((await unlock(first, "000000", "192.0.2.10")).status).toBe(401);
    }
    const limited = await unlock(first, "000000", "192.0.2.10");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");
    const limitedBody = await limited.text();
    expect(limitedBody).not.toContain(secretFrom(first));
    expect(limitedBody).not.toContain("000000");

    expect((await unlock(first, "123456", "192.0.2.11")).status).toBe(200);
    expect((await unlock(second, "654321", "192.0.2.10")).status).toBe(200);
  });

  it("rotates the PIN only with the current PIN and invalidates older Parent sessions", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const unlocked = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const oldSession = sessionHeaders(unlocked);

    const denied = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
      method: "PUT", headers: { ...oldSession, "content-type": "application/json" },
      body: JSON.stringify({ currentPin: "000000", newPin: "654321" }),
    });
    expect(denied.status).toBe(401);

    const rotated = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
      method: "PUT", headers: { ...oldSession, "content-type": "application/json" },
      body: JSON.stringify({ currentPin: "123456", newPin: "654321" }),
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.clone().json()).not.toHaveProperty("parentToken");
    const newSession = sessionHeaders(rotated);
    expect(newSession.cookie).not.toBe(oldSession.cookie);
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/tv-state`, { headers: oldSession })).status).toBe(401);
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/tv-state`, { headers: newSession })).status).toBe(200);

    const oldPin = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    expect(oldPin.status).toBe(401);
    const newPin = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "654321" }),
    });
    expect(newPin.status).toBe(200);
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
    return sessionHeaders(response);
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
    const session = sessionHeaders(unlocked);
    const approved = await SELF.fetch(`https://kids.test/api/households/${secret}/library`, {
      method: "POST", headers: { "content-type": "application/json", ...session },
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
    expect(stream.headers.get("cache-control")).toBe("no-store");
    expect(await stream.json()).toEqual({ streams: [] });
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

  async function parentHeaders(created: CreatedHousehold) {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    return sessionHeaders(response);
  }

  it("alternates eligible shows deterministically and inspects twenty programmes without advancing Show Progress", async () => {
    const { base } = await arrangeShows(3);
    const metadataResponse = await SELF.fetch(`${base}/meta/series/${encodeURIComponent("kids-channels:tv")}.json`);
    expect(metadataResponse.headers.get("cache-control")).toBe("no-store");
    const first = await metadataResponse.json<any>();
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

  it("displays Current Programme, Channel Schedule, and recent playback only to the Parent", async () => {
    const { created, base } = await arrangeShows(2);
    expect((await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/tv-state`)).status).toBe(401);
    const before = await metadata(base);
    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(before.meta.videos[1].id)}.json`);

    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/tv-state`, {
      headers: await parentHeaders(created),
    });
    const state = await response.json<any>();
    expect(state.current.episode.id).toBe(before.meta.videos[1].id);
    expect(state.schedule).toHaveLength(20);
    expect(state.recentPlayback[0]).toMatchObject({ showTitle: expect.stringMatching(/^Show /), episode: { id: before.meta.videos[0].id } });
    expect(state.canUndo).toBe(true);
    expect(JSON.stringify(state)).not.toContain(secretFrom(created));
  });

  it("corrects Show Progress, repairs incompatible future entries, and preserves the Current Programme", async () => {
    const { created, base } = await arrangeShows(2, 8);
    const before = await metadata(base);
    const currentId = before.meta.behaviorHints.defaultVideoId;
    const headers = await parentHeaders(created);
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/programme-1/progress`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ videoId: "tt9000001:1:5" }),
    });
    expect(response.status).toBe(200);
    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).toBe(currentId);
    const futureShowOne = after.meta.videos.slice(1).filter((video: any) => video.id.startsWith("tt9000001:"));
    expect(futureShowOne.length).toBeGreaterThan(0);
    expect(futureShowOne.every((video: any) => Number(video.id.split(":")[2]) >= 5)).toBe(true);
    expect(await env.DB.prepare("SELECT next_video_id FROM show_progress WHERE programme_id = 'programme-1'").first())
      .toMatchObject({ next_video_id: "tt9000001:1:5" });
  });

  it("undoes only the latest advancement and does not overwrite another show's later correction", async () => {
    const { created, base } = await arrangeShows(2, 8);
    const before = await metadata(base);
    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(before.meta.videos[1].id)}.json`);
    const headers = await parentHeaders(created);
    const priorShow = before.meta.videos[0].id.startsWith("tt9000001:") ? "programme-1" : "programme-2";
    const otherShow = priorShow === "programme-1" ? "programme-2" : "programme-1";
    const otherImdb = otherShow === "programme-1" ? "tt9000001" : "tt9000002";
    await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/${otherShow}/progress`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ videoId: `${otherImdb}:1:6` }),
    });
    const undo = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/tv-schedule/undo`, { method: "POST", headers });
    expect(undo.status).toBe(200);
    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toBe(before.meta.videos[0].id);
    expect(await env.DB.prepare("SELECT next_video_id FROM show_progress WHERE programme_id = ?").bind(otherShow).first())
      .toMatchObject({ next_video_id: `${otherImdb}:1:6` });
    expect((await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/tv-schedule/undo`, { method: "POST", headers })).status).toBe(409);
  });

  it("marks exhausted shows Finished and lets the Parent restart them", async () => {
    const { created, base } = await arrangeShows(2, 2);
    const before = await metadata(base);
    const lastShowOne = before.meta.videos.findIndex((video: any) => video.id === "tt9000001:1:2");
    expect(lastShowOne).toBeGreaterThanOrEqual(0);
    const target = before.meta.videos[lastShowOne + 1];
    expect(target).toBeTruthy();
    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(target.id)}.json`);
    expect(await env.DB.prepare("SELECT next_video_id FROM show_progress WHERE programme_id = 'programme-1'").first()).toBeNull();
    const exhausted = await metadata(base);
    expect(exhausted.meta.videos.slice(1).every((video: any) => !video.id.startsWith("tt9000001:"))).toBe(true);

    const headers = await parentHeaders(created);
    const restart = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/programme-1/progress`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ videoId: "tt9000001:1:1" }),
    });
    expect(restart.status).toBe(200);
    expect((await metadata(base)).meta.videos.slice(1).some((video: any) => video.id === "tt9000001:1:1")).toBe(true);
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

describe("Approved Library changes while Channels are active", () => {
  async function arrangeActiveChannels() {
    const created = await create();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (let show = 1; show <= 2; show += 1) {
      statements.push(env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
        VALUES (?, ?, ?, 'show', ?, '[]', ?)`)
        .bind(`active-show-${show}`, created.householdId, `tt700000${show}`, `Active Show ${show}`, `${now}-${show}`));
      for (let episode = 1; episode <= 25; episode += 1) {
        statements.push(env.DB.prepare(`INSERT INTO show_episodes
          (programme_id, video_id, season, episode, title, released_at) VALUES (?, ?, 1, ?, ?, ?)`)
          .bind(`active-show-${show}`, `tt700000${show}:1:${episode}`, episode, `Episode ${episode}`, now));
      }
      statements.push(env.DB.prepare("INSERT INTO show_progress (programme_id, next_video_id) VALUES (?, ?)")
        .bind(`active-show-${show}`, `tt700000${show}:1:1`));
    }
    for (let movie = 1; movie <= 3; movie += 1) {
      statements.push(env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
        VALUES (?, ?, ?, 'movie', ?, '[]', ?)`)
        .bind(`active-movie-${movie}`, created.householdId, `tt600000${movie}`, `Active Movie ${movie}`, `${now}-${movie}`));
    }
    await env.DB.batch(statements);

    const secret = secretFrom(created);
    const unlocked = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const headers = sessionHeaders(unlocked);
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    const tvUrl = `${base}/meta/series/${encodeURIComponent("kids-channels:tv")}.json`;
    const movieUrl = `${base}/meta/movie/${encodeURIComponent("kids-channels:movie")}.json`;
    expect((await (await SELF.fetch(tvUrl)).json<any>()).meta).not.toBeNull();
    expect((await (await SELF.fetch(movieUrl)).json<any>()).meta).not.toBeNull();
    return { created, secret, headers, base, tvUrl, movieUrl };
  }

  it("pauses, resumes, regenerates, and removes shows without falsely advancing Show Progress", async () => {
    const { created, secret, headers, base, tvUrl } = await arrangeActiveChannels();
    const initial = await (await SELF.fetch(tvUrl)).json<any>();
    const initialVideoId = initial.meta.behaviorHints.defaultVideoId as string;
    const current = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel = 'tv'")
      .bind(created.householdId).first<{ programme_id: string }>();
    expect(current).toBeTruthy();
    const progressBefore = await env.DB.prepare("SELECT programme_id, next_video_id FROM show_progress ORDER BY programme_id")
      .all<{ programme_id: string; next_video_id: string }>();

    const pause = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${current!.programme_id}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ paused: true }),
    });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ message: expect.stringContaining("Restart Stremio") });
    const whilePaused = await (await SELF.fetch(tvUrl)).json<any>();
    expect(whilePaused.meta.behaviorHints.defaultVideoId).not.toBe(initialVideoId);
    expect(whilePaused.meta.videos.every((video: any) => !video.id.startsWith(initialVideoId.split(":")[0]))).toBe(true);
    expect(await env.DB.prepare("SELECT paused_at FROM approved_programmes WHERE id = ?").bind(current!.programme_id).first<string>("paused_at"))
      .toBeTruthy();

    const resume = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${current!.programme_id}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ paused: false }),
    });
    expect(resume.status).toBe(200);
    expect(await env.DB.prepare("SELECT paused_at FROM approved_programmes WHERE id = ?").bind(current!.programme_id).first<string>("paused_at"))
      .toBeNull();
    expect((await env.DB.prepare("SELECT programme_id, next_video_id FROM show_progress ORDER BY programme_id")
      .all()).results).toEqual(progressBefore.results);

    const beforeRegenerate = await (await SELF.fetch(tvUrl)).json<any>();
    const seedBefore = await env.DB.prepare("SELECT selection_seed FROM channel_state WHERE household_id = ? AND channel = 'tv'")
      .bind(created.householdId).first<string>("selection_seed");
    const regenerate = await SELF.fetch(`https://kids.test/api/households/${secret}/tv-schedule/regenerate`, { method: "POST", headers });
    expect(regenerate.status).toBe(200);
    const afterRegenerate = await (await SELF.fetch(tvUrl)).json<any>();
    expect(afterRegenerate.meta.behaviorHints.defaultVideoId).toBe(beforeRegenerate.meta.behaviorHints.defaultVideoId);
    expect(await env.DB.prepare("SELECT selection_seed FROM channel_state WHERE household_id = ? AND channel = 'tv'")
      .bind(created.householdId).first<string>("selection_seed")).not.toBe(seedBefore);
    expect((await env.DB.prepare("SELECT programme_id, next_video_id FROM show_progress ORDER BY programme_id")
      .all()).results).toEqual(progressBefore.results);

    const currentProgrammeId = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel = 'tv'")
      .bind(created.householdId).first<string>("programme_id");
    const futureProgrammeId = currentProgrammeId === "active-show-1" ? "active-show-2" : "active-show-1";
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${futureProgrammeId}`, { method: "DELETE", headers })).status).toBe(200);
    const oneShow = await (await SELF.fetch(tvUrl)).json<any>();
    expect(oneShow.meta.videos).toHaveLength(20);
    expect(oneShow.meta.videos.every((video: any) => video.id.startsWith(currentProgrammeId === "active-show-1" ? "tt7000001:" : "tt7000002:"))).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_schedule WHERE programme_id = ?").bind(futureProgrammeId).first())
      .toMatchObject({ count: 0 });

    const removedVideoId = oneShow.meta.behaviorHints.defaultVideoId;
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${currentProgrammeId}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await (await SELF.fetch(tvUrl)).json<any>()).meta).toBeNull();
    expect((await SELF.fetch(`${base}/stream/series/${encodeURIComponent(removedVideoId)}.json`)).status).toBe(200);
  });

  it("removes movies from the remaining rotation and keeps one-item and empty Channel states valid", async () => {
    const { created, secret, headers, movieUrl } = await arrangeActiveChannels();
    const before = await (await SELF.fetch(movieUrl)).json<any>();
    const removedVideoId = before.meta.behaviorHints.defaultVideoId;
    const removedProgrammeId = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel = 'movie'")
      .bind(created.householdId).first<string>("programme_id");

    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${removedProgrammeId}`, { method: "DELETE", headers })).status).toBe(200);
    const after = await (await SELF.fetch(movieUrl)).json<any>();
    expect(after.meta.behaviorHints.defaultVideoId).not.toBe(removedVideoId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_rotation WHERE household_id = ? AND programme_id = ?")
      .bind(created.householdId, removedProgrammeId).first()).toMatchObject({ count: 0 });

    const remaining = await env.DB.prepare("SELECT id FROM approved_programmes WHERE household_id = ? AND content_type = 'movie' ORDER BY id")
      .bind(created.householdId).all<{ id: string }>();
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${remaining.results[0].id}`, { method: "DELETE", headers })).status).toBe(200);
    const onlyMovie = await (await SELF.fetch(movieUrl)).json<any>();
    expect(onlyMovie.meta).not.toBeNull();

    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${remaining.results[1].id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await (await SELF.fetch(movieUrl)).json<any>()).meta).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_channel_state WHERE household_id = ?")
      .bind(created.householdId).first()).toMatchObject({ count: 0 });
  });
});

describe("Movie Channel rotation and sign-off", () => {
  async function arrangeMovies(count = 3) {
    const created = await create();
    const now = new Date().toISOString();
    await env.DB.batch(Array.from({ length: count }, (_, index) => env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, description, poster, genres_json, approved_at)
      VALUES (?, ?, ?, 'movie', ?, ?, ?, '[]', ?)`)
      .bind(`movie-${index + 1}`, created.householdId, `tt800000${index + 1}`, `Movie ${index + 1}`,
        `Approved movie ${index + 1}.`, `https://images.example/movie-${index + 1}.jpg`, `${now}-${index}`)));
    return { created, base: created.manifestUrl.replace(/\/manifest\.json$/, "") };
  }

  async function metadata(base: string) {
    return (await SELF.fetch(`${base}/meta/movie/${encodeURIComponent("kids-channels:movie")}.json`)).json<any>();
  }

  async function parentHeaders(created: CreatedHousehold) {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    return sessionHeaders(response);
  }

  it("keeps an interrupted canonical movie current and delegates its streams and subtitles to installed addons", async () => {
    const { base } = await arrangeMovies();
    const first = await metadata(base);
    const currentId = first.meta.behaviorHints.defaultVideoId;
    expect(currentId).toMatch(/^tt800000[1-3]$/);
    expect(first.meta).toMatchObject({ id: "kids-channels:movie", type: "movie" });
    expect(first.meta.videos[0]).toMatchObject({ id: currentId, title: expect.stringMatching(/^Movie/) });

    const observer = await SELF.fetch(`${base}/stream/movie/${currentId}.json`);
    expect(await observer.json()).toEqual({ streams: [] });
    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toBe(currentId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_advancements").first()).toMatchObject({ count: 0 });
  });

  it("consumes each movie once through Next/sign-off requests, then begins a new shuffled cycle", async () => {
    const { base } = await arrangeMovies();
    const selected: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const before = await metadata(base);
      selected.push(before.meta.behaviorHints.defaultVideoId);
      const signOff = before.meta.videos[1];
      expect(signOff).toMatchObject({
        title: "Kids Channels sign-off",
        episode: 2,
        streams: [{
          url: expect.stringMatching(/^https:\/\/kids\.test\/addons\/[^/]+\/media\/movie-sign-off\/\d+\/\d+\.mp4$/),
          behaviorHints: { filename: "kids-channels-sign-off.mp4" },
        }],
      });
      const response = await SELF.fetch(signOff.streams[0].url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
    }
    expect(new Set(selected).size).toBe(3);
    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toMatch(/^tt800000[1-3]$/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_rotation WHERE cycle = 0 AND consumed_at IS NOT NULL").first())
      .toMatchObject({ count: 3 });
  });

  it("adds a newly approved movie to the unplayed rotation before any movie repeats", async () => {
    const { created, base } = await arrangeMovies(2);
    const first = await metadata(base);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
      VALUES ('movie-3', ?, 'tt8000003', 'movie', 'Movie 3', '[]', ?)`).bind(created.householdId, now).run();

    await Promise.all(Array.from({ length: 6 }, () => metadata(base)));
    const insertedRotation = await env.DB.prepare(`SELECT COUNT(*) AS count,
      COUNT(DISTINCT rotation.programme_id) AS distinct_count
      FROM movie_rotation rotation JOIN movie_channel_state state
        ON state.household_id = rotation.household_id AND state.cycle = rotation.cycle
      WHERE rotation.household_id = ?`).bind(created.householdId)
      .first<{ count: number; distinct_count: number }>();
    expect(insertedRotation).toMatchObject({ count: 3, distinct_count: 3 });

    const selected: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const current = index === 0 ? first : await metadata(base);
      selected.push(current.meta.behaviorHints.defaultVideoId);
      await SELF.fetch(current.meta.videos[1].streams[0].url);
    }
    expect(new Set(selected)).toEqual(new Set(["tt8000001", "tt8000002", "tt8000003"]));
  });

  it("shows the Current Programme, remaining rotation, and snapshot history only to the Parent", async () => {
    const { created, base } = await arrangeMovies();
    expect((await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/movie-state`)).status).toBe(401);
    const before = await metadata(base);
    const playedTitle = before.meta.videos[0].title;
    await SELF.fetch(before.meta.videos[1].streams[0].url);

    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/movie-state`, {
      headers: await parentHeaders(created),
    });
    const channelState = await response.json<any>();
    expect(response.status).toBe(200);
    expect(channelState.current.title).not.toBe(playedTitle);
    expect(channelState.remaining).toHaveLength(1);
    expect(channelState.recentPlayback[0]).toMatchObject({ title: playedTitle, imdbId: expect.stringMatching(/^tt/) });
    expect(JSON.stringify(channelState)).not.toContain(secretFrom(created));

    const removal = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/${channelState.recentPlayback[0].programmeId}`, {
      method: "DELETE", headers: await parentHeaders(created),
    });
    expect(removal.status).toBe(200);
    const afterRemoval = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/movie-state`, {
      headers: await parentHeaders(created),
    }).then((result) => result.json<any>());
    expect(afterRemoval.recentPlayback[0].title).toBe(playedTitle);
  });

  it("resets every approved movie exactly once without changing the active programme or sign-off", async () => {
    const { created, base } = await arrangeMovies();
    const first = await metadata(base);
    await SELF.fetch(first.meta.videos[1].streams[0].url);
    const active = await metadata(base);
    const activeId = active.meta.behaviorHints.defaultVideoId;
    const activeSignOff = active.meta.videos[1].streams[0].url;
    const headers = await parentHeaders(created);

    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/movie-rotation/reset`, {
      method: "POST", headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("without interrupting") });
    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).toBe(activeId);
    expect(after.meta.videos[1].streams[0].url).toBe(activeSignOff);

    const rotation = await env.DB.prepare(`SELECT rotation.programme_id, rotation.consumed_at
      FROM movie_rotation rotation JOIN movie_channel_state state
        ON state.household_id = rotation.household_id AND state.cycle = rotation.cycle
      WHERE rotation.household_id = ? ORDER BY rotation.position`).bind(created.householdId)
      .all<{ programme_id: string; consumed_at: string | null }>();
    expect(rotation.results).toHaveLength(3);
    expect(new Set(rotation.results.map((item) => item.programme_id)).size).toBe(3);
    expect(rotation.results.every((item) => item.consumed_at === null)).toBe(true);
  });

  it("serializes a Parent reset with playback advancement without consuming or duplicating a movie", async () => {
    const { created, base } = await arrangeMovies();
    const before = await metadata(base);
    const headers = await parentHeaders(created);
    const [signOff, reset] = await Promise.all([
      SELF.fetch(before.meta.videos[1].streams[0].url),
      SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/movie-rotation/reset`, { method: "POST", headers }),
    ]);
    expect(signOff.status).toBe(200);
    expect(reset.status).toBe(200);

    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).not.toBe(before.meta.behaviorHints.defaultVideoId);
    const activeRotation = await env.DB.prepare(`SELECT rotation.programme_id
      FROM movie_rotation rotation JOIN movie_channel_state state
        ON state.household_id = rotation.household_id AND state.cycle = rotation.cycle
      WHERE rotation.household_id = ?`).bind(created.householdId).all<{ programme_id: string }>();
    expect(activeRotation.results).toHaveLength(3);
    expect(new Set(activeRotation.results.map((item) => item.programme_id)).size).toBe(3);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_playback_history WHERE household_id = ?")
      .bind(created.householdId).first()).toMatchObject({ count: 1 });
  });

  it("advances a shared rotation only once under concurrent sign-off requests and leaves sign-off final", async () => {
    const { base } = await arrangeMovies();
    const before = await metadata(base);
    const currentId = before.meta.behaviorHints.defaultVideoId;
    const signOffUrl = before.meta.videos[1].streams[0].url;
    const responses = await Promise.all(Array.from({ length: 8 }, () => SELF.fetch(signOffUrl)));
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).not.toBe(currentId);
    expect(after.meta.videos).toHaveLength(2);
    expect(after.meta.videos[1].title).toBe("Kids Channels sign-off");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_advancements").first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_rotation WHERE consumed_at IS NOT NULL").first()).toMatchObject({ count: 1 });
  });

  it("serves an approximately five-second H.264 sign-off with Android-compatible HTTP semantics", async () => {
    const url = "https://kids.test/assets/movie-sign-off.mp4";
    const full = await SELF.fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("etag")).toBeTruthy();
    const length = Number(full.headers.get("content-length"));
    expect(length).toBeGreaterThan(10_000);

    const head = await SELF.fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(length);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const suffix = await SELF.fetch(url, { headers: { range: "bytes=-100" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${length - 100}-${length - 1}/${length}`);
    expect((await suffix.arrayBuffer()).byteLength).toBe(100);

    const clamped = await SELF.fetch(url, { headers: { range: "bytes=100-999999" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe(`bytes 100-${length - 1}/${length}`);
  });
});

describe("Household deletion", () => {
  it("requires explicit confirmation and current PIN, removes all state, and invalidates every synced route", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const unlock = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const headers = { ...sessionHeaders(unlock), "content-type": "application/json" };

    const unconfirmed = await SELF.fetch(`https://kids.test/api/households/${secret}`, {
      method: "DELETE", headers, body: JSON.stringify({ currentPin: "123456", confirmation: "delete" }),
    });
    expect(unconfirmed.status).toBe(400);
    const wrongPin = await SELF.fetch(`https://kids.test/api/households/${secret}`, {
      method: "DELETE", headers, body: JSON.stringify({ currentPin: "000000", confirmation: "DELETE" }),
    });
    expect(wrongPin.status).toBe(401);

    const householdId = created.householdId;
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
      VALUES ('programme-delete', ?, 'tt1234567', 'show', 'Delete me', '[]', 'now')`).bind(householdId).run();
    await env.DB.prepare("INSERT INTO show_episodes VALUES ('programme-delete', 'tt1234567:1:1', 1, 1, 'Pilot', 'now', NULL)").run();
    await env.DB.prepare("INSERT INTO show_progress VALUES ('programme-delete', 'tt1234567:1:1')").run();
    await env.DB.prepare("INSERT INTO current_programmes VALUES (?, 'tv', 'programme-delete', 'tt1234567:1:1', 'now')").bind(householdId).run();
    await env.DB.prepare("INSERT INTO channel_state VALUES (?, 'tv', 0, 'seed', 'now')").bind(householdId).run();
    await env.DB.prepare("INSERT INTO channel_schedule VALUES (?, 'tv', 0, 'programme-delete', 'tt1234567:1:1', 'now')").bind(householdId).run();
    await env.DB.prepare("INSERT INTO channel_advancements VALUES (?, 'tv', 0, 1, 'owner', 'now')").bind(householdId).run();
    await env.DB.prepare(`INSERT INTO tv_advancement_history VALUES
      ('history-delete', ?, 0, 1, 'programme-delete', 'tt1234567:1:1', 'programme-delete', 'tt1234567:1:1', '{}', '{}', 'now', NULL, NULL)`).bind(householdId).run();
    await env.DB.prepare("INSERT INTO movie_channel_state VALUES (?, 1, 0, 'seed', 'now', 0)").bind(householdId).run();
    await env.DB.prepare("INSERT INTO movie_rotation VALUES (?, 1, 0, 'programme-delete', NULL)").bind(householdId).run();
    await env.DB.prepare("INSERT INTO movie_advancements VALUES (?, 1, 0, 'owner', 'now')").bind(householdId).run();
    await env.DB.prepare("INSERT INTO movie_channel_mutations VALUES (?, 0, 'owner', 'now')").bind(householdId).run();
    await env.DB.prepare("INSERT INTO movie_playback_history VALUES ('movie-history-delete', ?, 'programme-delete', 'tt1234567', 'Delete me', 1, 0, 'now')").bind(householdId).run();

    const deleted = await SELF.fetch(`https://kids.test/api/households/${secret}`, {
      method: "DELETE", headers, body: JSON.stringify({ currentPin: "123456", confirmation: "DELETE" }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ message: "Household permanently deleted." });

    for (const table of ["households", "pin_attempts", "approved_programmes", "show_episodes", "show_progress",
      "current_programmes", "channel_state", "channel_schedule", "channel_advancements", "tv_advancement_history",
      "movie_channel_state", "movie_rotation", "movie_advancements", "movie_channel_mutations", "movie_playback_history"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toMatchObject({ count: 0 });
    }

    const base = `https://kids.test/addons/${secret}`;
    const invalidated = [
      created.parentUrl, `${base}/manifest.json`, `${base}/configure`,
      `${base}/catalog/series/kids-tv-channel.json`, `${base}/meta/series/${encodeURIComponent("kids-channels:tv")}.json`,
      `${base}/meta/movie/${encodeURIComponent("kids-channels:movie")}.json`,
      `${base}/stream/series/${encodeURIComponent("tt1234567:1:1")}.json`, `${base}/stream/movie/tt1234567.json`,
      `${base}/media/movie-sign-off/1/0.mp4`,
    ];
    for (const route of invalidated) {
      const response = await SELF.fetch(route);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(secret);
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
      version: "0.4.1",
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
