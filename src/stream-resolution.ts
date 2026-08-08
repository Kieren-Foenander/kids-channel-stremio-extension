import {
  deleteTorBoxTorrent,
  getTorBoxTorrent,
  requestTorBoxDownload,
  TorBoxRequestError,
  type TorBoxEnv,
} from "./torbox";

export type StreamResolutionEnv = TorBoxEnv;

export interface StreamIdentity {
  torrentId: string;
  fileId: number;
}

interface StoredSelection {
  content_type: "series" | "movie";
  video_id: string;
  info_hash: string;
  stale_at: string;
}

export class StreamSelectionGoneError extends Error {}

export class TorBoxResolutionError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly retryAfter: string | null = null,
  ) {
    super("TorBox could not resolve the selected stream");
  }
}

export interface StreamSelectionContext {
  contentType: "series" | "movie";
  videoId: string;
  infoHash: string;
}

export async function streamSelectionContext(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
  now = Date.now(),
): Promise<StreamSelectionContext | null> {
  const row = await db.prepare(`SELECT content_type, video_id, info_hash, stale_at FROM stream_selections
    WHERE household_id = ? AND torrent_id = ? AND file_id = ?`)
    .bind(householdId, identity.torrentId, identity.fileId)
    .first<StoredSelection>();
  if (!row || Date.parse(row.stale_at) <= now) return null;
  return {
    contentType: row.content_type,
    videoId: row.video_id,
    infoHash: row.info_hash,
  };
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

export async function discardStreamSelection(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
  torBoxToken: string,
  env: StreamResolutionEnv,
): Promise<void> {
  await invalidateStreamSelection(db, householdId, identity);
  try {
    await deleteTorBoxTorrent(torBoxToken, env, identity.torrentId);
  } catch { /* a dead remote torrent must not block local failover */ }
}

export async function resolveCachedStream(
  db: D1Database,
  householdId: string,
  identity: StreamIdentity,
  torBoxToken: string,
  env: StreamResolutionEnv,
  now = Date.now(),
  userIp?: string,
): Promise<string> {
  if (!(await selectionIsCurrent(db, householdId, identity, now))) {
    throw new StreamSelectionGoneError("stream selection is absent or stale");
  }

  try {
    const torrent = await getTorBoxTorrent(torBoxToken, env, identity.torrentId, true);
    if (!torrent.ready) throw new StreamSelectionGoneError("TorBox torrent is no longer ready");
    if (!torrent.files.some((file) => file.id === identity.fileId)) {
      throw new StreamSelectionGoneError("selected file is no longer present");
    }
    return await requestTorBoxDownload(
      torBoxToken,
      env,
      identity.torrentId,
      identity.fileId,
      userIp,
    );
  } catch (error) {
    if (error instanceof StreamSelectionGoneError) throw error;
    if (error instanceof TorBoxRequestError) {
      if (error.status === 404 || error.code === "DOWNLOAD_NOT_FOUND") {
        throw new StreamSelectionGoneError("TorBox torrent no longer exists");
      }
      throw new TorBoxResolutionError(error.status, error.retryAfter);
    }
    throw new TorBoxResolutionError(null);
  }
}
