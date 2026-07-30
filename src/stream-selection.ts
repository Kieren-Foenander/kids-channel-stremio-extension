const REAL_DEBRID_ORIGIN = "https://api.real-debrid.com/rest/1.0";
const ZILEAN_ORIGIN = "https://zileanfortheweebs.midnightignite.me";
const KNABEN_ORIGIN = "https://api.knaben.org";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_CHECK_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_CACHE_CHECKS = 10;
const SELECTION_TTL_MS = 24 * 60 * 60 * 1000;

export type StreamContentType = "series" | "movie";

export interface StreamSelectionEnv {
  REAL_DEBRID_ORIGIN?: string;
  ZILEAN_ORIGIN?: string;
  KNABEN_ORIGIN?: string;
}

export interface StreamSelection {
  householdId: string;
  programmeId: string;
  contentType: StreamContentType;
  videoId: string;
  torrentId: string;
  infoHash: string;
  fileId: number;
  filename: string;
  quality: string;
  seeders: number;
  selectedAt: string;
  staleAt: string;
}

export interface DiscoveryCandidate {
  infoHash: string;
  magnet: string;
  title: string;
  quality: string;
  seeders: number;
  providerRank?: number;
}

interface CanonicalProgramme {
  programmeId: string;
  imdbId: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

interface TorrentFile {
  id: number;
  path: string;
  bytes: number;
}

interface TorrentInfo {
  status: string;
  files: TorrentFile[];
  links: string[];
}

interface ZileanResult {
  raw_title?: unknown;
  info_hash?: unknown;
  resolution?: unknown;
  seasons?: unknown;
  episodes?: unknown;
}

interface KnabenHit {
  title?: unknown;
  hash?: unknown;
  magnetUrl?: unknown;
  seeders?: unknown;
}

interface StoredSelection {
  household_id: string;
  programme_id: string;
  content_type: StreamContentType;
  video_id: string;
  torrent_id: string;
  info_hash: string;
  file_id: number;
  filename: string;
  quality: string;
  seeders: number;
  selected_at: string;
  stale_at: string;
}

function storedSelection(row: StoredSelection): StreamSelection {
  return {
    householdId: row.household_id,
    programmeId: row.programme_id,
    contentType: row.content_type,
    videoId: row.video_id,
    torrentId: row.torrent_id,
    infoHash: row.info_hash,
    fileId: row.file_id,
    filename: row.filename,
    quality: row.quality,
    seeders: row.seeders,
    selectedAt: row.selected_at,
    staleAt: row.stale_at,
  };
}

function releaseYear(value: string | null): number | undefined {
  const match = value?.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

async function canonicalProgramme(
  db: D1Database,
  householdId: string,
  contentType: StreamContentType,
  videoId: string,
): Promise<CanonicalProgramme | null> {
  if (contentType === "movie") {
    const row = await db.prepare(`SELECT id, imdb_id, title, release_info
      FROM approved_programmes
      WHERE household_id = ? AND content_type = 'movie' AND imdb_id = ?`)
      .bind(householdId, videoId)
      .first<{ id: string; imdb_id: string; title: string; release_info: string | null }>();
    return row ? {
      programmeId: row.id,
      imdbId: row.imdb_id,
      title: row.title,
      year: releaseYear(row.release_info),
    } : null;
  }

  const row = await db.prepare(`SELECT p.id, p.imdb_id, p.title, p.release_info, e.season, e.episode
    FROM approved_programmes p
    JOIN show_episodes e ON e.programme_id = p.id
    WHERE p.household_id = ? AND p.content_type = 'show' AND e.video_id = ?`)
    .bind(householdId, videoId)
    .first<{
      id: string;
      imdb_id: string;
      title: string;
      release_info: string | null;
      season: number;
      episode: number;
    }>();
  return row ? {
    programmeId: row.id,
    imdbId: row.imdb_id,
    title: row.title,
    year: releaseYear(row.release_info),
    season: row.season,
    episode: row.episode,
  } : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function infoHash(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase();
  return normalized && (/^[a-f0-9]{40}$/.test(normalized) || /^[a-z2-7]{32}$/.test(normalized))
    ? normalized
    : null;
}

function hashFromMagnet(value: string): string | null {
  try {
    const magnet = new URL(value);
    if (magnet.protocol !== "magnet:") return null;
    const exactTopic = magnet.searchParams.get("xt");
    return exactTopic?.toLowerCase().startsWith("urn:btih:")
      ? infoHash(exactTopic.slice("urn:btih:".length))
      : null;
  } catch {
    return null;
  }
}

function magnetFor(hash: string, title: string): string {
  const magnet = new URL("magnet:");
  magnet.searchParams.set("xt", `urn:btih:${hash}`);
  magnet.searchParams.set("dn", title);
  return magnet.toString();
}

export function qualityFromRelease(title: string, supplied?: unknown): string {
  const suppliedQuality = text(supplied)?.toLowerCase();
  for (const value of [suppliedQuality, title.toLowerCase()]) {
    if (!value) continue;
    if (/\b(2160p|4k|uhd)\b/.test(value)) return "2160p";
    if (/\b1080[pi]\b/.test(value)) return "1080p";
    if (/\b720[pi]\b/.test(value)) return "720p";
    if (/\b(480[pi]|576[pi]|sd)\b/.test(value)) return "SD";
  }
  return "Unknown quality";
}

function episodePattern(season: number, episode: number): RegExp {
  const seasonValue = String(season);
  const episodeValue = String(episode);
  return new RegExp(
    `(?:^|[^a-z0-9])(?:s0*${seasonValue}[ ._-]*e0*${episodeValue}|0*${seasonValue}x0*${episodeValue})(?:[^0-9]|$)`,
    "i",
  );
}

export function releaseMatchesEpisode(title: string, season: number, episode: number): boolean {
  return episodePattern(season, episode).test(title);
}

function structuredEpisodeMatch(result: ZileanResult, season: number, episode: number): boolean {
  const seasons = Array.isArray(result.seasons) ? result.seasons.map(number) : [];
  const episodes = Array.isArray(result.episodes) ? result.episodes.map(number) : [];
  return seasons.includes(season) && episodes.includes(episode);
}

function zileanCandidates(value: unknown, programme: CanonicalProgramme): DiscoveryCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, providerRank): DiscoveryCandidate[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const result = entry as ZileanResult;
    const hash = infoHash(result.info_hash);
    const title = text(result.raw_title);
    if (!hash || !title) return [];
    if (
      programme.season !== undefined
      && programme.episode !== undefined
      && !releaseMatchesEpisode(title, programme.season, programme.episode)
      && !structuredEpisodeMatch(result, programme.season, programme.episode)
    ) return [];
    return [{
      infoHash: hash,
      magnet: magnetFor(hash, title),
      title,
      quality: qualityFromRelease(title, result.resolution),
      seeders: 0,
      providerRank,
    }];
  });
}

function knabenCandidates(value: unknown, programme: CanonicalProgramme): DiscoveryCandidate[] {
  if (typeof value !== "object" || value === null || !("hits" in value) || !Array.isArray(value.hits)) return [];
  return value.hits.flatMap((entry, providerRank): DiscoveryCandidate[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const hit = entry as KnabenHit;
    const title = text(hit.title);
    const suppliedMagnet = text(hit.magnetUrl);
    const hash = infoHash(hit.hash) ?? (suppliedMagnet ? hashFromMagnet(suppliedMagnet) : null);
    if (!hash || !title) return [];
    const normalizedTitle = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    const normalizedProgrammeTitle = programme.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    if (!normalizedTitle.includes(normalizedProgrammeTitle)) return [];
    if (programme.year !== undefined && !new RegExp(`(?:^|\\D)${programme.year}(?:\\D|$)`).test(title)) return [];
    if (
      programme.season !== undefined
      && programme.episode !== undefined
      && !releaseMatchesEpisode(title, programme.season, programme.episode)
    ) return [];
    return [{
      infoHash: hash,
      magnet: suppliedMagnet ?? magnetFor(hash, title),
      title,
      quality: qualityFromRelease(title),
      seeders: number(hit.seeders),
      providerRank,
    }];
  });
}

function qualityPriority(quality: string): number {
  if (quality === "1080p") return 4;
  if (quality === "2160p") return 3;
  if (quality === "720p") return 2;
  if (quality === "SD") return 1;
  return 0;
}

export function rankCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const deduplicated = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = deduplicated.get(candidate.infoHash);
    if (!existing) {
      deduplicated.set(candidate.infoHash, candidate);
      continue;
    }
    deduplicated.set(candidate.infoHash, {
      ...existing,
      magnet: existing.magnet.length >= candidate.magnet.length ? existing.magnet : candidate.magnet,
      title: existing.title.length >= candidate.title.length ? existing.title : candidate.title,
      quality: qualityPriority(existing.quality) >= qualityPriority(candidate.quality)
        ? existing.quality
        : candidate.quality,
      seeders: Math.max(existing.seeders, candidate.seeders),
      providerRank: Math.min(existing.providerRank ?? Number.MAX_SAFE_INTEGER, candidate.providerRank ?? Number.MAX_SAFE_INTEGER),
    });
  }
  return [...deduplicated.values()].sort((left, right) =>
    qualityPriority(right.quality) - qualityPriority(left.quality)
    || right.seeders - left.seeders
    || (left.providerRank ?? Number.MAX_SAFE_INTEGER) - (right.providerRank ?? Number.MAX_SAFE_INTEGER)
    || left.title.localeCompare(right.title)
    || left.infoHash.localeCompare(right.infoHash));
}

async function providerJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`discovery provider returned HTTP ${response.status}`);
  return response.json();
}

async function discover(programme: CanonicalProgramme, env: StreamSelectionEnv): Promise<DiscoveryCandidate[]> {
  const zileanUrl = new URL("/dmm/filtered", env.ZILEAN_ORIGIN || ZILEAN_ORIGIN);
  zileanUrl.searchParams.set("ImdbId", programme.imdbId);
  if (programme.season !== undefined) zileanUrl.searchParams.set("Season", String(programme.season));
  if (programme.episode !== undefined) zileanUrl.searchParams.set("Episode", String(programme.episode));

  const episodeQuery = programme.season !== undefined && programme.episode !== undefined
    ? ` S${String(programme.season).padStart(2, "0")}E${String(programme.episode).padStart(2, "0")}`
    : "";
  const yearQuery = programme.year ? ` ${programme.year}` : "";
  const knabenUrl = new URL("/v1", env.KNABEN_ORIGIN || KNABEN_ORIGIN);
  const results = await Promise.allSettled([
    providerJson(zileanUrl.toString()),
    providerJson(knabenUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        search_type: "100%",
        search_field: "title",
        query: `${programme.title}${yearQuery}${episodeQuery}`,
        order_by: "seeders",
        order_direction: "desc",
        size: 50,
        hide_unsafe: true,
        hide_xxx: true,
      }),
    }),
  ]);
  const candidates = [
    ...(results[0].status === "fulfilled" ? zileanCandidates(results[0].value, programme) : []),
    ...(results[1].status === "fulfilled" ? knabenCandidates(results[1].value, programme) : []),
  ];
  return rankCandidates(candidates);
}

function formBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

async function realDebridJson(
  origin: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Real-Debrid returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

function torrentId(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id) {
    return value.id;
  }
  throw new Error("Real-Debrid returned an invalid torrent id");
}

function torrentInfo(value: unknown): TorrentInfo {
  if (typeof value !== "object" || value === null) throw new Error("Real-Debrid returned invalid torrent information");
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || !Array.isArray(record.files) || !Array.isArray(record.links)) {
    throw new Error("Real-Debrid returned invalid torrent information");
  }
  const files = record.files.flatMap((entry): TorrentFile[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const file = entry as Record<string, unknown>;
    return typeof file.id === "number" && typeof file.path === "string" && typeof file.bytes === "number"
      ? [{ id: file.id, path: file.path, bytes: file.bytes }]
      : [];
  });
  return {
    status: record.status,
    files,
    links: record.links.filter((link): link is string => typeof link === "string"),
  };
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTorrent(
  origin: string,
  token: string,
  id: string,
  ready: (info: TorrentInfo) => boolean,
  timeoutMs: number,
): Promise<TorrentInfo> {
  const startedAt = performance.now();
  do {
    const info = torrentInfo(await realDebridJson(
      origin,
      token,
      `/torrents/info/${encodeURIComponent(id)}`,
    ));
    if (ready(info)) return info;
    if (["magnet_error", "error", "virus", "dead"].includes(info.status)) {
      throw new Error(`Real-Debrid torrent entered ${info.status} state`);
    }
    await pause(POLL_INTERVAL_MS);
  } while (performance.now() - startedAt < timeoutMs);
  throw new Error("torrent was not instantly available");
}

function selectedFile(files: TorrentFile[], programme: CanonicalProgramme): TorrentFile {
  const videos = files.filter((file) => /\.(mkv|mp4|m4v|avi|webm|ts)$/i.test(file.path));
  const candidates = programme.season !== undefined && programme.episode !== undefined
    ? videos.filter((file) => releaseMatchesEpisode(file.path, programme.season!, programme.episode!))
    : videos;
  const file = [...candidates].sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))[0];
  if (!file) throw new Error("torrent does not contain the requested video file");
  return file;
}

async function deleteTorrent(origin: string, token: string, id: string): Promise<void> {
  const response = await fetch(`${origin}/torrents/delete/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Real-Debrid cleanup returned HTTP ${response.status}`);
}

async function cachedCandidate(
  candidate: DiscoveryCandidate,
  programme: CanonicalProgramme,
  token: string,
  env: StreamSelectionEnv,
): Promise<{ torrentId: string; file: TorrentFile } | null> {
  const origin = (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, "");
  let addedId: string | null = null;
  let stage = "add-magnet";
  try {
    addedId = torrentId(await realDebridJson(origin, token, "/torrents/addMagnet", {
      method: "POST",
      body: formBody({ magnet: candidate.magnet }),
    }));
    stage = "load-files";
    const beforeSelection = await waitForTorrent(
      origin,
      token,
      addedId,
      (info) => info.files.length > 0,
      REQUEST_TIMEOUT_MS,
    );
    stage = "match-file";
    const file = selectedFile(beforeSelection.files, programme);
    stage = "select-file";
    await realDebridJson(origin, token, `/torrents/selectFiles/${encodeURIComponent(addedId)}`, {
      method: "POST",
      body: formBody({ files: String(file.id) }),
    });
    stage = "confirm-cache";
    await waitForTorrent(
      origin,
      token,
      addedId,
      (info) => info.status === "downloaded" && info.links.length > 0,
      CACHE_CHECK_TIMEOUT_MS,
    );
    return { torrentId: addedId, file };
  } catch (error) {
    console.warn(JSON.stringify({
      message: "stream candidate rejected",
      stage,
      reason: error instanceof Error ? error.message : "unknown error",
    }));
    if (addedId) {
      try { await deleteTorrent(origin, token, addedId); } catch { /* best-effort cleanup */ }
    }
    return null;
  }
}

async function cachedSelection(
  db: D1Database,
  householdId: string,
  contentType: StreamContentType,
  videoId: string,
  realDebridToken: string,
  env: StreamSelectionEnv,
  now: Date,
): Promise<StreamSelection | null> {
  const row = await db.prepare(`SELECT * FROM stream_selections
    WHERE household_id = ? AND content_type = ? AND video_id = ?`)
    .bind(householdId, contentType, videoId)
    .first<StoredSelection>();
  if (!row) return null;
  if (Date.parse(row.stale_at) > now.getTime()) return storedSelection(row);
  await db.prepare(`DELETE FROM stream_selections
    WHERE household_id = ? AND content_type = ? AND video_id = ?`)
    .bind(householdId, contentType, videoId)
    .run();
  try {
    await deleteTorrent(
      (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, ""),
      realDebridToken,
      row.torrent_id,
    );
  } catch { /* stale local state must not block reselection */ }
  return null;
}

async function storeSelection(db: D1Database, selection: StreamSelection): Promise<StreamSelection> {
  await db.prepare(`INSERT INTO stream_selections
    (household_id, programme_id, content_type, video_id, torrent_id, info_hash, file_id, filename,
      quality, seeders, selected_at, stale_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (household_id, content_type, video_id) DO NOTHING`)
    .bind(
      selection.householdId,
      selection.programmeId,
      selection.contentType,
      selection.videoId,
      selection.torrentId,
      selection.infoHash,
      selection.fileId,
      selection.filename,
      selection.quality,
      selection.seeders,
      selection.selectedAt,
      selection.staleAt,
    )
    .run();
  const stored = await db.prepare(`SELECT * FROM stream_selections
    WHERE household_id = ? AND content_type = ? AND video_id = ?`)
    .bind(selection.householdId, selection.contentType, selection.videoId)
    .first<StoredSelection>();
  if (!stored) throw new Error("stream selection was not stored");
  return storedSelection(stored);
}

export async function selectCachedStream(
  db: D1Database,
  householdId: string,
  contentType: StreamContentType,
  videoId: string,
  realDebridToken: string,
  env: StreamSelectionEnv,
  now = new Date(),
  excludedInfoHashes: ReadonlySet<string> = new Set(),
): Promise<StreamSelection | null> {
  const existing = await cachedSelection(
    db,
    householdId,
    contentType,
    videoId,
    realDebridToken,
    env,
    now,
  );
  if (existing && !excludedInfoHashes.has(existing.infoHash)) return existing;
  if (existing) {
    await db.prepare(`DELETE FROM stream_selections
      WHERE household_id = ? AND content_type = ? AND video_id = ?`)
      .bind(householdId, contentType, videoId)
      .run();
    try {
      await deleteTorrent(
        (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, ""),
        realDebridToken,
        existing.torrentId,
      );
    } catch { /* an excluded remote torrent must not block reselection */ }
  }
  const programme = await canonicalProgramme(db, householdId, contentType, videoId);
  if (!programme) return null;

  const candidates = await discover(programme, env);
  const eligibleCandidates = candidates.filter((candidate) => !excludedInfoHashes.has(candidate.infoHash));
  for (const candidate of eligibleCandidates.slice(0, MAX_CACHE_CHECKS)) {
    const cached = await cachedCandidate(candidate, programme, realDebridToken, env);
    if (!cached) continue;
    const selection: StreamSelection = {
      householdId,
      programmeId: programme.programmeId,
      contentType,
      videoId,
      torrentId: cached.torrentId,
      infoHash: candidate.infoHash,
      fileId: cached.file.id,
      filename: cached.file.path.replace(/^.*\//, ""),
      quality: candidate.quality,
      seeders: candidate.seeders,
      selectedAt: now.toISOString(),
      staleAt: new Date(now.getTime() + SELECTION_TTL_MS).toISOString(),
    };
    try {
      const stored = await storeSelection(db, selection);
      if (stored.torrentId !== selection.torrentId) {
        try {
          await deleteTorrent(
            (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, ""),
            realDebridToken,
            selection.torrentId,
          );
        } catch { /* the concurrent winner remains valid */ }
      }
      return stored;
    } catch (error) {
      try {
        await deleteTorrent((env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, ""), realDebridToken, cached.torrentId);
      } catch { /* preserve the storage error */ }
      throw error;
    }
  }
  return null;
}
