import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  qualityFromRelease,
  rankCandidates,
  releaseMatchesEpisode,
  selectCachedStream,
  type DiscoveryCandidate,
} from "../src/stream-selection";

beforeEach(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY NOT NULL,
    secret TEXT UNIQUE NOT NULL,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS approved_programmes (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    imdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    title TEXT NOT NULL,
    release_info TEXT,
    genres_json TEXT NOT NULL DEFAULT '[]',
    approved_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS show_episodes (
    programme_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT NOT NULL,
    released_at TEXT NOT NULL,
    PRIMARY KEY (programme_id, video_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_selections (
    household_id TEXT NOT NULL,
    programme_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    video_id TEXT NOT NULL,
    torrent_id TEXT NOT NULL,
    info_hash TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    quality TEXT NOT NULL,
    seeders INTEGER NOT NULL,
    selected_at TEXT NOT NULL,
    stale_at TEXT NOT NULL,
    PRIMARY KEY (household_id, content_type, video_id)
  )`).run();
  await env.DB.prepare("DELETE FROM stream_selections").run();
  await env.DB.prepare("DELETE FROM show_episodes").run();
  await env.DB.prepare("DELETE FROM approved_programmes").run();
  await env.DB.prepare("DELETE FROM households").run();
  vi.restoreAllMocks();
});

describe("stream candidate parsing and ranking", () => {
  it("recognises common episode and quality forms", () => {
    expect(releaseMatchesEpisode("Example.Show.S02E03.1080p.WEB-DL.mkv", 2, 3)).toBe(true);
    expect(releaseMatchesEpisode("Example Show 2x03 720p", 2, 3)).toBe(true);
    expect(releaseMatchesEpisode("Example.Show.S02E04.1080p.WEB-DL.mkv", 2, 3)).toBe(false);
    expect(qualityFromRelease("Example.Show.2160p.UHD")).toBe("2160p");
    expect(qualityFromRelease("Example.Show.1080i.HDTV")).toBe("1080p");
  });

  it("deduplicates hashes and ranks 1080p before seed count with deterministic ties", () => {
    const candidates: DiscoveryCandidate[] = [
      { infoHash: "a".repeat(40), magnet: "magnet:a", title: "720 release", quality: "720p", seeders: 500 },
      { infoHash: "b".repeat(40), magnet: "magnet:b", title: "1080 release", quality: "1080p", seeders: 2 },
      { infoHash: "b".repeat(40), magnet: "magnet:b-long", title: "1080 release", quality: "1080p", seeders: 30 },
      { infoHash: "c".repeat(40), magnet: "magnet:c", title: "4K release", quality: "2160p", seeders: 200 },
    ];

    expect(rankCandidates(candidates).map(({ infoHash, seeders }) => ({ infoHash, seeders }))).toEqual([
      { infoHash: "b".repeat(40), seeders: 30 },
      { infoHash: "c".repeat(40), seeders: 200 },
      { infoHash: "a".repeat(40), seeders: 500 },
    ]);
  });

  it("preserves provider relevance when quality and seed count tie", () => {
    const firstProviderResult: DiscoveryCandidate = {
      infoHash: "a".repeat(40),
      magnet: "magnet:a",
      title: "Zulu release",
      quality: "1080p",
      seeders: 0,
      providerRank: 0,
    };
    const laterAlphabeticalResult: DiscoveryCandidate = {
      infoHash: "b".repeat(40),
      magnet: "magnet:b",
      title: "Alpha release",
      quality: "1080p",
      seeders: 0,
      providerRank: 20,
    };

    expect(rankCandidates([laterAlphabeticalResult, firstProviderResult]))
      .toEqual([firstProviderResult, laterAlphabeticalResult]);
  });
});

describe("cached stream selection", () => {
  it("tries ranked candidates until RD confirms one cached, chooses the exact episode file, and reuses D1", async () => {
    await env.DB.prepare(`INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
      VALUES ('household', 'secret', 'salt', 'hash', 'now')`).run();
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, release_info, genres_json, approved_at)
      VALUES ('programme', 'household', 'tt1234567', 'show', 'Example Show', '2024', '[]', 'now')`).run();
    await env.DB.prepare(`INSERT INTO show_episodes
      (programme_id, video_id, season, episode, title, released_at)
      VALUES ('programme', 'tt1234567:1:2', 1, 2, 'Second', '2024-01-01')`).run();

    const uncachedHashes = ["c", "d", "e", "f", "1", "2"].map((value) => value.repeat(40));
    const cachedHash = "b".repeat(40);
    const selected = new Set<string>();
    const added: string[] = [];
    const deleted: string[] = [];
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "zilean.test") {
        return Response.json([
          {
            raw_title: "Example.Show.S01E02.1080p.WEB-DL",
            info_hash: cachedHash,
            resolution: "1080p",
            seasons: [1],
            episodes: [2],
          },
        ]);
      }
      if (url.hostname === "knaben.test") {
        return Response.json({
          hits: [
            ...uncachedHashes.map((hash, index) => ({
              title: "Example.Show.2024.S01E02.1080p.BluRay",
              hash,
              magnetUrl: `magnet:?xt=urn:btih:${hash}`,
              seeders: 100 - index,
            })),
            {
              title: "Example.Show.2024.S01E02.1080p.WEB-DL",
              hash: "9".repeat(40),
              magnetUrl: `magnet:?xt=urn:btih:${"9".repeat(40)}`,
              seeders: 0,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/torrents/addMagnet")) {
        const magnet = (init?.body as URLSearchParams).get("magnet")!;
        const hash = new URL(magnet).searchParams.get("xt")!.split(":").at(-1)!;
        if (hash === cachedHash) {
          expect(magnet).toMatch(/^magnet:\?xt=urn:btih:[a-f0-9]{40}&dn=/);
        }
        added.push(hash);
        return Response.json({ id: `torrent-${hash}` });
      }
      const infoMatch = url.pathname.match(/\/torrents\/info\/torrent-(.+)$/);
      if (infoMatch) {
        const hash = infoMatch[1];
        if (selected.has(hash) && hash !== cachedHash) {
          return Response.json({ status: "dead", files: [], links: [] });
        }
        return Response.json({
          status: selected.has(hash) ? "downloaded" : "waiting_files_selection",
          files: [
            { id: 1, path: "/Example.Show.S01E01.1080p.mkv", bytes: 2_000 },
            { id: 2, path: "/Example.Show.S01E02.1080p.mkv", bytes: 1_000 },
          ],
          links: selected.has(hash) ? ["https://restricted.test/file"] : [],
        });
      }
      const selectMatch = url.pathname.match(/\/torrents\/selectFiles\/torrent-(.+)$/);
      if (selectMatch) {
        expect((init?.body as URLSearchParams).get("files")).toBe("2");
        selected.add(selectMatch[1]);
        return new Response(null, { status: 204 });
      }
      const deleteMatch = url.pathname.match(/\/torrents\/delete\/torrent-(.+)$/);
      if (deleteMatch) {
        deleted.push(deleteMatch[1]);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const selection = await selectCachedStream(
      env.DB,
      "household",
      "series",
      "tt1234567:1:2",
      "rd-token",
      {
        ZILEAN_ORIGIN: "https://zilean.test",
        KNABEN_ORIGIN: "https://knaben.test",
        REAL_DEBRID_ORIGIN: "https://real-debrid.test/rest/1.0",
      },
      new Date("2026-07-30T00:00:00.000Z"),
    );

    expect(added).toEqual([...uncachedHashes, cachedHash]);
    expect(deleted).toEqual(uncachedHashes);
    expect(warnings).toHaveBeenCalledTimes(uncachedHashes.length);
    expect(selection).toMatchObject({
      torrentId: `torrent-${cachedHash}`,
      infoHash: cachedHash,
      fileId: 2,
      filename: "Example.Show.S01E02.1080p.mkv",
      quality: "1080p",
      seeders: 0,
    });
    expect(await env.DB.prepare("SELECT * FROM stream_selections").first()).toMatchObject({
      torrent_id: `torrent-${cachedHash}`,
      video_id: "tt1234567:1:2",
      file_id: 2,
    });

    const requestCount = outbound.mock.calls.length;
    expect(await selectCachedStream(
      env.DB,
      "household",
      "series",
      "tt1234567:1:2",
      "rd-token",
      {
        ZILEAN_ORIGIN: "https://zilean.test",
        KNABEN_ORIGIN: "https://knaben.test",
        REAL_DEBRID_ORIGIN: "https://real-debrid.test/rest/1.0",
      },
      new Date("2026-07-30T01:00:00.000Z"),
    )).toEqual(selection);
    expect(outbound).toHaveBeenCalledTimes(requestCount);
  });
});
