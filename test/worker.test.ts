import { env, SELF as worker } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeTorBoxCredential } from "../src/torbox-credentials";
import { reconcileMovieChannel } from "../src/movie-channel";
import { issueStreamToken } from "../src/secrets";
import { deleteHousehold } from "../src/households";
import { CHANNEL_RETENTION, pruneObsoleteChannelState } from "../src/channel-retention";
import {
  cancelTvPreparationRun,
  createTvPreparationRun,
  ensureAutomaticTvPreparation,
  tvPreparationRun,
} from "../src/tv-preparation";
import { refreshTvChannelSchedule, requestTvProgramme, tvChannelSchedule } from "../src/tv-channel";
import { APPROVED_LIBRARY_SQL } from "../src/approved-library";

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
    auth_version INTEGER NOT NULL DEFAULT 1,
    real_debrid_token_ciphertext TEXT,
    real_debrid_token_iv TEXT,
    real_debrid_token_updated_at TEXT,
    torbox_token_ciphertext TEXT,
    torbox_token_iv TEXT,
    torbox_token_updated_at TEXT
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
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, channel_type TEXT NOT NULL,
    name TEXT NOT NULL, legacy_key TEXT, created_at TEXT NOT NULL,
    UNIQUE (household_id, legacy_key)
  )`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS channels_limit_insert
    BEFORE INSERT ON channels
    WHEN (SELECT COUNT(*) FROM channels WHERE household_id = NEW.household_id
      AND channel_type = NEW.channel_type) >= 5
    BEGIN SELECT RAISE(ABORT, 'channel type limit reached'); END`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_assignments (
    channel_id TEXT NOT NULL, programme_id TEXT NOT NULL, next_video_id TEXT,
    paused_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY (channel_id, programme_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_shows (
    imdb_id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT, poster TEXT,
    background TEXT, release_info TEXT, genres_json TEXT NOT NULL DEFAULT '[]', imdb_rating TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_show_episodes (
    show_imdb_id TEXT NOT NULL, video_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
    title TEXT NOT NULL, released_at TEXT NOT NULL, overview TEXT,
    PRIMARY KEY (show_imdb_id, video_id), UNIQUE (show_imdb_id, season, episode)
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
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS show_episodes_update
    INSTEAD OF UPDATE ON show_episodes BEGIN
      UPDATE canonical_show_episodes SET video_id = NEW.video_id, season = NEW.season,
        episode = NEW.episode, title = NEW.title, released_at = NEW.released_at, overview = NEW.overview
      WHERE show_imdb_id = (SELECT imdb_id FROM approved_programmes WHERE id = OLD.programme_id)
        AND video_id = OLD.video_id;
    END`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS show_episodes_delete
    INSTEAD OF DELETE ON show_episodes BEGIN SELECT 1; END`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS current_programmes (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, programme_id TEXT NOT NULL,
    video_id TEXT NOT NULL, selected_at TEXT NOT NULL, PRIMARY KEY (channel_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_state (
    household_id TEXT NOT NULL, channel_id TEXT PRIMARY KEY NOT NULL, current_position INTEGER NOT NULL,
    selection_seed TEXT NOT NULL, initialized_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_schedule (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, position INTEGER NOT NULL,
    programme_id TEXT NOT NULL, video_id TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, position)
  )`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS channel_schedule_video_idx
    ON channel_schedule (channel_id, video_id)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_advancements (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, from_position INTEGER NOT NULL,
    target_position INTEGER NOT NULL, owner_token TEXT NOT NULL, advanced_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, from_position)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_advancement_history (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, channel_id TEXT NOT NULL, from_position INTEGER NOT NULL,
    target_position INTEGER NOT NULL, previous_programme_id TEXT NOT NULL, previous_video_id TEXT NOT NULL,
    target_programme_id TEXT NOT NULL, target_video_id TEXT NOT NULL, progress_before_json TEXT NOT NULL,
    progress_after_json TEXT NOT NULL, advanced_at TEXT NOT NULL, undone_at TEXT, undo_owner_token TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_channel_state (
    household_id TEXT NOT NULL, channel_id TEXT PRIMARY KEY NOT NULL, cycle INTEGER NOT NULL, current_position INTEGER NOT NULL,
    selection_seed TEXT NOT NULL, initialized_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_rotation (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    programme_id TEXT NOT NULL, consumed_at TEXT,
    PRIMARY KEY (channel_id, cycle, position), UNIQUE (channel_id, cycle, programme_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_advancements (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    owner_token TEXT NOT NULL, advanced_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, cycle, position)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_channel_mutations (
    household_id TEXT NOT NULL, channel_id TEXT NOT NULL, revision INTEGER NOT NULL,
    owner_token TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (channel_id, revision)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS movie_playback_history (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, channel_id TEXT NOT NULL, programme_id TEXT NOT NULL,
    imdb_id TEXT NOT NULL, title TEXT NOT NULL, cycle INTEGER NOT NULL, position INTEGER NOT NULL,
    played_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_selections (
    household_id TEXT NOT NULL, programme_id TEXT NOT NULL, content_type TEXT NOT NULL, video_id TEXT NOT NULL,
    torrent_id TEXT NOT NULL, info_hash TEXT NOT NULL, file_id INTEGER NOT NULL, filename TEXT NOT NULL,
    quality TEXT NOT NULL, seeders INTEGER NOT NULL, selected_at TEXT NOT NULL, stale_at TEXT NOT NULL,
    download_pending INTEGER NOT NULL DEFAULT 0,
    last_progress REAL NOT NULL DEFAULT 0, last_progress_at TEXT,
    PRIMARY KEY (household_id, content_type, video_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stream_candidate_failures (
    household_id TEXT NOT NULL, programme_id TEXT NOT NULL, content_type TEXT NOT NULL,
    video_id TEXT NOT NULL, info_hash TEXT NOT NULL,
    reason TEXT NOT NULL, failed_at TEXT NOT NULL, retry_at TEXT NOT NULL,
    PRIMARY KEY (household_id, content_type, video_id, info_hash)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS unavailable_episodes (
    household_id TEXT NOT NULL, programme_id TEXT NOT NULL, video_id TEXT NOT NULL,
    unavailable_at TEXT NOT NULL, retry_at TEXT NOT NULL,
    PRIMARY KEY (household_id, video_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_preparation_runs (
    id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, status TEXT NOT NULL,
    requested_count INTEGER NOT NULL, started_at TEXT, deadline_at TEXT NOT NULL,
    completed_at TEXT, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS tv_preparation_runs_active_household_idx
    ON tv_preparation_runs (household_id) WHERE status IN ('queued', 'running')`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_preparation_items (
    run_id TEXT NOT NULL, channel_id TEXT NOT NULL, position INTEGER NOT NULL, programme_id TEXT NOT NULL, video_id TEXT NOT NULL,
    show_title TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, episode_title TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, quality TEXT, filename TEXT, info_hash TEXT,
    message TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, channel_id, position)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_cursors (
    name TEXT PRIMARY KEY NOT NULL, last_household_id TEXT, updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS households_secret_idx ON households (secret)").run();
  await env.DB.prepare("DELETE FROM pin_attempts").run();
  await env.DB.prepare("DELETE FROM maintenance_cursors").run();
  await env.DB.prepare("DELETE FROM tv_preparation_items").run();
  await env.DB.prepare("DELETE FROM tv_preparation_runs").run();
  await env.DB.prepare("DELETE FROM unavailable_episodes").run();
  await env.DB.prepare("DELETE FROM stream_candidate_failures").run();
  await env.DB.prepare("DELETE FROM stream_selections").run();
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
  await env.DB.prepare("DELETE FROM channel_assignments").run();
  await env.DB.prepare("DELETE FROM approved_programmes").run();
  await env.DB.prepare("DELETE FROM canonical_show_episodes").run();
  await env.DB.prepare("DELETE FROM canonical_shows").run();
  await env.DB.prepare("DELETE FROM channels").run();
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

async function defaultChannelId(created: CreatedHousehold, type: "tv" | "movie"): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM channels WHERE household_id = ? AND legacy_key = ?")
    .bind(created.householdId, type).first<{ id: string }>();
  if (!row) throw new Error(`default ${type} channel was not provisioned`);
  return row.id;
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
  it("serves the hardened SPA shell and rejects any PIN other than six digits", async () => {
    const page = await SELF.fetch("https://kids.test/");
    expect(page.status).toBe(200);
    const shell = await page.text();
    expect(shell).toMatch(/<link[^>]+href="\/assets\/[^\"]+\.css"/);
    expect(shell).toMatch(/<script[^>]+src="\/assets\/[^\"]+\.js"/);
    expect(shell).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(shell).not.toContain("<style");
    const csp = page.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' https: data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

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

    const parentPage = await SELF.fetch(`${created.parentUrl}/settings`);
    expect(parentPage.status).toBe(200);
    const parentHtml = await parentPage.text();
    expect(parentHtml).toMatch(/<script[^>]+src="\/assets\/[^\"]+\.js"/);
    expect(parentHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(parentHtml).not.toContain("unlock-form");
    expect(parentPage.headers.get("content-security-policy")).not.toContain("unsafe-inline");

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

    const malformed = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
      method: "PUT", headers: { ...oldSession, "content-type": "application/json" },
      body: JSON.stringify({ currentPin: "12345", newPin: "654321" }),
    });
    expect(malformed.status).toBe(400);

    const reused = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
      method: "PUT", headers: { ...oldSession, "content-type": "application/json" },
      body: JSON.stringify({ currentPin: "123456", newPin: "123456" }),
    });
    expect(reused.status).toBe(400);

    const denied = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
      method: "PUT", headers: { ...oldSession, "content-type": "application/json" },
      body: JSON.stringify({ currentPin: "000000", newPin: "654321" }),
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("000000");

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

    let limited: Response | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limited = await SELF.fetch(`https://kids.test/api/households/${secret}/pin`, {
        method: "PUT",
        headers: { ...newSession, "content-type": "application/json", "cf-connecting-ip": "192.0.2.44" },
        body: JSON.stringify({ currentPin: "000000", newPin: "111111" }),
      });
    }
    expect(limited?.status).toBe(429);
    expect(await limited?.text()).not.toContain("000000");
  });
});

describe("Household TorBox credential", () => {
  async function access(created: CreatedHousehold) {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
    return sessionHeaders(response);
  }

  it("validates and encrypts the Parent-supplied token without ever returning it", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const session = await access(created);
    const token = "household-torbox-token";
    const torBox = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/v1/api/user/me");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ success: true, data: { id: 123, username: "parent" } });
    });

    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/torbox`)).status).toBe(401);
    const saved = await SELF.fetch(`https://kids.test/api/households/${secret}/torbox`, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const savedBody = await saved.json<Record<string, unknown>>();

    expect(saved.status).toBe(200);
    expect(savedBody).toMatchObject({ configured: true, updatedAt: expect.any(String) });
    expect(savedBody).not.toHaveProperty("token");
    expect(JSON.stringify(savedBody)).not.toContain(token);
    expect(torBox).toHaveBeenCalledOnce();

    const stored = await env.DB.prepare(`SELECT torbox_token_ciphertext, torbox_token_iv
      FROM households WHERE id = ?`).bind(created.householdId).first<{
        torbox_token_ciphertext: string;
        torbox_token_iv: string;
      }>();
    expect(stored?.torbox_token_ciphertext).toBeTruthy();
    expect(stored?.torbox_token_iv).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(token);

    const status = await SELF.fetch(`https://kids.test/api/households/${secret}/torbox`, { headers: session });
    const statusText = await status.clone().text();
    expect(await status.json()).toMatchObject({ configured: true, updatedAt: savedBody.updatedAt });
    expect(statusText).not.toContain(token);
  });

  it("reports invalid or unavailable tokens honestly and leaves the previous credential unchanged", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const session = await access(created);
    const endpoint = `https://kids.test/api/households/${secret}/torbox`;

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "bad_token" }, { status: 401 }));
    const invalid = await SELF.fetch(endpoint, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ token: "invalid-token" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "TorBox rejected this token. Check it and try again." });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("provider unavailable"));
    const unavailable = await SELF.fetch(endpoint, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ token: "unvalidated-token" }),
    });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: "TorBox could not validate this token right now. Nothing was saved." });
    expect(await env.DB.prepare("SELECT torbox_token_ciphertext FROM households WHERE id = ?")
      .bind(created.householdId).first()).toMatchObject({ torbox_token_ciphertext: null });
  });

  it("clears only the Household credential and reports the resulting playback state", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const session = await access(created);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, data: { id: 123 } }));
    await SELF.fetch(`https://kids.test/api/households/${secret}/torbox`, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ token: "token-to-clear" }),
    });

    const cleared = await SELF.fetch(`https://kids.test/api/households/${secret}/torbox`, {
      method: "DELETE",
      headers: session,
    });
    const body = await cleared.json<Record<string, unknown>>();
    expect(body).toMatchObject({ configured: false, updatedAt: null });
    expect(body.message).toContain("playback is unavailable");
    expect(await env.DB.prepare(`SELECT torbox_token_ciphertext, torbox_token_iv, torbox_token_updated_at
      FROM households WHERE id = ?`).bind(created.householdId).first()).toEqual({
      torbox_token_ciphertext: null,
      torbox_token_iv: null,
      torbox_token_updated_at: null,
    });
  });
});

describe("Household Overview summary", () => {
  async function access(created: CreatedHousehold) {
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    return sessionHeaders(response);
  }

  it("returns compact counts, both Current Programmes, and no more than two upcoming TV programmes", async () => {
    const populated = await create();
    const isolated = await create();
    const tvChannelId = await defaultChannelId(populated, "tv");
    const movieChannelId = await defaultChannelId(populated, "movie");
    const approvedAt = "2024-01-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, poster, release_info, genres_json, approved_at)
        VALUES ('overview-show', ?, 'tt1000001', 'show', 'Overview Show', 'https://images.example/show.jpg', '2024', '[]', ?)`)
        .bind(populated.householdId, approvedAt),
      env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, poster, release_info, genres_json, approved_at)
        VALUES ('overview-movie', ?, 'tt1000002', 'movie', 'Overview Movie', 'https://images.example/movie.jpg', '2023', '[]', ?)`)
        .bind(populated.householdId, approvedAt),
      ...[1, 2, 3].map((episode) => env.DB.prepare(`INSERT INTO show_episodes
        (programme_id, video_id, season, episode, title, released_at)
        VALUES ('overview-show', ?, 1, ?, ?, '2024-01-01T00:00:00.000Z')`)
        .bind(`tt1000001:1:${episode}`, episode, `Episode ${episode}`)),
      env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, next_video_id, created_at)
        VALUES (?, 'overview-show', 'tt1000001:1:1', ?)`).bind(tvChannelId, approvedAt),
      env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, created_at) VALUES (?, 'overview-movie', ?)`)
        .bind(movieChannelId, approvedAt),
    ]);

    const denied = await SELF.fetch(`https://kids.test/api/households/${secretFrom(populated)}/overview`);
    expect(denied.status).toBe(401);

    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(populated)}/overview`, { headers: await access(populated) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const summary = await response.json<any>();
    expect(summary.approved).toEqual({ shows: 1, movies: 1 });
    expect(summary.tvChannels[0].current).toMatchObject({ title: "Overview Show", episode: { id: "tt1000001:1:1", title: "Episode 1" } });
    expect(summary.tvChannels[0].next.map((item: any) => item.episode.id)).toEqual(["tt1000001:1:2", "tt1000001:1:3"]);
    expect(summary.tvChannels[0].next).toHaveLength(2);
    expect(summary.movieChannels[0].current).toMatchObject({ title: "Overview Movie", releaseInfo: "2023" });
    expect(summary.tvChannels[0].current).not.toHaveProperty("description");
    expect(summary.movieChannels[0].current).not.toHaveProperty("signOffId");

    const scheduleBefore = await env.DB.prepare(`SELECT position, programme_id, video_id, scheduled_at
      FROM channel_schedule WHERE household_id = ? AND channel_id = ? ORDER BY position`)
      .bind(populated.householdId, tvChannelId).all();
    const currentBefore = await env.DB.prepare(`SELECT programme_id, video_id, selected_at
      FROM current_programmes WHERE household_id = ? AND channel_id = ?`)
      .bind(populated.householdId, tvChannelId).first();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const repeated = await SELF.fetch(`https://kids.test/api/households/${secretFrom(populated)}/overview`, {
      headers: await access(populated),
    });
    expect(repeated.status).toBe(200);
    expect((await env.DB.prepare(`SELECT position, programme_id, video_id, scheduled_at
      FROM channel_schedule WHERE household_id = ? AND channel_id = ? ORDER BY position`)
      .bind(populated.householdId, tvChannelId).all()).results).toEqual(scheduleBefore.results);
    expect(await env.DB.prepare(`SELECT programme_id, video_id, selected_at
      FROM current_programmes WHERE household_id = ? AND channel_id = ?`)
      .bind(populated.householdId, tvChannelId).first()).toEqual(currentBefore);

    const isolatedSummary = await (await SELF.fetch(
      `https://kids.test/api/households/${secretFrom(isolated)}/overview`,
      { headers: await access(isolated) },
    )).json<any>();
    expect(isolatedSummary).toEqual({
      approved: { shows: 0, movies: 0 },
      tvChannels: [{ id: expect.any(String), name: "TV Channel", current: null, next: [] }],
      movieChannels: [{ id: expect.any(String), name: "Movie Channel", current: null }],
    });
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

  it("looks up Show Progress without materializing every Household's episodes", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${APPROVED_LIBRARY_SQL}`)
      .bind("query-plan-household").all<{ detail: string }>();

    expect(plan.results.map((row) => row.detail)).not.toContain("MATERIALIZE show_episodes");
    expect(plan.results.every((row) => !row.detail.includes("canonical_show_episodes"))).toBe(true);
  });

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
    expect(body.results.every((result: Record<string, unknown>) => !("episodes" in result) && !("videos" in result))).toBe(true);
  });

  it("loads only regular released show episodes from the on-demand title endpoint", async () => {
    const created = await create();
    const headers = await parentAccess(created);
    mockCinemeta();

    const response = await SELF.fetch(
      `https://kids.test/api/households/${secretFrom(created)}/cinemeta/title/show/tt1234567`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.json<any>();
    expect(body.title).toMatchObject({ id: "tt1234567", type: "show", title: "The Example" });
    expect(body.title.episodes).toEqual([
      expect.objectContaining({ id: "tt1234567:1:1", season: 1, episode: 1, title: "First", released: "2020-01-01T00:00:00.000Z" }),
      expect.objectContaining({ id: "tt1234567:1:2", season: 1, episode: 2, title: "Second", released: "2020-01-08T00:00:00.000Z" }),
    ]);
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
    expect(library.programmes[0]).toMatchObject({
      imdbId: "tt1234567", type: "show", current: true, finished: false,
      showProgress: { id: "tt1234567:1:1", season: 1, episode: 1, title: "First" },
    });
    expect(library.programmes[0]).not.toHaveProperty("episodes");
    expect(library.programmes[0]).not.toHaveProperty("description");
    expect(library.programmes[0]).not.toHaveProperty("background");
    expect(JSON.stringify(library.programmes[0])).not.toContain("Second");
  });

  it("shares canonical show metadata across Households and preserves it when one Household is deleted", async () => {
    const first = await create();
    const second = await create();
    const firstHeaders = await parentAccess(first);
    const secondHeaders = await parentAccess(second);
    mockCinemeta();

    const firstApproval = await SELF.fetch(`https://kids.test/api/households/${secretFrom(first)}/library`, {
      method: "POST",
      headers: { ...firstHeaders, "content-type": "application/json" },
      body: JSON.stringify({ type: "show", imdbId: "tt1234567" }),
    });
    const secondApproval = await SELF.fetch(`https://kids.test/api/households/${secretFrom(second)}/library`, {
      method: "POST",
      headers: { ...secondHeaders, "content-type": "application/json" },
      body: JSON.stringify({ type: "show", imdbId: "tt1234567", startingEpisodeId: "tt1234567:1:2" }),
    });
    expect(firstApproval.status).toBe(201);
    expect(secondApproval.status).toBe(201);
    const secondProgrammeId = (await secondApproval.json<any>()).programme.id as string;

    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM canonical_shows").first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM canonical_show_episodes").first()).toMatchObject({ count: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM approved_programmes").first()).toMatchObject({ count: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM show_episodes").first()).toMatchObject({ count: 4 });

    const firstTvChannelId = await defaultChannelId(first, "tv");
    const secondTvChannelId = await defaultChannelId(second, "tv");
    await tvChannelSchedule(env.DB, first.householdId, firstTvChannelId, "first-household-seed");
    const secondSchedule = await tvChannelSchedule(env.DB, second.householdId, secondTvChannelId, "second-household-seed");
    expect(secondSchedule[0]).toMatchObject({
      programmeId: secondProgrammeId,
      showTitle: "The Example",
      episode: { id: "tt1234567:1:2", title: "Second" },
    });

    await deleteHousehold(env.DB, first.householdId);

    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM canonical_shows").first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM canonical_show_episodes").first()).toMatchObject({ count: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM approved_programmes").first()).toMatchObject({ count: 1 });
    const detail = await SELF.fetch(
      `https://kids.test/api/households/${secretFrom(second)}/library/${secondProgrammeId}`,
      { headers: secondHeaders },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json<any>()).toMatchObject({
      programme: {
        id: secondProgrammeId,
        title: "The Example",
        showProgress: { id: "tt1234567:1:2" },
        episodes: [
          { id: "tt1234567:1:1", title: "First" },
          { id: "tt1234567:1:2", title: "Second" },
        ],
      },
    });
    expect(await tvChannelSchedule(env.DB, second.householdId, secondTvChannelId, "second-household-seed"))
      .toEqual(secondSchedule);
  });

  it("loads an approved show's stored episode detail without consulting current Cinemeta metadata", async () => {
    const created = await create();
    const headers = await parentAccess(created);
    mockCinemeta();
    const approval = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "show", imdbId: "tt1234567" }),
    });
    const programmeId = (await approval.json<any>()).programme.id as string;

    await env.DB.prepare("UPDATE show_episodes SET title = 'Stored second' WHERE programme_id = ? AND video_id = 'tt1234567:1:2'")
      .bind(programmeId).run();
    vi.restoreAllMocks();
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cinemeta unavailable"));

    expect((await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/${programmeId}`)).status).toBe(401);
    const response = await SELF.fetch(`https://kids.test/api/households/${secretFrom(created)}/library/${programmeId}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json<any>()).toMatchObject({
      programme: {
        id: programmeId,
        imdbId: "tt1234567",
        type: "show",
        title: "The Example",
        episodes: [
          { id: "tt1234567:1:1", season: 1, episode: 1, title: "First", released: "2020-01-01T00:00:00.000Z" },
          { id: "tt1234567:1:2", season: 1, episode: 2, title: "Stored second", released: "2020-01-08T00:00:00.000Z" },
        ],
      },
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("accepts another valid starting episode and rejects specials, unreleased, and unknown episodes", async () => {
    mockCinemeta();
    const choices = ["", "tt1234567:0:1", "tt1234567:1:3", "tt1234567:9:9"];
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
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments").first()).toMatchObject({ next_video_id: canonicalEpisodeId });
    expect(await env.DB.prepare("SELECT video_id FROM current_programmes").first()).toMatchObject({ video_id: canonicalEpisodeId });
  });

  it("returns exactly one cached first-party stream and reuses its D1 selection", async () => {
    const created = await arrangePlayback();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    await storeTorBoxCredential(
      env.DB,
      created.householdId,
      "household-rd-token",
      env.CONFIG_SECRET,
    );
    vi.restoreAllMocks();

    const hash = "a".repeat(40);
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname.includes("zilean")) {
        return Response.json([{
          raw_title: "Playback.Show.S01E01.1080p.WEB-DL",
          info_hash: hash,
          resolution: "1080p",
          seasons: [1],
          episodes: [1],
        }]);
      }
      if (url.hostname.includes("knaben")) return Response.json({ hits: [] });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer household-rd-token");
      if (url.pathname.endsWith("/torrents/createtorrent")) {
        expect((init?.body as FormData).get("add_only_if_cached")).toBe("true");
        return Response.json({ success: true, data: { torrent_id: 71 } });
      }
      if (url.pathname.endsWith("/torrents/mylist")) return Response.json({ success: true, data: {
        id: 71,
        hash,
        download_state: "cached",
        download_present: true,
        download_finished: true,
        files: [{ id: 7, name: "/Playback.Show.S01E01.1080p.WEB-DL.mkv", size: 1_000 }],
      } });
      if (url.pathname.endsWith("/torrents/requestdl")) {
        expect(url.searchParams.get("token")).toBe("household-rd-token");
        expect(url.searchParams.get("file_id")).toBe("7");
        return Response.json({ success: true, data: "https://download.torbox.test/fresh-signed-media" });
      }
      throw new Error(`unexpected outbound request: ${url}`);
    });

    const streamUrl = `${base}/stream/series/${encodeURIComponent(canonicalEpisodeId)}.json`;
    const first = await SELF.fetch(streamUrl);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ streams: Array<{ url: string }> }>();
    expect(firstBody).toEqual({
      streams: [{
        name: "Kids Channels",
        description: "1080p • TorBox ready",
        url: expect.stringMatching(new RegExp(`^${base}/resolve/[^/]+$`)),
        behaviorHints: {
          bingeGroup: "kids-channels-tv",
          filename: "Playback.Show.S01E01.1080p.WEB-DL.mkv",
        },
      }],
    });
    const requestCount = outbound.mock.calls.length;
    expect(await (await SELF.fetch(streamUrl)).json()).toEqual(firstBody);
    expect(outbound).toHaveBeenCalledTimes(requestCount);
    expect(await env.DB.prepare("SELECT torrent_id, file_id, video_id FROM stream_selections").first()).toMatchObject({
      torrent_id: "71",
      file_id: 7,
      video_id: canonicalEpisodeId,
    });

    const resolve = await SELF.fetch(firstBody.streams[0].url, { redirect: "manual" });
    expect(resolve.status).toBe(302);
    expect(resolve.headers.get("location")).toBe("https://download.torbox.test/fresh-signed-media");
    expect(resolve.headers.get("cache-control")).toBe("no-store");
    expect(resolve.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await resolve.text()).toBe("");
  });

  it("rejects forged resolution and invalidates a dead TorBox selection", async () => {
    const created = await arrangePlayback();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const programme = await env.DB.prepare("SELECT id FROM approved_programmes WHERE household_id = ?")
      .bind(created.householdId)
      .first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO stream_selections
      (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
        quality, seeders, selected_at, stale_at)
      VALUES (?, ?, 'series', ?, '69', ?, 7, 'Playback.Show.S01E01.mkv',
        '1080p', 10, '2026-07-30T00:00:00.000Z', '2099-07-31T00:00:00.000Z')`)
      .bind(created.householdId, programme!.id, canonicalEpisodeId, "a".repeat(40))
      .run();
    const token = await issueStreamToken(
      created.householdId,
      "69",
      7,
      Date.parse("2099-07-31T00:00:00.000Z"),
      env.CONFIG_SECRET,
    );
    vi.restoreAllMocks();
    let deadInfoRequests = 0;
    const torBox = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/torrents/mylist") && url.searchParams.get("id") === "69") {
        deadInfoRequests += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer household-rd-token");
        return Response.json({ success: false, error: "DOWNLOAD_NOT_FOUND", detail: "Torrent not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/torrents/controltorrent")) return Response.json({ success: true, data: true });
      if (url.pathname.endsWith("/dmm/filtered")) return Response.json([]);
      if (url.pathname.endsWith("/v1")) return Response.json({ hits: [] });
      throw new Error(`unexpected outbound request: ${url}`);
    });

    const [payload, signature] = token.split(".");
    const forgedToken = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const forged = await SELF.fetch(`${base}/resolve/${forgedToken}`, { redirect: "manual" });
    expect(forged.status).toBe(403);
    expect(torBox).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stream_selections").first()).toMatchObject({ count: 1 });

    const dead = await SELF.fetch(`${base}/resolve/${token}`, { redirect: "manual" });
    const deadBody = await dead.text();
    expect(dead.status).toBe(410);
    expect(deadBody).toContain("Request the stream again");
    expect(deadBody).not.toContain("69");
    expect(deadBody).not.toContain("household-rd-token");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stream_selections").first()).toMatchObject({ count: 0 });
    expect(deadInfoRequests).toBe(1);

    const gone = await SELF.fetch(`${base}/resolve/${token}`, { redirect: "manual" });
    expect(gone.status).toBe(410);
    expect(deadInfoRequests).toBe(1);
  });

  it("preserves a valid selection when TorBox is transiently rate limited", async () => {
    const created = await arrangePlayback();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const programme = await env.DB.prepare("SELECT id FROM approved_programmes WHERE household_id = ?")
      .bind(created.householdId)
      .first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO stream_selections
      (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
        quality, seeders, selected_at, stale_at)
      VALUES (?, ?, 'series', ?, 'limited-torrent', ?, 7, 'Playback.Show.S01E01.mkv',
        '1080p', 10, '2026-07-30T00:00:00.000Z', '2099-07-31T00:00:00.000Z')`)
      .bind(created.householdId, programme!.id, canonicalEpisodeId, "a".repeat(40))
      .run();
    const token = await issueStreamToken(
      created.householdId,
      "limited-torrent",
      7,
      Date.parse("2099-07-31T00:00:00.000Z"),
      env.CONFIG_SECRET,
    );
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "rate limited", error_code: 34 }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } },
    ));

    const response = await SELF.fetch(`${base}/resolve/${token}`, { redirect: "manual" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toEqual({ error: "TorBox could not resolve this stream. Try again." });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stream_selections").first()).toMatchObject({ count: 1 });
  });

  it("automatically retries a different cached torrent when the selected link was removed", async () => {
    const created = await arrangePlayback();
    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const programme = await env.DB.prepare("SELECT id FROM approved_programmes WHERE household_id = ?")
      .bind(created.householdId)
      .first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO stream_selections
      (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
        quality, seeders, selected_at, stale_at)
      VALUES (?, ?, 'series', ?, '70', ?, 7, 'Playback.Show.S01E01.removed.mkv',
        '1080p', 10, '2026-07-30T00:00:00.000Z', '2099-07-31T00:00:00.000Z')`)
      .bind(created.householdId, programme!.id, canonicalEpisodeId, "a".repeat(40))
      .run();
    const token = await issueStreamToken(
      created.householdId,
      "70",
      7,
      Date.parse("2099-07-31T00:00:00.000Z"),
      env.CONFIG_SECRET,
    );
    vi.restoreAllMocks();
    let alternateInfoRequests = 0;
    const alternateHash = "b".repeat(40);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(new Headers(init?.headers).get("authorization") ?? "Bearer household-rd-token")
        .toBe("Bearer household-rd-token");
      if (url.pathname.endsWith("/torrents/mylist") && url.searchParams.get("id") === "70") {
        return Response.json({ success: true, data: {
          id: "70",
          hash: "a".repeat(40),
          download_state: "cached",
          download_present: true,
          download_finished: true,
          files: [{ id: 7, name: "/Playback.Show.S01E01.removed.mkv", size: 1_000 }],
        } });
      }
      if (url.pathname.endsWith("/torrents/controltorrent")) {
        return Response.json({ success: true, data: true });
      }
      if (url.pathname.endsWith("/torrents/requestdl")) {
        if (url.searchParams.get("torrent_id") === "70") {
          return Response.json({ success: false, error: "DOWNLOAD_NOT_FOUND", detail: "Download was removed" }, { status: 404 });
        }
        expect(url.searchParams.get("torrent_id")).toBe("72");
        expect(url.searchParams.get("file_id")).toBe("8");
        return Response.json({ success: true, data: "https://download.torbox.test/alternate-media" });
      }
      if (url.pathname.endsWith("/dmm/filtered")) {
        expect(url.searchParams.get("ImdbId")).toBe("tt2468101");
        return Response.json([{
          raw_title: "Playback.Show.S01E01.1080p.WEB-DL.mkv",
          info_hash: alternateHash,
          resolution: "1080p",
          seasons: [1],
          episodes: [1],
        }]);
      }
      if (url.pathname.endsWith("/v1")) return Response.json({ hits: [] });
      if (url.pathname.endsWith("/torrents/createtorrent")) {
        expect((init?.body as FormData).get("magnet")).toContain(alternateHash);
        return Response.json({ success: true, data: { torrent_id: 72 } });
      }
      if (url.pathname.endsWith("/torrents/mylist") && url.searchParams.get("id") === "72") {
        alternateInfoRequests += 1;
        return Response.json({ success: true, data: {
          id: 72,
          hash: alternateHash,
          download_state: "cached",
          download_present: true,
          download_finished: true,
          files: [{
            id: 8,
            name: "/Playback.Show.S01E01.1080p.WEB-DL.mkv",
            size: 2_000,
          }],
        } });
      }
      throw new Error(`unexpected outbound request: ${url}`);
    });

    const response = await SELF.fetch(`${base}/resolve/${token}`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://download.torbox.test/alternate-media");
    expect(await env.DB.prepare("SELECT torrent_id, info_hash FROM stream_selections").first()).toMatchObject({
      torrent_id: "72",
      info_hash: alternateHash,
    });
  });
});

describe("rolling TV Channel Schedule", () => {
  async function arrangeShows(showCount: number, episodeCount = 30) {
    const created = await create();
    const channelId = await defaultChannelId(created, "tv");
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
      statements.push(env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, next_video_id, created_at) VALUES (?, ?, ?, ?)`)
        .bind(channelId, programmeId, `tt900000${show}:1:1`, `${now}-${show}`));
    }
    await env.DB.batch(statements);
    return { created, channelId, base: created.manifestUrl.replace(/\/manifest\.json$/, "") };
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

  it("snapshots a configurable Preparation Run, prevents overlap, and stops unfinished work", async () => {
    const { created, channelId } = await arrangeShows(2);
    const schedule = await tvChannelSchedule(env.DB, created.householdId, channelId, "deterministic-test-seed");
    const now = new Date("2026-08-01T10:00:00.000Z");
    const run = await createTvPreparationRun(env.DB, created.householdId, schedule, 3, 8, now);

    expect(run).toMatchObject({
      status: "queued",
      requestedCount: 3,
      deadlineAt: "2026-08-01T18:00:00.000Z",
      counts: { queued: 3, ready: 0 },
    });
    expect(run.items.map((item) => item.videoId)).toEqual(schedule.slice(0, 3).map((item) => item.episode.id));
    await expect(createTvPreparationRun(env.DB, created.householdId, schedule, 1, 1, now))
      .rejects.toThrow("preparation already active");

    const cancelled = await cancelTvPreparationRun(env.DB, created.householdId, new Date("2026-08-01T10:05:00.000Z"));
    expect(cancelled).toMatchObject({ status: "cancelled", counts: { cancelled: 3 } });
    expect((await tvPreparationRun(env.DB, created.householdId))?.items.every((item) => item.message === "Stopped by Parent")).toBe(true);
  });

  it("exposes automatic preparation status without a manual start endpoint", async () => {
    const { created } = await arrangeShows(1);
    const endpoint = `https://kids.test/api/households/${secretFrom(created)}/tv-preparation`;
    expect((await SELF.fetch(endpoint)).status).toBe(401);
    const headers = await parentHeaders(created);
    expect(await (await SELF.fetch(endpoint, { headers })).json()).toEqual({ run: null });
    const manualStart = await SELF.fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ count: 21, windowHours: 8 }),
    });
    expect(manualStart.status).toBe(404);
  });

  it("automatically snapshots five programmes and replaces the run after the schedule advances", async () => {
    const { created, channelId } = await arrangeShows(2);
    await storeTorBoxCredential(env.DB, created.householdId, "household-torbox-token", env.CONFIG_SECRET);
    const firstSchedule = await tvChannelSchedule(env.DB, created.householdId, channelId, "deterministic-test-seed");
    const firstRun = await ensureAutomaticTvPreparation(env, created.householdId, firstSchedule, new Date("2026-08-01T10:00:00.000Z"));

    expect(firstRun).toMatchObject({ status: "queued", requestedCount: 5 });
    expect(firstRun?.items.map((item) => item.videoId)).toEqual(firstSchedule.slice(0, 5).map((item) => item.episode.id));

    await requestTvProgramme(env.DB, created.householdId, channelId, firstSchedule[1].episode.id, "deterministic-test-seed");
    const secondSchedule = await tvChannelSchedule(env.DB, created.householdId, channelId, "deterministic-test-seed");
    const secondRun = await ensureAutomaticTvPreparation(env, created.householdId, secondSchedule, new Date("2026-08-01T10:01:00.000Z"));

    expect(secondRun?.id).not.toBe(firstRun?.id);
    expect(secondRun?.items.map((item) => item.videoId)).toEqual(secondSchedule.slice(0, 5).map((item) => item.episode.id));
    expect(await tvPreparationRun(env.DB, created.householdId, firstRun!.id)).toMatchObject({ status: "cancelled" });
  });

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
    const progress = await env.DB.prepare("SELECT next_video_id FROM channel_assignments ORDER BY programme_id").all<{ next_video_id: string }>();
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

  it("bounds episode catalogue queries to the persisted schedule length", async () => {
    const { created, channelId } = await arrangeShows(1, 250);
    await tvChannelSchedule(env.DB, created.householdId, channelId, "deterministic-test-seed");
    const prepared: string[] = [];
    const instrumented = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            prepared.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const schedule = await refreshTvChannelSchedule(
      instrumented,
      created.householdId,
      channelId,
      false,
      "deterministic-test-seed",
    );

    expect(schedule).toHaveLength(20);
    const episodeQueries = prepared.filter((query) => query.includes("FROM show_episodes episode"));
    expect(episodeQueries).toHaveLength(1);
    expect(episodeQueries[0]).toContain("LIMIT ?");
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

  it("defers an unavailable episode without consuming it and returns a stable-group holding bumper", async () => {
    const { created, base } = await arrangeShows(2);
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const before = await metadata(base);
    const unavailableId = before.meta.behaviorHints.defaultVideoId as string;
    const unavailableProgramme = unavailableId.startsWith("tt9000001:") ? "programme-1" : "programme-2";
    const nextId = before.meta.videos[1].id as string;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname.includes("zilean")) return Response.json([]);
      if (url.hostname.includes("knaben")) return Response.json({ hits: [] });
      throw new Error(`unexpected outbound request: ${url}`);
    });

    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      SELF.fetch(`${base}/stream/series/${encodeURIComponent(unavailableId)}.json`)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(await responses[0].json()).toEqual({
      streams: [{
        name: "Kids Channels",
        description: "Programme unavailable • Trying next show",
        url: "https://kids.test/assets/programme-unavailable-v2.mp4",
        behaviorHints: {
          bingeGroup: "kids-channels-tv",
          filename: "kids-channels-programme-unavailable.mp4",
        },
      }],
    });
    const bumper = await SELF.fetch("https://kids.test/assets/programme-unavailable-v2.mp4");
    expect(bumper.status).toBe(200);
    expect(bumper.headers.get("content-type")).toBe("video/mp4");
    expect(bumper.headers.get("access-control-allow-origin")).toBe("*");
    expect((await bumper.arrayBuffer()).byteLength).toBeGreaterThan(99_000);

    const after = await metadata(base);
    expect(after.meta.behaviorHints.defaultVideoId).toBe(nextId);
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = ?")
      .bind(unavailableProgramme).first()).toMatchObject({ next_video_id: unavailableId });
    const unavailable = await env.DB.prepare(`SELECT video_id, unavailable_at, retry_at
      FROM unavailable_episodes WHERE household_id = ?`)
      .bind(created.householdId).first<{ video_id: string; unavailable_at: string; retry_at: string }>();
    expect(unavailable).toMatchObject({ video_id: unavailableId });
    expect(Date.parse(unavailable!.retry_at) - Date.parse(unavailable!.unavailable_at)).toBe(5 * 60 * 1000);
    expect(after.meta.videos[1].id).toBe(unavailableId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_advancements").first()).toMatchObject({ count: 1 });
  });

  it("uses a terminal bumper without autoplay when every show is unavailable", async () => {
    const { created, base } = await arrangeShows(1);
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const before = await metadata(base);
    const unavailableId = before.meta.behaviorHints.defaultVideoId as string;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname.includes("zilean")) return Response.json([]);
      if (url.hostname.includes("knaben")) return Response.json({ hits: [] });
      throw new Error(`unexpected outbound request: ${url}`);
    });

    const response = await SELF.fetch(`${base}/stream/series/${encodeURIComponent(unavailableId)}.json`);
    expect(await response.json()).toEqual({
      streams: [{
        name: "Kids Channels",
        description: "Programme unavailable • Try again later",
        url: "https://kids.test/assets/programme-unavailable-v2.mp4",
        behaviorHints: { filename: "kids-channels-programme-unavailable.mp4" },
      }],
    });
    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toBe(unavailableId);
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments").first())
      .toMatchObject({ next_video_id: unavailableId });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_advancements").first())
      .toMatchObject({ count: 0 });
  });

  it("finishes the prior programme before deferring an unavailable upcoming episode", async () => {
    const { created, base } = await arrangeShows(2);
    await storeTorBoxCredential(env.DB, created.householdId, "household-rd-token", env.CONFIG_SECRET);
    const before = await metadata(base);
    const currentId = before.meta.videos[0].id as string;
    const unavailableId = before.meta.videos[1].id as string;
    const currentProgramme = currentId.startsWith("tt9000001:") ? "programme-1" : "programme-2";
    const unavailableProgramme = currentProgramme === "programme-1" ? "programme-2" : "programme-1";
    const currentImdb = currentId.split(":")[0];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname.includes("zilean")) return Response.json([]);
      if (url.hostname.includes("knaben")) return Response.json({ hits: [] });
      throw new Error(`unexpected outbound request: ${url}`);
    });

    await SELF.fetch(`${base}/stream/series/${encodeURIComponent(unavailableId)}.json`);

    expect((await metadata(base)).meta.behaviorHints.defaultVideoId).toBe(`${currentImdb}:1:2`);
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = ?")
      .bind(currentProgramme).first()).toMatchObject({ next_video_id: `${currentImdb}:1:2` });
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = ?")
      .bind(unavailableProgramme).first()).toMatchObject({ next_video_id: unavailableId });
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
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = 'programme-1'").first())
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
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = ?").bind(otherShow).first())
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
    expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = 'programme-1'").first())
      .toMatchObject({ next_video_id: null });
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
      expect(await env.DB.prepare("SELECT next_video_id FROM channel_assignments WHERE programme_id = ?")
        .bind(`programme-${show}`).first()).toMatchObject({ next_video_id: `tt900000${show}:1:${expected}` });
    }
  });
});

describe("Approved Library changes while Channels are active", () => {
  async function arrangeActiveChannels() {
    const created = await create();
    const tvChannelId = await defaultChannelId(created, "tv");
    const movieChannelId = await defaultChannelId(created, "movie");
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
      statements.push(env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, next_video_id, created_at) VALUES (?, ?, ?, ?)`)
        .bind(tvChannelId, `active-show-${show}`, `tt700000${show}:1:1`, `${now}-${show}`));
    }
    for (let movie = 1; movie <= 3; movie += 1) {
      statements.push(env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
        VALUES (?, ?, ?, 'movie', ?, '[]', ?)`)
        .bind(`active-movie-${movie}`, created.householdId, `tt600000${movie}`, `Active Movie ${movie}`, `${now}-${movie}`));
      statements.push(env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, created_at) VALUES (?, ?, ?)`)
        .bind(movieChannelId, `active-movie-${movie}`, `${now}-${movie}`));
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
    return { created, tvChannelId, movieChannelId, secret, headers, base, tvUrl, movieUrl };
  }

  it("pauses, resumes, regenerates, and removes shows without falsely advancing Show Progress", async () => {
    const { created, tvChannelId, secret, headers, base, tvUrl } = await arrangeActiveChannels();
    const initial = await (await SELF.fetch(tvUrl)).json<any>();
    const initialVideoId = initial.meta.behaviorHints.defaultVideoId as string;
    const current = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel_id = ?")
      .bind(created.householdId, tvChannelId).first<{ programme_id: string }>();
    expect(current).toBeTruthy();
    const progressBefore = await env.DB.prepare("SELECT programme_id, next_video_id FROM channel_assignments WHERE channel_id = ? ORDER BY programme_id")
      .bind(tvChannelId)
      .all<{ programme_id: string; next_video_id: string }>();

    const pause = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${current!.programme_id}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ paused: true }),
    });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ message: expect.stringContaining("Restart Stremio") });
    const whilePaused = await (await SELF.fetch(tvUrl)).json<any>();
    expect(whilePaused.meta.behaviorHints.defaultVideoId).not.toBe(initialVideoId);
    expect(whilePaused.meta.videos.every((video: any) => !video.id.startsWith(initialVideoId.split(":")[0]))).toBe(true);
    expect(await env.DB.prepare("SELECT paused_at FROM channel_assignments WHERE channel_id = ? AND programme_id = ?")
      .bind(tvChannelId, current!.programme_id).first<string>("paused_at"))
      .toBeTruthy();

    const resume = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${current!.programme_id}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ paused: false }),
    });
    expect(resume.status).toBe(200);
    expect(await env.DB.prepare("SELECT paused_at FROM channel_assignments WHERE channel_id = ? AND programme_id = ?")
      .bind(tvChannelId, current!.programme_id).first<string>("paused_at"))
      .toBeNull();
    expect((await env.DB.prepare("SELECT programme_id, next_video_id FROM channel_assignments WHERE channel_id = ? ORDER BY programme_id")
      .bind(tvChannelId).all()).results).toEqual(progressBefore.results);

    const beforeRegenerate = await (await SELF.fetch(tvUrl)).json<any>();
    const seedBefore = await env.DB.prepare("SELECT selection_seed FROM channel_state WHERE household_id = ? AND channel_id = ?")
      .bind(created.householdId, tvChannelId).first<string>("selection_seed");
    const regenerate = await SELF.fetch(`https://kids.test/api/households/${secret}/tv-schedule/regenerate`, { method: "POST", headers });
    expect(regenerate.status).toBe(200);
    const afterRegenerate = await (await SELF.fetch(tvUrl)).json<any>();
    expect(afterRegenerate.meta.behaviorHints.defaultVideoId).toBe(beforeRegenerate.meta.behaviorHints.defaultVideoId);
    expect(await env.DB.prepare("SELECT selection_seed FROM channel_state WHERE household_id = ? AND channel_id = ?")
      .bind(created.householdId, tvChannelId).first<string>("selection_seed")).not.toBe(seedBefore);
    expect((await env.DB.prepare("SELECT programme_id, next_video_id FROM channel_assignments WHERE channel_id = ? ORDER BY programme_id")
      .bind(tvChannelId).all()).results).toEqual(progressBefore.results);

    const currentProgrammeId = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel_id = ?")
      .bind(created.householdId, tvChannelId).first<string>("programme_id");
    const futureProgrammeId = currentProgrammeId === "active-show-1" ? "active-show-2" : "active-show-1";
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${futureProgrammeId}`, { method: "DELETE", headers })).status).toBe(200);
    const oneShow = await (await SELF.fetch(tvUrl)).json<any>();
    expect(oneShow.meta.videos).toHaveLength(20);
    expect(oneShow.meta.videos.every((video: any) => video.id.startsWith(currentProgrammeId === "active-show-1" ? "tt7000001:" : "tt7000002:"))).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_schedule WHERE programme_id = ?").bind(futureProgrammeId).first())
      .toMatchObject({ count: 0 });

    const removedVideoId = oneShow.meta.behaviorHints.defaultVideoId;
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${currentProgrammeId}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await (await SELF.fetch(tvUrl)).json<any>()).meta.videos).toEqual([]);
    expect((await SELF.fetch(`${base}/stream/series/${encodeURIComponent(removedVideoId)}.json`)).status).toBe(200);
  });

  it("removes movies from the remaining rotation and keeps one-item and empty Channel states valid", async () => {
    const { created, movieChannelId, secret, headers, movieUrl } = await arrangeActiveChannels();
    const before = await (await SELF.fetch(movieUrl)).json<any>();
    const removedVideoId = before.meta.behaviorHints.defaultVideoId;
    const removedProgrammeId = await env.DB.prepare("SELECT programme_id FROM current_programmes WHERE household_id = ? AND channel_id = ?")
      .bind(created.householdId, movieChannelId).first<string>("programme_id");

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
    expect((await (await SELF.fetch(movieUrl)).json<any>()).meta.videos).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_channel_state WHERE household_id = ?")
      .bind(created.householdId).first()).toMatchObject({ count: 0 });
  });
});

describe("Movie Channel rotation and sign-off", () => {
  async function arrangeMovies(count = 3) {
    const created = await create();
    const channelId = await defaultChannelId(created, "movie");
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < count; index += 1) {
      const programmeId = `movie-${index + 1}`;
      statements.push(env.DB.prepare(`INSERT INTO approved_programmes
        (id, household_id, imdb_id, content_type, title, description, poster, genres_json, approved_at)
        VALUES (?, ?, ?, 'movie', ?, ?, ?, '[]', ?)`)
        .bind(programmeId, created.householdId, `tt800000${index + 1}`, `Movie ${index + 1}`,
          `Approved movie ${index + 1}.`, `https://images.example/movie-${index + 1}.jpg`, `${now}-${index}`));
      statements.push(env.DB.prepare(`INSERT INTO channel_assignments
        (channel_id, programme_id, created_at) VALUES (?, ?, ?)`)
        .bind(channelId, programmeId, `${now}-${index}`));
    }
    await env.DB.batch(statements);
    return { created, channelId, base: created.manifestUrl.replace(/\/manifest\.json$/, "") };
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
          url: expect.stringMatching(/^https:\/\/kids\.test\/addons\/[^/]+\/media\/movie-sign-off\/[0-9a-f-]+\/\d+\/\d+\.mp4$/),
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
    const { created, channelId, base } = await arrangeMovies(2);
    const first = await metadata(base);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
      VALUES ('movie-3', ?, 'tt8000003', 'movie', 'Movie 3', '[]', ?)`).bind(created.householdId, now).run();
    await env.DB.prepare(`INSERT INTO channel_assignments
      (channel_id, programme_id, created_at) VALUES (?, 'movie-3', ?)`)
      .bind(channelId, now).run();

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

  it("adds one movie with bounded rotation mutations regardless of library size", async () => {
    const { created, channelId } = await arrangeMovies(100);
    await reconcileMovieChannel(env.DB, created.householdId, channelId, "bounded-rotation-seed");

    const before = await env.DB.prepare(`SELECT position, programme_id FROM movie_rotation
      WHERE household_id = ? AND cycle = 0 ORDER BY position`).bind(created.householdId)
      .all<{ position: number; programme_id: string }>();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
      VALUES ('movie-101', ?, 'tt8000101', 'movie', 'Movie 101', '[]', ?)`).bind(created.householdId, now).run();
    await env.DB.prepare(`INSERT INTO channel_assignments
      (channel_id, programme_id, created_at) VALUES (?, 'movie-101', ?)`)
      .bind(channelId, now).run();

    const mutations: string[] = [];
    const instrumented = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (/^(?:INSERT|UPDATE|DELETE)/.test(query.trim())) mutations.push(query.trim());
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await reconcileMovieChannel(instrumented, created.householdId, channelId, "bounded-rotation-seed");

    expect(mutations).toHaveLength(3);
    expect(mutations.some((query) => query.startsWith("DELETE FROM movie_rotation"))).toBe(false);
    const after = await env.DB.prepare(`SELECT position, programme_id FROM movie_rotation
      WHERE household_id = ? AND cycle = 0 ORDER BY position`).bind(created.householdId)
      .all<{ position: number; programme_id: string }>();
    expect(after.results.slice(0, before.results.length)).toEqual(before.results);
    expect(after.results.at(-1)).toEqual({ position: 100, programme_id: "movie-101" });
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
    expect(full.headers.get("access-control-allow-origin")).toBe("*");
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
    const tvChannelId = await defaultChannelId(created, "tv");
    const movieChannelId = await defaultChannelId(created, "movie");
    await env.DB.prepare(`INSERT INTO approved_programmes
      (id, household_id, imdb_id, content_type, title, genres_json, approved_at)
      VALUES ('programme-delete', ?, 'tt1234567', 'show', 'Delete me', '[]', 'now')`).bind(householdId).run();
    await env.DB.prepare("INSERT INTO show_episodes VALUES ('programme-delete', 'tt1234567:1:1', 1, 1, 'Pilot', 'now', NULL)").run();
    await env.DB.prepare(`INSERT INTO channel_assignments
      VALUES (?, 'programme-delete', 'tt1234567:1:1', NULL, 'now')`).bind(tvChannelId).run();
    await env.DB.prepare(`INSERT INTO unavailable_episodes
      VALUES (?, 'programme-delete', 'tt1234567:1:1', 'now', 'later')`).bind(householdId).run();
    await env.DB.prepare("INSERT INTO current_programmes VALUES (?, ?, 'programme-delete', 'tt1234567:1:1', 'now')").bind(householdId, tvChannelId).run();
    await env.DB.prepare("INSERT INTO channel_state VALUES (?, ?, 0, 'seed', 'now')").bind(householdId, tvChannelId).run();
    await env.DB.prepare("INSERT INTO channel_schedule VALUES (?, ?, 0, 'programme-delete', 'tt1234567:1:1', 'now')").bind(householdId, tvChannelId).run();
    await env.DB.prepare("INSERT INTO channel_advancements VALUES (?, ?, 0, 1, 'owner', 'now')").bind(householdId, tvChannelId).run();
    await env.DB.prepare(`INSERT INTO tv_advancement_history VALUES
      ('history-delete', ?, ?, 0, 1, 'programme-delete', 'tt1234567:1:1', 'programme-delete', 'tt1234567:1:1', '{}', '{}', 'now', NULL, NULL)`)
      .bind(householdId, tvChannelId).run();
    await env.DB.prepare("INSERT INTO movie_channel_state VALUES (?, ?, 1, 0, 'seed', 'now', 0)").bind(householdId, movieChannelId).run();
    await env.DB.prepare("INSERT INTO movie_rotation VALUES (?, ?, 1, 0, 'programme-delete', NULL)").bind(householdId, movieChannelId).run();
    await env.DB.prepare("INSERT INTO movie_advancements VALUES (?, ?, 1, 0, 'owner', 'now')").bind(householdId, movieChannelId).run();
    await env.DB.prepare("INSERT INTO movie_channel_mutations VALUES (?, ?, 0, 'owner', 'now')").bind(householdId, movieChannelId).run();
    await env.DB.prepare("INSERT INTO movie_playback_history VALUES ('movie-history-delete', ?, ?, 'programme-delete', 'tt1234567', 'Delete me', 1, 0, 'now')").bind(householdId, movieChannelId).run();

    const deleted = await SELF.fetch(`https://kids.test/api/households/${secret}`, {
      method: "DELETE", headers, body: JSON.stringify({ currentPin: "123456", confirmation: "DELETE" }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ message: "Household permanently deleted." });
    expect(deleted.headers.get("set-cookie")).toContain("kids_parent_session=;");
    expect(deleted.headers.get("set-cookie")).toContain("Max-Age=0");

    const invalidSession = await SELF.fetch(`https://kids.test/api/households/${secret}/session`, { headers });
    expect(invalidSession.status).toBe(401);
    expect(await invalidSession.json()).toEqual({ error: "Parent authentication is required." });

    for (const table of ["households", "pin_attempts", "approved_programmes", "show_episodes", "channels", "channel_assignments",
      "current_programmes", "channel_state", "channel_schedule", "channel_advancements", "tv_advancement_history",
      "movie_channel_state", "movie_rotation", "movie_advancements", "movie_channel_mutations", "movie_playback_history",
      "stream_selections", "stream_candidate_failures", "unavailable_episodes"]) {
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

  it("renders the same neutral not-found state for unknown and deleted Parent Page URLs", async () => {
    const unknownSecret = "unknown-private-household";
    for (const path of [`/households/${unknownSecret}`, `/households/${unknownSecret}/settings`]) {
      const response = await SELF.fetch(`https://kids.test${path}`);
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      const csp = response.headers.get("content-security-policy");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(body).toContain("Household not found");
      expect(body).toContain("Create a new Household");
      expect(body).not.toContain(unknownSecret);
      expect(body).not.toMatch(/PIN|Approved Library|Channel Schedule/);
    }
  });
});

describe("scheduled Channel state retention", () => {
  it("prunes bounded expired state while preserving active ownership, undo, and Parent history", async () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const expired = "2026-08-07T12:00:00.000Z";
    const active = "2026-08-09T11:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
        VALUES ('retention-a', 'retention-secret-a', 'salt', 'hash', ?)`),
      env.DB.prepare(`INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
        VALUES ('retention-b', 'retention-secret-b', 'salt', 'hash', ?)`),
    ].map((statement) => statement.bind(now.toISOString())));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels VALUES ('retention-tv-a', 'retention-a', 'tv', 'TV', 'tv', ?)").bind(now.toISOString()),
      env.DB.prepare("INSERT INTO channels VALUES ('retention-movie-a', 'retention-a', 'movie', 'Movies', 'movie', ?)").bind(now.toISOString()),
      env.DB.prepare("INSERT INTO channels VALUES ('retention-movie-b', 'retention-b', 'movie', 'Movies', 'movie', ?)").bind(now.toISOString()),
    ]);
    await env.DB.prepare("INSERT INTO channel_state VALUES ('retention-a', 'retention-tv-a', 99, 'seed', ?)")
      .bind(expired).run();
    await env.DB.prepare("INSERT INTO movie_channel_state VALUES ('retention-a', 'retention-movie-a', 2, 0, 'seed', ?, 0)")
      .bind(expired).run();

    const statements: D1PreparedStatement[] = [
      env.DB.prepare("INSERT INTO channel_advancements VALUES ('retention-a', 'retention-tv-a', 1, 2, 'expired-tv-claim', ?)").bind(expired),
      env.DB.prepare("INSERT INTO channel_advancements VALUES ('retention-a', 'retention-tv-a', 2, 3, 'active-tv-claim', ?)").bind(active),
      env.DB.prepare("INSERT INTO channel_advancements VALUES ('retention-a', 'retention-tv-a', 98, 99, 'undo-history', ?)").bind(expired),
      env.DB.prepare("INSERT INTO movie_advancements VALUES ('retention-a', 'retention-movie-a', 0, 0, 'expired-movie-claim', ?)").bind(expired),
      env.DB.prepare("INSERT INTO movie_advancements VALUES ('retention-a', 'retention-movie-a', 2, 0, 'active-movie-claim', ?)").bind(active),
      env.DB.prepare("INSERT INTO movie_channel_mutations VALUES ('retention-a', 'retention-movie-a', 0, 'expired-mutation', ?)").bind(expired),
      env.DB.prepare("INSERT INTO movie_channel_mutations VALUES ('retention-a', 'retention-movie-a', 1, 'active-mutation', ?)").bind(active),
      env.DB.prepare("INSERT INTO movie_channel_mutations VALUES ('retention-b', 'retention-movie-b', 0, 'other-household-expired', ?)").bind(expired),
      env.DB.prepare("INSERT INTO tv_advancement_history VALUES ('undo-history', 'retention-a', 'retention-tv-a', 98, 99, 'show', 'episode-98', 'show', 'episode-99', '{}', '{}', ?, NULL, NULL)").bind("2026-07-01T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO movie_rotation VALUES ('retention-a', 'retention-movie-a', 0, 0, 'movie-old-0', ?)").bind(expired),
      env.DB.prepare("INSERT INTO movie_rotation VALUES ('retention-a', 'retention-movie-a', 1, 0, 'movie-old-1', ?)").bind(expired),
      env.DB.prepare("INSERT INTO movie_rotation VALUES ('retention-a', 'retention-movie-a', 2, 0, 'movie-current', NULL)"),
      env.DB.prepare(`INSERT INTO stream_selections
        (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
         quality, seeders, selected_at, stale_at, download_pending, last_progress)
        VALUES ('retention-a', 'show', 'series', 'expired-stream', '1', ?, 1, 'expired.mkv', '1080p', 1, ?, ?, 0, 100)`)
        .bind("a".repeat(40), expired, expired),
      env.DB.prepare(`INSERT INTO stream_selections
        (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
         quality, seeders, selected_at, stale_at, download_pending, last_progress)
        VALUES ('retention-a', 'show', 'series', 'active-stream', '2', ?, 2, 'active.mkv', '1080p', 1, ?, ?, 0, 100)`)
        .bind("b".repeat(40), active, "2026-08-10T12:00:00.000Z"),
      env.DB.prepare(`INSERT INTO stream_candidate_failures
        VALUES ('retention-a', 'show', 'series', 'episode', ?, 'failed', ?, ?)`)
        .bind("c".repeat(40), expired, expired),
      env.DB.prepare(`INSERT INTO stream_candidate_failures
        VALUES ('retention-a', 'show', 'series', 'episode', ?, 'failed', ?, ?)`)
        .bind("d".repeat(40), active, "2026-08-10T12:00:00.000Z"),
      env.DB.prepare("INSERT INTO unavailable_episodes VALUES ('retention-a', 'show', 'expired-episode', ?, ?)")
        .bind(expired, expired),
      env.DB.prepare("INSERT INTO unavailable_episodes VALUES ('retention-a', 'show', 'active-episode', ?, ?)")
        .bind(active, "2026-08-10T12:00:00.000Z"),
    ];
    for (let index = 0; index < 11; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString();
      statements.push(env.DB.prepare(`INSERT INTO tv_advancement_history VALUES
        (?, 'retention-a', 'retention-tv-a', ?, ?, 'show', ?, 'show', ?, '{}', '{}', ?, NULL, NULL)`)
        .bind(`tv-history-${index}`, index, index + 1, `episode-${index}`, `episode-${index + 1}`, timestamp));
      statements.push(env.DB.prepare(`INSERT INTO movie_playback_history VALUES
        (?, 'retention-a', 'retention-movie-a', 'movie', 'tt1234567', 'Movie', 0, ?, ?)`)
        .bind(`movie-history-${index}`, index, timestamp));
    }
    for (let index = 0; index < 12; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 7, 1, 1, index)).toISOString();
      statements.push(env.DB.prepare(`INSERT INTO tv_preparation_runs
        (id, household_id, status, requested_count, deadline_at, completed_at, created_at, updated_at)
        VALUES (?, 'retention-a', 'completed', 1, ?, ?, ?, ?)`)
        .bind(`run-${index}`, timestamp, timestamp, timestamp, timestamp));
    }
    statements.push(env.DB.prepare(`INSERT INTO tv_preparation_runs
      (id, household_id, status, requested_count, deadline_at, created_at, updated_at)
      VALUES ('active-run', 'retention-a', 'running', 1, ?, ?, ?)`)
      .bind(expired, "2026-07-01T00:00:00.000Z", active));
    await env.DB.batch(statements);

    const first = await pruneObsoleteChannelState(env.DB, now, 1, 500);
    expect(first.households).toBe(1);
    expect(first.deleted).toMatchObject({
      channel_advancements: 1,
      movie_advancements: 1,
      movie_channel_mutations: 1,
      tv_advancement_history: 1,
      movie_playback_history: 1,
      movie_rotation: 2,
      tv_preparation_runs: 2,
      stream_selections: 1,
      stream_candidate_failures: 1,
      unavailable_episodes: 1,
    });
    expect(await env.DB.prepare("SELECT owner_token FROM channel_advancements ORDER BY from_position")
      .all<{ owner_token: string }>()).toMatchObject({
      results: [{ owner_token: "active-tv-claim" }, { owner_token: "undo-history" }],
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tv_advancement_history").first())
      .toMatchObject({ count: CHANNEL_RETENTION.playbackHistoryPerHousehold + 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_playback_history").first())
      .toMatchObject({ count: CHANNEL_RETENTION.playbackHistoryPerHousehold });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tv_preparation_runs").first())
      .toMatchObject({ count: CHANNEL_RETENTION.preparationRunsPerHousehold + 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_rotation").first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM movie_channel_mutations WHERE household_id = 'retention-b'").first())
      .toMatchObject({ count: 1 });

    const second = await pruneObsoleteChannelState(env.DB, now, 1, 500);
    expect(second.households).toBe(1);
    expect(second.deleted.movie_channel_mutations).toBe(1);
    const wrapped = await pruneObsoleteChannelState(env.DB, now, 1, 500);
    expect(wrapped).toMatchObject({ households: 0, wrapped: true, deleted: {} });
    const repeated = await pruneObsoleteChannelState(env.DB, now, 1, 500);
    expect(Object.values(repeated.deleted).every((count) => count === 0)).toBe(true);
  });
});

describe("Stremio protocol", () => {
  it("provisions defaults, permits duplicate names, enforces five per type, and exposes explicit assignments", async () => {
    const created = await create();
    const secret = secretFrom(created);
    const unlock = await SELF.fetch(`https://kids.test/api/households/${secret}/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }),
    });
    const headers = { ...sessionHeaders(unlock), "content-type": "application/json" };
    const initial = await (await SELF.fetch(`https://kids.test/api/households/${secret}/channels`, { headers })).json<any>();
    expect(initial.channels.map((channel: any) => [channel.type, channel.name])).toEqual([
      ["tv", "TV Channel"], ["movie", "Movie Channel"],
    ]);

    for (let index = 0; index < 4; index += 1) {
      const response = await SELF.fetch(`https://kids.test/api/households/${secret}/channels`, {
        method: "POST", headers, body: JSON.stringify({ type: "tv", name: "Same name" }),
      });
      expect(response.status).toBe(201);
    }
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/channels`, {
      method: "POST", headers, body: JSON.stringify({ type: "tv", name: "Sixth" }),
    })).status).toBe(409);

    const createdMovieResponse = await SELF.fetch(`https://kids.test/api/households/${secret}/channels`, {
      method: "POST", headers, body: JSON.stringify({ type: "movie", name: "Comedy" }),
    });
    const comedy = (await createdMovieResponse.json<any>()).channel;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (pathname.includes("/meta/series/")) return Response.json({ meta: {
        id: "tt6666666", imdb_id: "tt6666666", name: "Shared Show", type: "series", videos: [
          { id: "tt6666666:1:1", season: 1, episode: 1, title: "First", released: "2024-01-01T00:00:00.000Z" },
          { id: "tt6666666:1:2", season: 1, episode: 2, title: "Second", released: "2024-01-02T00:00:00.000Z" },
        ],
      } });
      return Response.json({ meta: {
        id: "tt5555555", imdb_id: "tt5555555", name: "Funny Movie", type: "movie", genres: ["Comedy"],
      } });
    });
    const approval = await SELF.fetch(`https://kids.test/api/households/${secret}/library`, {
      method: "POST", headers, body: JSON.stringify({ type: "movie", imdbId: "tt5555555", channelIds: [comedy.id] }),
    });
    expect(approval.status).toBe(201);
    const programme = (await approval.json<any>()).programme;
    expect(programme.assignments).toMatchObject([{ channelId: comedy.id, channelName: "Comedy" }]);

    const base = created.manifestUrl.replace(/\/manifest\.json$/, "");
    const catalog = await (await SELF.fetch(`${base}/catalog/movie/kids-movie-channel.json`)).json<any>();
    expect(catalog.metas.map((meta: any) => meta.name)).toEqual(["Movie Channel", "Comedy"]);
    const defaultMeta = await (await SELF.fetch(`${base}/meta/movie/${encodeURIComponent("kids-channels:movie")}.json`)).json<any>();
    expect(defaultMeta.meta.videos).toEqual([]);
    const comedyMeta = await (await SELF.fetch(`${base}/meta/movie/${encodeURIComponent(`kids-channels:movie:${comedy.id}`)}.json`)).json<any>();
    expect(comedyMeta.meta.videos[0]).toMatchObject({ id: "tt5555555", streams: [{ url: expect.stringContaining(`/play/movie/${comedy.id}/tt5555555`) }] });

    const defaultMovieId = initial.channels.find((channel: any) => channel.type === "movie").id;
    const reassigned = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${programme.id}/assignments`, {
      method: "PUT", headers, body: JSON.stringify({ channelIds: [defaultMovieId, comedy.id] }),
    });
    expect(reassigned.status).toBe(200);
    expect((await reassigned.json<any>()).programme.assignments.map((assignment: any) => assignment.channelId))
      .toEqual([defaultMovieId, comedy.id]);
    const finalRemoval = await SELF.fetch(`https://kids.test/api/households/${secret}/library/${programme.id}/assignments`, {
      method: "PUT", headers, body: JSON.stringify({ channelIds: [] }),
    });
    expect(finalRemoval.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM approved_programmes WHERE id = ?").bind(programme.id).first()).toBeNull();

    const allChannels = await (await SELF.fetch(`https://kids.test/api/households/${secret}/channels`, { headers })).json<any>();
    const tvChannels = allChannels.channels.filter((channel: any) => channel.type === "tv");
    const showApproval = await SELF.fetch(`https://kids.test/api/households/${secret}/library`, {
      method: "POST", headers, body: JSON.stringify({
        type: "show", imdbId: "tt6666666", channelIds: [tvChannels[0].id, tvChannels[1].id],
      }),
    });
    expect(showApproval.status).toBe(201);
    const show = (await showApproval.json<any>()).programme;
    const secondTvMeta = await (await SELF.fetch(`${base}/meta/series/${encodeURIComponent(`kids-channels:tv:${tvChannels[1].id}`)}.json`)).json<any>();
    expect(secondTvMeta.meta.videos).toHaveLength(2);
    const scopedPlayback = await SELF.fetch(secondTvMeta.meta.videos[1].streams[0].url);
    expect(scopedPlayback.status).toBe(200);
    const currentByChannel = await env.DB.prepare(`SELECT channel_id, video_id FROM current_programmes
      WHERE channel_id IN (?, ?) ORDER BY channel_id`).bind(tvChannels[0].id, tvChannels[1].id)
      .all<{ channel_id: string; video_id: string }>();
    expect(new Map(currentByChannel.results.map((row) => [row.channel_id, row.video_id]))).toEqual(new Map([
      [tvChannels[0].id, "tt6666666:1:1"], [tvChannels[1].id, "tt6666666:1:2"],
    ]));
    expect((await SELF.fetch(`https://kids.test/api/households/${secret}/library/${show.id}/progress`, {
      method: "PATCH", headers, body: JSON.stringify({ channelId: tvChannels[1].id, videoId: "tt6666666:1:2" }),
    })).status).toBe(200);
    const progress = await env.DB.prepare(`SELECT channel_id, next_video_id FROM channel_assignments
      WHERE programme_id = ? ORDER BY channel_id`).bind(show.id).all<{ channel_id: string; next_video_id: string }>();
    expect(new Map(progress.results.map((row) => [row.channel_id, row.next_video_id]))).toEqual(new Map([
      [tvChannels[0].id, "tt6666666:1:1"], [tvChannels[1].id, "tt6666666:1:2"],
    ]));
  });

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
