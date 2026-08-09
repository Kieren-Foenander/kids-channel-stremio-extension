export const CHANNEL_RETENTION = {
  claimHours: 24,
  playbackHistoryPerHousehold: 10,
  preparationRunsPerHousehold: 10,
  // D1 permits 100 bound parameters per statement; reserve ten for cutoffs and limits.
  householdsPerSweep: 90,
  rowsPerTablePerSweep: 500,
} as const;

const CURSOR_NAME = "channel-retention";

export interface ChannelRetentionResult {
  households: number;
  wrapped: boolean;
  deleted: Record<string, number>;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function pruneObsoleteChannelState(
  db: D1Database,
  now = new Date(),
  householdLimit: number = CHANNEL_RETENTION.householdsPerSweep,
  rowLimit: number = CHANNEL_RETENTION.rowsPerTablePerSweep,
): Promise<ChannelRetentionResult> {
  const cursor = await db.prepare("SELECT last_household_id FROM maintenance_cursors WHERE name = ?")
    .bind(CURSOR_NAME).first<{ last_household_id: string | null }>();
  const households = await db.prepare(`SELECT id FROM households
    WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
    .bind(cursor?.last_household_id ?? null, cursor?.last_household_id ?? null, householdLimit)
    .all<{ id: string }>();

  if (households.results.length === 0) {
    const timestamp = now.toISOString();
    await db.prepare(`INSERT INTO maintenance_cursors (name, last_household_id, updated_at)
      VALUES (?, NULL, ?) ON CONFLICT(name) DO UPDATE SET last_household_id = NULL, updated_at = excluded.updated_at`)
      .bind(CURSOR_NAME, timestamp).run();
    return { households: 0, wrapped: Boolean(cursor?.last_household_id), deleted: {} };
  }

  const householdIds = households.results.map((household) => household.id);
  const householdSql = placeholders(householdIds.length);
  const cutoff = new Date(now.getTime() - CHANNEL_RETENTION.claimHours * 60 * 60 * 1000).toISOString();
  const timestamp = now.toISOString();
  const statements = [
    db.prepare(`DELETE FROM channel_advancements WHERE rowid IN (
      SELECT claim.rowid FROM channel_advancements claim
      WHERE claim.household_id IN (${householdSql}) AND claim.advanced_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM tv_advancement_history history
          JOIN channel_state state ON state.household_id = history.household_id AND state.channel = 'tv'
          WHERE history.household_id = claim.household_id AND history.from_position = claim.from_position
            AND history.id = claim.owner_token AND history.undone_at IS NULL
            AND history.target_position = state.current_position
        )
      LIMIT ?
    )`).bind(...householdIds, cutoff, rowLimit),
    db.prepare(`DELETE FROM movie_advancements WHERE rowid IN (
      SELECT rowid FROM movie_advancements
      WHERE household_id IN (${householdSql}) AND advanced_at < ? LIMIT ?
    )`).bind(...householdIds, cutoff, rowLimit),
    db.prepare(`DELETE FROM movie_channel_mutations WHERE rowid IN (
      SELECT rowid FROM movie_channel_mutations
      WHERE household_id IN (${householdSql}) AND claimed_at < ? LIMIT ?
    )`).bind(...householdIds, cutoff, rowLimit),
    db.prepare(`DELETE FROM tv_advancement_history WHERE id IN (
      SELECT id FROM (
        SELECT id, household_id, target_position, undone_at,
          ROW_NUMBER() OVER (PARTITION BY household_id ORDER BY advanced_at DESC, id DESC) AS history_rank
        FROM tv_advancement_history WHERE household_id IN (${householdSql})
      ) old
      WHERE old.history_rank > ? AND NOT EXISTS (
        SELECT 1 FROM channel_state state
        WHERE state.household_id = old.household_id AND state.channel = 'tv'
          AND old.undone_at IS NULL AND old.target_position = state.current_position
      ) LIMIT ?
    )`).bind(...householdIds, CHANNEL_RETENTION.playbackHistoryPerHousehold, rowLimit),
    db.prepare(`DELETE FROM movie_playback_history WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY household_id ORDER BY played_at DESC, id DESC
        ) AS history_rank
        FROM movie_playback_history WHERE household_id IN (${householdSql})
      ) old WHERE old.history_rank > ? LIMIT ?
    )`).bind(...householdIds, CHANNEL_RETENTION.playbackHistoryPerHousehold, rowLimit),
    db.prepare(`DELETE FROM movie_rotation WHERE rowid IN (
      SELECT rotation.rowid FROM movie_rotation rotation
      JOIN movie_channel_state state ON state.household_id = rotation.household_id
      WHERE rotation.household_id IN (${householdSql}) AND rotation.cycle < state.cycle LIMIT ?
    )`).bind(...householdIds, rowLimit),
    db.prepare(`DELETE FROM tv_preparation_runs WHERE id IN (
      SELECT id FROM (
        SELECT id, status, ROW_NUMBER() OVER (
          PARTITION BY household_id ORDER BY created_at DESC, id DESC
        ) AS run_rank
        FROM tv_preparation_runs WHERE household_id IN (${householdSql})
      ) old WHERE old.run_rank > ? AND old.status NOT IN ('queued', 'running') LIMIT ?
    )`).bind(...householdIds, CHANNEL_RETENTION.preparationRunsPerHousehold, rowLimit),
    db.prepare(`DELETE FROM stream_selections WHERE rowid IN (
      SELECT rowid FROM stream_selections
      WHERE household_id IN (${householdSql}) AND stale_at <= ? LIMIT ?
    )`).bind(...householdIds, timestamp, rowLimit),
    db.prepare(`DELETE FROM stream_candidate_failures WHERE rowid IN (
      SELECT rowid FROM stream_candidate_failures
      WHERE household_id IN (${householdSql}) AND retry_at <= ? LIMIT ?
    )`).bind(...householdIds, timestamp, rowLimit),
    db.prepare(`DELETE FROM unavailable_episodes WHERE rowid IN (
      SELECT rowid FROM unavailable_episodes
      WHERE household_id IN (${householdSql}) AND retry_at <= ? LIMIT ?
    )`).bind(...householdIds, timestamp, rowLimit),
  ];
  const tables = [
    "channel_advancements",
    "movie_advancements",
    "movie_channel_mutations",
    "tv_advancement_history",
    "movie_playback_history",
    "movie_rotation",
    "tv_preparation_runs",
    "stream_selections",
    "stream_candidate_failures",
    "unavailable_episodes",
  ];
  const results = await db.batch(statements);
  const deleted = Object.fromEntries(results.map((result, index) => [tables[index], result.meta.changes]));
  await db.prepare(`INSERT INTO maintenance_cursors (name, last_household_id, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET
      last_household_id = excluded.last_household_id, updated_at = excluded.updated_at`)
    .bind(CURSOR_NAME, householdIds.at(-1), timestamp).run();
  return { households: householdIds.length, wrapped: false, deleted };
}
