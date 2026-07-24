import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptedManifestUrl } from "../src/provider-config";
import { firstAcceptableCachedStream } from "../src/stream-provider";

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
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS households_secret_idx ON households (secret)").run();
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
  const deploymentSecret = "test-only-configuration-secret-at-least-32-characters";

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

  it("preserves provider ordering when selecting the first acceptable cached direct stream", () => {
    const first = { name: "Torrentio\nRD+", title: "First 1080p", url: "https://media.example/first" };
    const second = { name: "Torrentio\nRD+", title: "Second 1080p", url: "https://media.example/second" };
    expect(firstAcceptableCachedStream([
      { name: "Torrentio\nRD+", title: "Unsuitable 2160p", url: "https://media.example/4k" }, first, second,
    ])).toBe(first);
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
