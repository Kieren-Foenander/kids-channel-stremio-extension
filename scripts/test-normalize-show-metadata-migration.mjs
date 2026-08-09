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

  console.log("D1 migrations preserved Household state, deduplicated canonical rows, and installed retention state.");
} finally {
  rmSync(persistence, { recursive: true, force: true });
}
