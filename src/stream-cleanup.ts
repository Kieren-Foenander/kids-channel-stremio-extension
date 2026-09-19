import { deleteTorBoxTorrent, type TorBoxEnv } from "./torbox";

/** A season pack can back multiple episodes. Removing one selection must not
 * remove the remote torrent still used by another ready or pending selection. */
export async function deleteUnreferencedStreamTorrent(
  db: D1Database,
  householdId: string,
  token: string,
  env: TorBoxEnv,
  torrentId: string,
): Promise<void> {
  const referenced = await db.prepare(`SELECT 1 FROM stream_selections
    WHERE household_id = ? AND torrent_id = ? LIMIT 1`)
    .bind(householdId, torrentId).first();
  if (!referenced) await deleteTorBoxTorrent(token, env, torrentId);
}
