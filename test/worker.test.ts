import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptedManifestUrl } from "../src/provider-config";
import { firstAcceptableCachedStream, TorrentioProvider } from "../src/stream-provider";

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
    torrentio_ciphertext TEXT,
    torrentio_nonce TEXT,
    torrentio_validation_status TEXT,
    torrentio_configured_at TEXT
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
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS households_secret_idx ON households (secret)").run();
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
    expect(parentHtml).toContain("Torrentio manifest URL");

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

describe("Torrentio configuration", () => {
  const providerOrigin = "https://torrentio.example";
  const providerPath = "/providers=test/realdebrid=REDACTED";
  const manifestUrl = `${providerOrigin}${providerPath}/manifest.json`;
  const deploymentSecret = (env as typeof env & { CONFIG_SECRET: string }).CONFIG_SECRET;

  function mockTorrentio(streams: unknown[], manifestStatus = 200, streamStatus = 200) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === `${providerPath}/manifest.json`) {
        return Response.json(manifestStatus === 200 ? { id: "org.example.torrentio", resources: ["stream"] } : {}, { status: manifestStatus });
      }
      if (path === `${providerPath}/stream/movie/tt0111161.json`) {
        return Response.json(streamStatus === 200 ? { streams } : {}, { status: streamStatus });
      }
      throw new Error("unexpected outbound request");
    });
  }

  async function unlock(created: CreatedHousehold): Promise<string> {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
    return (await response.json<{ parentToken: string }>()).parentToken;
  }

  async function save(created: CreatedHousehold, parentToken: string) {
    return SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/provider`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${parentToken}` },
      body: JSON.stringify({ manifestUrl }),
    });
  }

  it("requires an authenticated Parent and never returns the configured credential", async () => {
    const created = await create();
    const denied = await save(created, "invalid-token");
    expect(denied.status).toBe(401);

    mockTorrentio([{ name: "Torrentio\nRD+", title: "Example 1080p", url: "https://media.example/video" }]);
    const accepted = await save(created, await unlock(created));
    const body = await accepted.text();
    expect(accepted.status).toBe(200);
    expect(body).not.toContain(manifestUrl);
    expect(body).not.toContain("REDACTED");
    expect(JSON.parse(body)).toMatchObject({ configured: true, validation: { status: "acceptable_cached" } });

    const stored = await env.DB.prepare("SELECT torrentio_ciphertext, torrentio_nonce FROM households WHERE id = ?")
      .bind(created.householdId).first<{ torrentio_ciphertext: string; torrentio_nonce: string }>();
    expect(stored?.torrentio_ciphertext).not.toContain("REDACTED");
    expect(stored?.torrentio_nonce).toBeTruthy();
    expect(await decryptedManifestUrl(env.DB, created.householdId, deploymentSecret)).toBe(manifestUrl);

    const tampered = `${stored?.torrentio_ciphertext[0] === "A" ? "B" : "A"}${stored?.torrentio_ciphertext.slice(1)}`;
    await env.DB.prepare("UPDATE households SET torrentio_ciphertext = ? WHERE id = ?")
      .bind(tampered, created.householdId).run();
    await expect(decryptedManifestUrl(env.DB, created.householdId, deploymentSecret)).rejects.toThrow();
  });

  it.each([
    [[], "no_cached_result"],
    [[{ name: "Torrentio\nRD download", title: "Example 1080p", url: "https://media.example/download" }], "no_cached_result"],
    [[{ name: "Torrentio\nRD+", title: "Example 2160p", url: "https://media.example/video" }], "unsuitable_results"],
  ])("distinguishes validation result %#", async (streams, expected) => {
    const created = await create();
    mockTorrentio(streams);
    const response = await save(created, await unlock(created));
    expect(await response.json<any>()).toMatchObject({ validation: { status: expected } });
  });

  it("reports provider failure without exposing provider response details", async () => {
    const created = await create();
    mockTorrentio([], 503);
    const response = await save(created, await unlock(created));
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ validation: { status: "provider_failure" } });
    expect(body).not.toContain(manifestUrl);
    expect(body).not.toContain("REDACTED");
  });

  it("replaces an existing encrypted configuration", async () => {
    const created = await create();
    const token = await unlock(created);
    mockTorrentio([{ name: "Torrentio\nRD+", title: "Example 1080p", url: "https://media.example/video" }]);
    await save(created, token);
    const first = await env.DB.prepare("SELECT torrentio_ciphertext FROM households WHERE id = ?")
      .bind(created.householdId).first<{ torrentio_ciphertext: string }>();

    mockTorrentio([{ name: "Torrentio\nRD+", title: "Example 1080p", url: "https://media.example/video" }]);
    await save(created, token);
    const second = await env.DB.prepare("SELECT torrentio_ciphertext FROM households WHERE id = ?")
      .bind(created.householdId).first<{ torrentio_ciphertext: string }>();
    expect(second?.torrentio_ciphertext).not.toBe(first?.torrentio_ciphertext);

    const unlocked = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const body = await unlocked.text();
    expect(JSON.parse(body)).toMatchObject({ provider: { configured: true, validation: { status: "acceptable_cached" } } });
    expect(body).not.toContain("REDACTED");
  });

  it("invokes an injected outbound fetch with the Worker global receiver", async () => {
    let requests = 0;
    const strictFetch = async function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError("fetch called with the wrong receiver");
      requests += 1;
      return requests === 1
        ? Response.json({ id: "org.example.torrentio", resources: ["stream"] })
        : Response.json({ streams: [] });
    } as typeof fetch;

    const result = await new TorrentioProvider(new URL(manifestUrl), strictFetch).validate();
    expect(result.status).toBe("no_cached_result");
    expect(requests).toBe(2);
  });

  it("preserves provider ordering when selecting the first acceptable cached direct stream", () => {
    const first = { name: "Torrentio\nRD+", title: "First 1080p", url: "https://media.example/first" };
    const second = { name: "Torrentio\nRD+", title: "Second 1080p", url: "https://media.example/second" };
    expect(firstAcceptableCachedStream([
      { name: "Torrentio\nRD+", title: "Unsuitable 2160p", url: "https://media.example/4k" }, first, second,
    ])).toBe(first);
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

describe("Stremio protocol", () => {
  it("serves a configurable household-specific manifest", async () => {
    const created = await create();
    const response = await SELF.fetch(created.manifestUrl);
    const manifest = await response.json<Record<string, any>>();

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(manifest).toMatchObject({
      version: "0.1.0",
      name: "Kids Channels",
      resources: ["catalog"],
      types: ["tv", "movie"],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
    expect(manifest.id).toMatch(/^community\.kids-channels\.[0-9a-f-]{36}$/);
    expect(manifest.catalogs).toEqual([
      { type: "tv", id: "kids-tv-channel", name: "Kids Channels - TV" },
      { type: "movie", id: "kids-movie-channel", name: "Kids Channels - Movies" },
    ]);
  });

  it("exposes exactly one clearly identifiable TV tile and one Movie tile", async () => {
    const created = await create();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");

    const tv = await (await SELF.fetch(`${base}/catalog/tv/kids-tv-channel.json`)).json<any>();
    const movies = await (await SELF.fetch(`${base}/catalog/movie/kids-movie-channel.json`)).json<any>();

    expect(tv.metas).toHaveLength(1);
    expect(tv.metas[0]).toMatchObject({ id: "kids-channels:tv", type: "tv", name: "TV Channel" });
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
