const REAL_DEBRID_ORIGIN = "https://api.real-debrid.com/rest/1.0";
const REQUEST_TIMEOUT_MS = 10_000;

export interface StreamResolutionEnv {
  REAL_DEBRID_ORIGIN?: string;
}

export interface StreamIdentity {
  torrentId: string;
  fileId: number;
}

interface StoredSelection {
  stale_at: string;
}

interface TorrentFile {
  id: number;
  selected: boolean;
}

export class StreamSelectionGoneError extends Error {}

export class RealDebridResolutionError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly retryAfter: string | null = null,
  ) {
    super("Real-Debrid could not resolve the selected stream");
  }
}

async function selectionIsCurrent(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
  now: number,
): Promise<boolean> {
  const row = await db.prepare(`SELECT stale_at FROM stream_selections
    WHERE household_id = ? AND torrent_id = ? AND file_id = ?`)
    .bind(householdId, identity.torrentId, identity.fileId)
    .first<StoredSelection>();
  return Boolean(row && Date.parse(row.stale_at) > now);
}

export async function invalidateStreamSelection(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
): Promise<void> {
  await db.prepare(`DELETE FROM stream_selections
    WHERE household_id = ? AND torrent_id = ? AND file_id = ?`)
    .bind(householdId, identity.torrentId, identity.fileId)
    .run();
}

async function realDebridResponse(
  origin: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${origin}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function torrentRestrictedLink(value: unknown, fileId: number): string {
  if (typeof value !== "object" || value === null) throw new RealDebridResolutionError(null);
  const record = value as Record<string, unknown>;
  if (record.status !== "downloaded") throw new StreamSelectionGoneError("torrent is no longer downloaded");
  if (!Array.isArray(record.files) || !Array.isArray(record.links)) {
    throw new RealDebridResolutionError(null);
  }

  const files = record.files.flatMap((entry): TorrentFile[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const file = entry as Record<string, unknown>;
    if (typeof file.id !== "number") return [];
    return [{ id: file.id, selected: file.selected === 1 || file.selected === true }];
  });
  if (!files.some((file) => file.id === fileId)) {
    throw new StreamSelectionGoneError("selected file is no longer present");
  }

  const links = record.links.filter((link): link is string => typeof link === "string" && link.length > 0);
  const selectedFiles = files.filter((file) => file.selected);
  const selectedIndex = selectedFiles.findIndex((file) => file.id === fileId);
  const link = selectedIndex >= 0 ? links[selectedIndex] : links.length === 1 ? links[0] : null;
  if (!link || !/^https?:\/\//i.test(link)) {
    throw new StreamSelectionGoneError("selected file no longer has a restricted link");
  }
  return link;
}

function directDownload(value: unknown): string {
  if (typeof value !== "object" || value === null || !("download" in value)) {
    throw new RealDebridResolutionError(null);
  }
  const download = value.download;
  if (typeof download !== "string") throw new RealDebridResolutionError(null);
  try {
    const url = new URL(download);
    if (url.protocol !== "https:") throw new RealDebridResolutionError(null);
    return url.toString();
  } catch (error) {
    if (error instanceof RealDebridResolutionError) throw error;
    throw new RealDebridResolutionError(null);
  }
}

export async function resolveCachedStream(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
  realDebridToken: string,
  env: StreamResolutionEnv,
  now = Date.now(),
): Promise<string> {
  if (!(await selectionIsCurrent(db, householdId, identity, now))) {
    throw new StreamSelectionGoneError("stream selection is absent or stale");
  }

  const origin = (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, "");
  const infoResponse = await realDebridResponse(
    origin,
    realDebridToken,
    `/torrents/info/${encodeURIComponent(identity.torrentId)}`,
  );
  if (!infoResponse.ok) {
    try { await infoResponse.body?.cancel(); } catch { /* response may already be owned by the runtime */ }
    if (infoResponse.status === 400 || infoResponse.status === 404) {
      throw new StreamSelectionGoneError("torrent no longer exists");
    }
    throw new RealDebridResolutionError(infoResponse.status, infoResponse.headers.get("retry-after"));
  }
  const restrictedLink = torrentRestrictedLink(await infoResponse.json(), identity.fileId);

  const unrestrictResponse = await realDebridResponse(origin, realDebridToken, "/unrestrict/link", {
    method: "POST",
    body: new URLSearchParams({ link: restrictedLink }),
  });
  if (!unrestrictResponse.ok) {
    try { await unrestrictResponse.body?.cancel(); } catch { /* response may already be owned by the runtime */ }
    if (unrestrictResponse.status === 400 || unrestrictResponse.status === 404) {
      throw new StreamSelectionGoneError("restricted link is no longer valid");
    }
    throw new RealDebridResolutionError(unrestrictResponse.status, unrestrictResponse.headers.get("retry-after"));
  }
  return directDownload(await unrestrictResponse.json());
}
