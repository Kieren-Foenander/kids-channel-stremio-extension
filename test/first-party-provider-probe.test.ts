import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let endpoint: string;
let parentHeaders: Record<string, string>;
const input = {
  magnet: "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
  query: "Example Show",
  imdbId: "tt1234567",
  season: 1,
  episode: 2,
};

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mockedProviders() {
  const torrentInfoResponses = [
    { status: "waiting_files_selection", files: [{ id: 1, path: "/sample.mkv", bytes: 1000 }], links: [] },
    { status: "downloaded", files: [{ id: 1, path: "/sample.mkv", bytes: 1000 }], links: ["https://rd.test/restricted"] },
  ];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (requestInfo, init) => {
    const url = new URL(requestInfo instanceof Request ? requestInfo.url : requestInfo.toString());
    if (url.hostname === "zilean.elfhosted.com") return response([]);
    if (url.hostname === "api.knaben.org") return response({ hits: [] });
    if (url.pathname.endsWith("/torrents/addMagnet")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer household-real-debrid-token");
      return response({ id: "torrent-id" }, 201);
    }
    if (url.pathname.endsWith("/torrents/info/torrent-id")) return response(torrentInfoResponses.shift());
    if (url.pathname.endsWith("/torrents/selectFiles/torrent-id")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/unrestrict/link")) {
      return response({ download: "https://download.real-debrid.test/media-file" });
    }
    if (url.pathname.endsWith("/torrents/delete/torrent-id") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
}

beforeEach(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY NOT NULL,
    secret TEXT UNIQUE NOT NULL,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1,
    real_debrid_token_ciphertext TEXT,
    real_debrid_token_iv TEXT,
    real_debrid_token_updated_at TEXT
  )`).run();
  await env.DB.prepare("DELETE FROM households").run();
  const created = await SELF.fetch("https://kids.test/api/households", {
    method: "POST",
    headers: { origin: "https://kids.test", "content-type": "application/json" },
    body: JSON.stringify({ pin: "123456" }),
  });
  const household = await created.json<{ manifestUrl: string }>();
  const householdSecret = new URL(household.manifestUrl).pathname.split("/")[2];
  endpoint = `https://kids.test/api/households/${householdSecret}/provider-probe`;
  const cookie = created.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Parent session cookie was not issued");
  parentHeaders = {
    cookie,
    origin: "https://kids.test",
    "content-type": "application/json",
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 123 }));
  const saved = await SELF.fetch(`https://kids.test/api/households/${householdSecret}/real-debrid`, {
    method: "PUT",
    headers: parentHeaders,
    body: JSON.stringify({ token: "household-real-debrid-token" }),
  });
  if (!saved.ok) throw new Error(`Could not arrange Household credential: ${saved.status}`);
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("first-party provider feasibility probe", () => {
  it("requires the unlocked Parent session for the target Household", async () => {
    const missing = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { origin: "https://kids.test" },
      body: JSON.stringify(input),
    });
    const crossOrigin = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { ...parentHeaders, origin: "https://other.test" },
      body: JSON.stringify(input),
    });

    expect(missing.status).toBe(401);
    expect(crossOrigin.status).toBe(403);
  });

  it("reports only statuses and timings, cleans up the torrent, and never exposes provider data", async () => {
    const providers = mockedProviders();
    const result = await SELF.fetch(endpoint, {
      method: "POST",
      headers: parentHeaders,
      body: JSON.stringify(input),
    });
    const report = await result.json<Record<string, unknown>>();
    const serialized = JSON.stringify(report);

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(report).toMatchObject({
      success: true,
      realDebrid: {
        reachable: true,
        cached: true,
        redirectReady: true,
        timings: {
          addMagnetMs: expect.any(Number),
          filesReadyMs: expect.any(Number),
          cacheCheckMs: expect.any(Number),
          unrestrictMs: expect.any(Number),
          totalMs: expect.any(Number),
        },
      },
      discovery: {
        zilean: { status: 200, durationMs: expect.any(Number), reachable: true },
        knaben: { status: 200, durationMs: expect.any(Number), reachable: true },
      },
    });
    expect(serialized).not.toContain("household-real-debrid-token");
    expect(serialized).not.toContain("download.real-debrid.test");
    expect(serialized).not.toContain("restricted");
    expect(providers).toHaveBeenCalledWith(
      expect.stringContaining("/torrents/delete/torrent-id"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("redirects without proxying media bytes and keeps the direct link out of the response body", async () => {
    mockedProviders();
    const result = await SELF.fetch(`${endpoint}/redirect`, {
      method: "POST",
      redirect: "manual",
      headers: parentHeaders,
      body: JSON.stringify(input),
    });

    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("https://download.real-debrid.test/media-file");
    expect(result.headers.get("server-timing")).toMatch(/^real-debrid;dur=\d+$/);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).toBe("");
  });

  it("falls back to the remaining discovery provider without retaining a rejected response body", async () => {
    const providers = mockedProviders();
    providers.mockImplementationOnce(async () => response({ sensitive: "provider-body" }, 403));
    const result = await SELF.fetch(endpoint, {
      method: "POST",
      headers: parentHeaders,
      body: JSON.stringify(input),
    });
    const report = await result.json<{
      success: boolean;
      discovery: { zilean: { status: number; reachable: boolean } };
    }>();

    expect(report.success).toBe(true);
    expect(report.discovery.zilean).toMatchObject({ status: 403, reachable: false });
    expect(JSON.stringify(report)).not.toContain("provider-body");
  });

  it("fails discovery only when every discovery provider is unavailable", async () => {
    const providers = mockedProviders();
    providers
      .mockImplementationOnce(async () => response([], 404))
      .mockImplementationOnce(async () => response({}, 503));
    const result = await SELF.fetch(endpoint, {
      method: "POST",
      headers: parentHeaders,
      body: JSON.stringify(input),
    });
    const report = await result.json<{
      success: boolean;
      discovery: {
        zilean: { status: number; reachable: boolean };
        knaben: { status: number; reachable: boolean };
      };
    }>();

    expect(report.success).toBe(false);
    expect(report.discovery.zilean).toMatchObject({ status: 404, reachable: false });
    expect(report.discovery.knaben).toMatchObject({ status: 503, reachable: false });
  });
});
