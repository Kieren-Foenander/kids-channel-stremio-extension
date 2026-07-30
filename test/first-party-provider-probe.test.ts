import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const endpoint = "https://kids.test/_probes/first-party-provider";
const authorization = { authorization: "Bearer test-only-provider-probe-secret" };
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
    if (url.pathname.endsWith("/torrents/addMagnet")) return response({ id: "torrent-id" }, 201);
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

afterEach(() => vi.restoreAllMocks());

describe("first-party provider feasibility probe", () => {
  it("is unavailable without the dedicated bearer secret", async () => {
    const missing = await SELF.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(input),
    });
    const wrong = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
      body: JSON.stringify(input),
    });

    expect(missing.status).toBe(404);
    expect(wrong.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found." });
  });

  it("reports only statuses and timings, cleans up the torrent, and never exposes provider data", async () => {
    const providers = mockedProviders();
    const result = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
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
    expect(serialized).not.toContain("test-only-real-debrid-token");
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
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("https://download.real-debrid.test/media-file");
    expect(result.headers.get("server-timing")).toMatch(/^real-debrid;dur=\d+$/);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).toBe("");
  });

  it("records a discovery rejection without retaining its response body", async () => {
    const providers = mockedProviders();
    providers.mockImplementationOnce(async () => response({ sensitive: "provider-body" }, 403));
    const result = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const report = await result.json<{
      success: boolean;
      discovery: { zilean: { status: number; reachable: boolean } };
    }>();

    expect(report.success).toBe(false);
    expect(report.discovery.zilean).toMatchObject({ status: 403, reachable: false });
    expect(JSON.stringify(report)).not.toContain("provider-body");
  });
});
