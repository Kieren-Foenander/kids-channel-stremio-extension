import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  qualityFromRelease,
  rankCandidates,
  releaseMatchesEpisode,
  selectCachedStream,
  type DiscoveryCandidate,
} from "../src/stream-selection";
import { tvPreparationOutcomeMessage } from "../src/tv-preparation";

const selectionEnv = {
  ZILEAN_ORIGIN: "https://zilean.test",
  KNABEN_ORIGIN: "https://knaben.test",
  TORBOX_ORIGIN: "https://torbox.test/v1/api",
};

function torBox(data: unknown, success = true): Response {
  return Response.json(success ? { success: true, data } : data);
}

function magnetHash(init?: RequestInit): string {
  const magnet = (init?.body as FormData).get("magnet");
  if (typeof magnet !== "string") throw new Error("missing magnet");
  return new URL(magnet).searchParams.get("xt")!.split(":").at(-1)!;
}

function torrent(id: number, hash: string, files: Array<{ id: number; name: string; size: number }>, ready: boolean, progress = 0) {
  return {
    id,
    hash,
    download_state: ready ? "cached" : "downloading",
    download_present: ready,
    download_finished: ready,
    progress,
    download_speed: 0,
    seeds: 0,
    files,
  };
}

beforeEach(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY NOT NULL, secret TEXT UNIQUE NOT NULL, pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS approved_programmes (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, imdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, poster TEXT, background TEXT,
    release_info TEXT, genres_json TEXT NOT NULL DEFAULT '[]', imdb_rating TEXT, approved_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_shows (
    imdb_id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT, poster TEXT,
    background TEXT, release_info TEXT, genres_json TEXT NOT NULL DEFAULT '[]', imdb_rating TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_show_episodes (
    show_imdb_id TEXT NOT NULL, video_id TEXT NOT NULL, season INTEGER NOT NULL,
    episode INTEGER NOT NULL, title TEXT NOT NULL, released_at TEXT NOT NULL, overview TEXT,
    PRIMARY KEY (show_imdb_id, video_id)
  )`).run();
  await env.DB.prepare(`CREATE VIEW IF NOT EXISTS show_episodes AS
    SELECT programme.id AS programme_id, episode.video_id, episode.season, episode.episode,
      episode.title, episode.released_at, episode.overview
    FROM approved_programmes programme
    JOIN canonical_show_episodes episode ON episode.show_imdb_id = programme.imdb_id
    WHERE programme.content_type = 'show'`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS approved_show_metadata_insert
    AFTER INSERT ON approved_programmes WHEN NEW.content_type = 'show' BEGIN
      INSERT INTO canonical_shows
        (imdb_id, title, description, poster, background, release_info, genres_json, imdb_rating)
      VALUES (NEW.imdb_id, NEW.title, NEW.description, NEW.poster, NEW.background,
        NEW.release_info, NEW.genres_json, NEW.imdb_rating)
      ON CONFLICT(imdb_id) DO UPDATE SET title = excluded.title, description = excluded.description,
        poster = excluded.poster, background = excluded.background, release_info = excluded.release_info,
        genres_json = excluded.genres_json, imdb_rating = excluded.imdb_rating;
      UPDATE approved_programmes SET title = '', description = NULL, poster = NULL, background = NULL,
        release_info = NULL, genres_json = '[]', imdb_rating = NULL WHERE id = NEW.id;
    END`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS show_episodes_insert
    INSTEAD OF INSERT ON show_episodes BEGIN
      INSERT INTO canonical_show_episodes
        (show_imdb_id, video_id, season, episode, title, released_at, overview)
      SELECT programme.imdb_id, NEW.video_id, NEW.season, NEW.episode,
        NEW.title, NEW.released_at, NEW.overview
      FROM approved_programmes programme WHERE programme.id = NEW.programme_id
      ON CONFLICT(show_imdb_id, video_id) DO UPDATE SET season = excluded.season,
        episode = excluded.episode, title = excluded.title, released_at = excluded.released_at,
        overview = excluded.overview;
    END`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_selections (
    household_id TEXT NOT NULL, programme_id TEXT NOT NULL, content_type TEXT NOT NULL,
    video_id TEXT NOT NULL, torrent_id TEXT NOT NULL, info_hash TEXT NOT NULL,
    file_id INTEGER NOT NULL, filename TEXT NOT NULL, quality TEXT NOT NULL,
    seeders INTEGER NOT NULL, selected_at TEXT NOT NULL, stale_at TEXT NOT NULL,
    download_pending INTEGER NOT NULL DEFAULT 0, last_progress REAL NOT NULL DEFAULT 0,
    last_progress_at TEXT, PRIMARY KEY (household_id, content_type, video_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_candidate_failures (
    household_id TEXT NOT NULL, programme_id TEXT NOT NULL, content_type TEXT NOT NULL,
    video_id TEXT NOT NULL, info_hash TEXT NOT NULL, reason TEXT NOT NULL,
    failed_at TEXT NOT NULL, retry_at TEXT NOT NULL,
    PRIMARY KEY (household_id, content_type, video_id, info_hash)
  )`).run();
  await env.DB.prepare("DELETE FROM stream_candidate_failures").run();
  await env.DB.prepare("DELETE FROM stream_selections").run();
  await env.DB.prepare("DELETE FROM approved_programmes").run();
  await env.DB.prepare("DELETE FROM canonical_show_episodes").run();
  await env.DB.prepare("DELETE FROM canonical_shows").run();
  await env.DB.prepare("DELETE FROM households").run();
  await env.DB.prepare(`INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
    VALUES ('household', 'secret', 'salt', 'hash', 'now')`).run();
  await env.DB.prepare(`INSERT INTO approved_programmes
    (id, household_id, imdb_id, content_type, title, release_info, genres_json, approved_at)
    VALUES ('programme', 'household', 'tt1234567', 'show', 'Example Show', '2024', '[]', 'now')`).run();
  await env.DB.prepare(`INSERT INTO show_episodes
    (programme_id, video_id, season, episode, title, released_at)
    VALUES ('programme', 'tt1234567:1:2', 1, 2, 'Second', '2024-01-01')`).run();
  vi.restoreAllMocks();
});

afterEach(() => vi.useRealTimers());

describe("stream candidate parsing and ranking", () => {
  it("recognises common episode and quality forms", () => {
    expect(releaseMatchesEpisode("Example.Show.S02E03.1080p.WEB-DL.mkv", 2, 3)).toBe(true);
    expect(releaseMatchesEpisode("Example Show 2x03 720p", 2, 3)).toBe(true);
    expect(releaseMatchesEpisode("Example.Show.S02E04.1080p.WEB-DL.mkv", 2, 3)).toBe(false);
    expect(qualityFromRelease("Example.Show.2160p.UHD")).toBe("2160p");
    expect(qualityFromRelease("Example.Show.1080i.HDTV")).toBe("1080p");
  });

  it("deduplicates hashes and ranks 1080p first with deterministic ties", () => {
    const candidates: DiscoveryCandidate[] = [
      { infoHash: "a".repeat(40), magnet: "magnet:a", title: "720", quality: "720p", seeders: 500 },
      { infoHash: "b".repeat(40), magnet: "magnet:b", title: "1080", quality: "1080p", seeders: 2 },
      { infoHash: "b".repeat(40), magnet: "magnet:b-long", title: "1080", quality: "1080p", seeders: 30 },
      { infoHash: "c".repeat(40), magnet: "magnet:c", title: "4K", quality: "2160p", seeders: 200 },
    ];
    expect(rankCandidates(candidates).map(({ infoHash, seeders }) => ({ infoHash, seeders }))).toEqual([
      { infoHash: "b".repeat(40), seeders: 30 },
      { infoHash: "c".repeat(40), seeders: 200 },
      { infoHash: "a".repeat(40), seeders: 500 },
    ]);
  });

  it("preserves provider relevance when quality and seed count tie", () => {
    const first: DiscoveryCandidate = { infoHash: "a".repeat(40), magnet: "magnet:a", title: "Zulu", quality: "1080p", seeders: 0, providerRank: 0 };
    const later: DiscoveryCandidate = { infoHash: "b".repeat(40), magnet: "magnet:b", title: "Alpha", quality: "1080p", seeders: 0, providerRank: 20 };
    expect(rankCandidates([later, first])).toEqual([first, later]);
  });
});

describe("Preparation Run source reporting", () => {
  it("distinguishes missing, rejected, and temporarily unavailable sources", () => {
    expect(tvPreparationOutcomeMessage({ status: "no_candidates", candidateCount: 0 })).toContain("No matching torrent sources");
    expect(tvPreparationOutcomeMessage({ status: "candidate_rejected", candidateCount: 2, reason: "file_mismatch" })).toContain("next round will try another");
    expect(tvPreparationOutcomeMessage({ status: "temporarily_unavailable", candidateCount: 1 })).toContain("could not inspect");
  });
});

describe("TorBox stream selection", () => {
  it("accepts a cached season pack, selects the exact episode, and reuses D1", async () => {
    const hash = "a".repeat(40);
    let creates = 0;
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "zilean.test") return Response.json([{ raw_title: "Example Show S01 1080p", info_hash: hash, resolution: "1080p", seasons: [1], episodes: [] }]);
      if (url.hostname === "knaben.test") return Response.json({ hits: [] });
      if (url.pathname.endsWith("/torrents/createtorrent")) {
        creates += 1;
        expect((init?.body as FormData).get("add_only_if_cached")).toBe("true");
        return torBox({ torrent_id: 41 });
      }
      if (url.pathname.endsWith("/torrents/mylist")) return torBox(torrent(41, hash, [
        { id: 1, name: "/Example.Show.S01E01.mkv", size: 1_000 },
        { id: 2, name: "/Example.Show.S01E02.mkv", size: 1_000 },
      ], true));
      throw new Error(`unexpected request ${url}`);
    });

    const selection = await selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv);
    expect(selection).toMatchObject({ torrentId: "41", infoHash: hash, fileId: 2, filename: "Example.Show.S01E02.mkv" });
    const requestCount = outbound.mock.calls.length;
    expect(await selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv)).toEqual(selection);
    expect(outbound).toHaveBeenCalledTimes(requestCount);
    expect(creates).toBe(1);
  });

  it("quarantines a cached torrent with no exact episode and tries the next candidate", async () => {
    const firstHash = "a".repeat(40);
    const secondHash = "b".repeat(40);
    const created: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "zilean.test") return Response.json([
        { raw_title: "Example.Show.S01E02.1080p", info_hash: firstHash, resolution: "1080p", seasons: [1], episodes: [2] },
        { raw_title: "Example.Show.S01E02.720p", info_hash: secondHash, resolution: "720p", seasons: [1], episodes: [2] },
      ]);
      if (url.hostname === "knaben.test") return Response.json({ hits: [] });
      if (url.pathname.endsWith("/torrents/createtorrent")) {
        const hash = magnetHash(init);
        created.push(hash);
        return torBox({ torrent_id: hash === firstHash ? 51 : 52 });
      }
      if (url.pathname.endsWith("/torrents/mylist")) {
        const id = Number(url.searchParams.get("id"));
        const hash = id === 51 ? firstHash : secondHash;
        const episode = id === 51 ? "E01" : "E02";
        return torBox(torrent(id, hash, [{ id: 2, name: `/Example.Show.S01${episode}.mkv`, size: 1_000 }], true));
      }
      if (url.pathname.endsWith("/torrents/controltorrent")) return torBox(true);
      throw new Error(`unexpected request ${url}`);
    });

    const selection = await selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv);
    expect(selection).toMatchObject({ torrentId: "52", infoHash: secondHash });
    expect(created).toEqual([firstHash, secondHash]);
    expect(await env.DB.prepare("SELECT info_hash, reason FROM stream_candidate_failures").first())
      .toMatchObject({ info_hash: firstHash, reason: "file_mismatch" });
  });

  it("falls back from cached-only checks to one download and promotes it when ready", async () => {
    const hash = "a".repeat(40);
    let downloaded = false;
    let progress = 0;
    let uncachedCreates = 0;
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "zilean.test") return Response.json([{ raw_title: "Example.Show.S01E02.1080p", info_hash: hash, resolution: "1080p", seasons: [1], episodes: [2] }]);
      if (url.hostname === "knaben.test") return Response.json({ hits: [] });
      if (url.pathname.endsWith("/torrents/createtorrent")) {
        const cachedOnly = (init?.body as FormData).get("add_only_if_cached") === "true";
        if (cachedOnly) return torBox({ success: false, error: "TORRENT_NOT_CACHED", detail: "Torrent is not cached" }, false);
        uncachedCreates += 1;
        return torBox({ torrent_id: 61 });
      }
      if (url.pathname.endsWith("/torrents/mylist")) return torBox(torrent(61, hash, [
        { id: 2, name: "/Example.Show.S01E02.mkv", size: 1_000 },
      ], downloaded, progress));
      throw new Error(`unexpected request ${url}`);
    });

    const first = selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await first).toBeNull();
    expect(await env.DB.prepare("SELECT torrent_id, download_pending FROM stream_selections").first())
      .toMatchObject({ torrent_id: "61", download_pending: 1 });

    progress = 25;
    expect(await selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv, new Date(Date.now() + 60_000))).toBeNull();
    downloaded = true;
    expect(await selectCachedStream(env.DB, "household", "series", "tt1234567:1:2", "tb-token", selectionEnv, new Date(Date.now() + 120_000)))
      .toMatchObject({ torrentId: "61", fileId: 2 });
    expect(uncachedCreates).toBe(1);
  });
});
