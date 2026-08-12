import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const persistence = mkdtempSync(join(tmpdir(), "kids-channels-migration-"));
const wrangler = resolve(root, "node_modules/.bin/wrangler");

function execute(args, capture = false) {
  return execFileSync(wrangler, ["d1", "execute", "kids-channels", "--local", "--persist-to", persistence, "--yes", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "ignore",
  });
}

function query(sql) {
  const output = execute(["--command", sql, "--json"], true);
  const result = JSON.parse(output);
  return result[0]?.results ?? [];
}

const automaticPreparationSql = `SELECT household.id FROM households household
  WHERE household.torbox_token_ciphertext IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tv_preparation_runs run
      WHERE run.household_id = household.id AND run.status IN ('queued', 'running')
    )
    AND EXISTS (
      SELECT 1 FROM channel_schedule schedule
      WHERE schedule.household_id = household.id AND schedule.channel = 'tv'
        AND NOT EXISTS (
          SELECT 1 FROM stream_selections selection
          WHERE selection.household_id = household.id AND selection.content_type = 'series'
            AND selection.video_id = schedule.video_id AND selection.download_pending = 0
            AND selection.stale_at > '2026-08-09T00:00:00.000Z'
        )
    )
  ORDER BY household.created_at LIMIT 100`;

try {
  const legacyMigrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^00(0[1-9]|1\d)_.*\.sql$/.test(name))
    .sort();
  for (const migration of legacyMigrations) {
    execute(["--file", join(root, "migrations", migration)]);
  }
  execute(["--file", join(root, "test/fixtures/0019_duplicate_show_state.sql")]);
  execute(["--file", join(root, "migrations/0020_normalize_show_metadata.sql")]);
  execute(["--file", join(root, "migrations/0021_add_channel_retention_cursor.sql")]);

  const counts = query(`SELECT
    (SELECT COUNT(*) FROM canonical_shows) AS canonical_shows,
    (SELECT COUNT(*) FROM canonical_show_episodes) AS canonical_episodes,
    (SELECT COUNT(*) FROM approved_programmes) AS approvals,
    (SELECT COUNT(*) FROM show_episodes) AS logical_episodes`)[0];
  if (counts?.canonical_shows !== 1 || counts.canonical_episodes !== 2
    || counts.approvals !== 2 || counts.logical_episodes !== 4) {
    throw new Error(`canonical migration counts were not preserved: ${JSON.stringify(counts)}`);
  }

  const state = query(`SELECT progress.programme_id, progress.next_video_id,
      current.video_id AS current_video_id, schedule.video_id AS scheduled_video_id,
      canonical.title AS show_title
    FROM show_progress progress
    JOIN approved_programmes programme ON programme.id = progress.programme_id
    JOIN canonical_shows canonical ON canonical.imdb_id = programme.imdb_id
    JOIN current_programmes current ON current.programme_id = programme.id AND current.channel = 'tv'
    JOIN channel_schedule schedule ON schedule.programme_id = programme.id AND schedule.channel = 'tv'
    ORDER BY progress.programme_id`);
  const expected = [
    { programme_id: "programme-a", next_video_id: "tt1234567:1:1", current_video_id: "tt1234567:1:1", scheduled_video_id: "tt1234567:1:1", show_title: "Example Show" },
    { programme_id: "programme-b", next_video_id: "tt1234567:1:2", current_video_id: "tt1234567:1:2", scheduled_video_id: "tt1234567:1:2", show_title: "Example Show" },
  ];
  if (JSON.stringify(state) !== JSON.stringify(expected)) {
    throw new Error(`Household Channel state was not preserved: ${JSON.stringify(state)}`);
  }

  const snapshots = query("SELECT title, description, poster, background, release_info, genres_json, imdb_rating FROM approved_programmes ORDER BY id");
  if (snapshots.some((row) => row.title !== "" || row.description !== null || row.poster !== null
    || row.background !== null || row.release_info !== null || row.genres_json !== "[]" || row.imdb_rating !== null)) {
    throw new Error(`Household show metadata snapshots remain populated: ${JSON.stringify(snapshots)}`);
  }

  const retentionCursor = query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'maintenance_cursors'");
  if (retentionCursor[0]?.name !== "maintenance_cursors") {
    throw new Error("Channel retention cursor migration was not applied");
  }

  execute(["--command", `WITH RECURSIVE sequence(value) AS (
      VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 639
    )
    INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
    SELECT printf('benchmark-%04d', value), printf('benchmark-secret-%04d', value),
      'salt', 'hash', printf('2026-08-09T00:%02d:00.000Z', value % 60)
    FROM sequence`]);
  execute(["--command", "UPDATE households SET torbox_token_ciphertext = 'configured' WHERE id = 'household-a'"]);

  const benchmarkCounts = query(`SELECT COUNT(*) AS households,
    COUNT(torbox_token_ciphertext) AS configured_households FROM households`)[0];
  const beforeIndex = query(automaticPreparationSql);
  const beforePlan = query(`EXPLAIN QUERY PLAN ${automaticPreparationSql}`);
  if (benchmarkCounts?.households !== 641 || benchmarkCounts.configured_households !== 1
    || JSON.stringify(beforeIndex) !== JSON.stringify([{ id: "household-a" }])
    || !beforePlan.some((row) => row.detail === "SCAN household")
    || !beforePlan.some((row) => row.detail === "USE TEMP B-TREE FOR ORDER BY")) {
    throw new Error(`automatic preparation baseline changed: ${JSON.stringify({ benchmarkCounts, beforeIndex, beforePlan })}`);
  }

  execute(["--file", join(root, "migrations/0022_audit_household_indexes.sql")]);

  const afterIndex = query(automaticPreparationSql);
  const afterPlan = query(`EXPLAIN QUERY PLAN ${automaticPreparationSql}`);
  if (JSON.stringify(afterIndex) !== JSON.stringify(beforeIndex)
    || !afterPlan.some((row) => row.detail.includes("USING INDEX households_automatic_preparation_idx"))
    || afterPlan.some((row) => row.detail === "USE TEMP B-TREE FOR ORDER BY")) {
    throw new Error(`automatic preparation index was ineffective: ${JSON.stringify({ beforeIndex, afterIndex, afterPlan })}`);
  }

  const secretPlan = query("EXPLAIN QUERY PLAN SELECT id FROM households WHERE secret = 'secret-a'");
  if (!secretPlan.some((row) => row.detail.includes("sqlite_autoindex_households_2 (secret=?)"))) {
    throw new Error(`Household secret lookup lost its UNIQUE access path: ${JSON.stringify(secretPlan)}`);
  }
  let duplicateSecretRejected = false;
  try {
    execute(["--command", `INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
      VALUES ('duplicate-secret', 'secret-a', 'salt', 'hash', '2026-08-09T01:00:00.000Z')`]);
  } catch {
    duplicateSecretRejected = true;
  }
  if (!duplicateSecretRejected) throw new Error("Household secret uniqueness was not enforced");

  execute(["--file", join(root, "migrations/rollback/0022_restore_household_indexes.sql")]);
  const rolledBackIndexes = query(`SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name IN ('households_secret_idx', 'households_automatic_preparation_idx')
    ORDER BY name`);
  if (JSON.stringify(rolledBackIndexes) !== JSON.stringify([{ name: "households_secret_idx" }])) {
    throw new Error(`Household index rollback failed: ${JSON.stringify(rolledBackIndexes)}`);
  }
  execute(["--file", join(root, "migrations/0022_audit_household_indexes.sql")]);

  execute(["--file", join(root, "migrations/0023_add_multiple_channels.sql")]);
  const channelCounts = query(`SELECT
    (SELECT COUNT(*) FROM channels) AS channels,
    (SELECT COUNT(*) FROM channel_assignments) AS assignments,
    (SELECT COUNT(*) FROM channels WHERE legacy_key = 'tv') AS tv_defaults,
    (SELECT COUNT(*) FROM channels WHERE legacy_key = 'movie') AS movie_defaults`)[0];
  if (channelCounts?.channels !== 1282 || channelCounts.assignments !== 2
    || channelCounts.tv_defaults !== 641 || channelCounts.movie_defaults !== 641) {
    throw new Error(`multiple Channel defaults or assignments were not migrated: ${JSON.stringify(channelCounts)}`);
  }
  const migratedState = query(`SELECT assignment.programme_id, assignment.next_video_id,
      current.video_id AS current_video_id, schedule.video_id AS scheduled_video_id,
      channel.legacy_key
    FROM channel_assignments assignment
    JOIN channels channel ON channel.id = assignment.channel_id
    JOIN current_programmes current ON current.programme_id = assignment.programme_id
      AND current.channel_id = assignment.channel_id
    JOIN channel_schedule schedule ON schedule.programme_id = assignment.programme_id
      AND schedule.channel_id = assignment.channel_id
    ORDER BY assignment.programme_id`);
  const expectedMigratedState = expected.map((row) => ({
    programme_id: row.programme_id,
    next_video_id: row.next_video_id,
    current_video_id: row.current_video_id,
    scheduled_video_id: row.scheduled_video_id,
    legacy_key: "tv",
  }));
  if (JSON.stringify(migratedState) !== JSON.stringify(expectedMigratedState)) {
    throw new Error(`multiple Channel state was not preserved: ${JSON.stringify(migratedState)}`);
  }
  if (query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'show_progress'").length !== 0) {
    throw new Error("legacy show_progress table remains after multiple Channel migration");
  }
  const foreignKeyFailures = query("PRAGMA foreign_key_check");
  if (foreignKeyFailures.length !== 0) {
    throw new Error(`multiple Channel migration left invalid foreign keys: ${JSON.stringify(foreignKeyFailures)}`);
  }
  let channelLimitRejected = false;
  try {
    execute(["--command", `INSERT INTO channels (id, household_id, channel_type, name, created_at) VALUES
      ('extra-tv-1', 'household-a', 'tv', 'Same', '2026-08-10T00:00:00.000Z'),
      ('extra-tv-2', 'household-a', 'tv', 'Same', '2026-08-10T00:00:01.000Z'),
      ('extra-tv-3', 'household-a', 'tv', 'Same', '2026-08-10T00:00:02.000Z'),
      ('extra-tv-4', 'household-a', 'tv', 'Same', '2026-08-10T00:00:03.000Z'),
      ('extra-tv-5', 'household-a', 'tv', 'Same', '2026-08-10T00:00:04.000Z')`]);
  } catch {
    channelLimitRejected = true;
  }
  if (!channelLimitRejected) throw new Error("five Channel limit was not enforced");

  console.log("D1 migrations preserved Household state, added default named Channels, and retained indexed automatic preparation scans.");
} finally {
  rmSync(persistence, { recursive: true, force: true });
}
