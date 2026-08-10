PRAGMA defer_foreign_keys = on;

CREATE TABLE channels (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('tv', 'movie')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  legacy_key TEXT CHECK (legacy_key IN ('tv', 'movie')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  UNIQUE (household_id, legacy_key)
);

CREATE INDEX channels_household_type_idx
  ON channels (household_id, channel_type, created_at, id);

CREATE TRIGGER channels_limit_insert
BEFORE INSERT ON channels
WHEN (SELECT COUNT(*) FROM channels
      WHERE household_id = NEW.household_id AND channel_type = NEW.channel_type) >= 5
BEGIN
  SELECT RAISE(ABORT, 'channel type limit reached');
END;

INSERT INTO channels (id, household_id, channel_type, name, legacy_key, created_at)
SELECT id || '-tv', id, 'tv', 'TV Channel', 'tv', created_at FROM households;

INSERT INTO channels (id, household_id, channel_type, name, legacy_key, created_at)
SELECT id || '-movie', id, 'movie', 'Movie Channel', 'movie', created_at FROM households;

CREATE TABLE channel_assignments (
  channel_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  next_video_id TEXT,
  paused_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, programme_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX channel_assignments_programme_idx
  ON channel_assignments (programme_id, channel_id);

INSERT INTO channel_assignments (channel_id, programme_id, next_video_id, paused_at, created_at)
SELECT programme.household_id || CASE programme.content_type WHEN 'show' THEN '-tv' ELSE '-movie' END,
  programme.id, progress.next_video_id, programme.paused_at, programme.approved_at
FROM approved_programmes programme
LEFT JOIN show_progress progress ON progress.programme_id = programme.id;

CREATE TABLE current_programmes_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (channel_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

INSERT INTO current_programmes_v2
SELECT household_id, household_id || CASE channel WHEN 'tv' THEN '-tv' ELSE '-movie' END,
  programme_id, video_id, selected_at FROM current_programmes;

DROP TABLE current_programmes;
ALTER TABLE current_programmes_v2 RENAME TO current_programmes;
CREATE INDEX current_programmes_video_idx
  ON current_programmes (household_id, channel_id, video_id);

CREATE TABLE channel_state_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT PRIMARY KEY NOT NULL,
  current_position INTEGER NOT NULL,
  selection_seed TEXT NOT NULL,
  initialized_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO channel_state_v2
SELECT household_id, household_id || '-tv', current_position, selection_seed, initialized_at
FROM channel_state WHERE channel = 'tv';
DROP TABLE channel_state;
ALTER TABLE channel_state_v2 RENAME TO channel_state;

CREATE TABLE channel_schedule_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);
INSERT INTO channel_schedule_v2
SELECT household_id, household_id || '-tv', position, programme_id, video_id, scheduled_at
FROM channel_schedule WHERE channel = 'tv';
DROP TABLE channel_schedule;
ALTER TABLE channel_schedule_v2 RENAME TO channel_schedule;
CREATE UNIQUE INDEX channel_schedule_video_idx
  ON channel_schedule (channel_id, video_id);
CREATE INDEX channel_schedule_household_idx
  ON channel_schedule (household_id, channel_id, position);

CREATE TABLE channel_advancements_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  from_position INTEGER NOT NULL,
  target_position INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  advanced_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, from_position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO channel_advancements_v2
SELECT household_id, household_id || '-tv', from_position, target_position, owner_token, advanced_at
FROM channel_advancements WHERE channel = 'tv';
DROP TABLE channel_advancements;
ALTER TABLE channel_advancements_v2 RENAME TO channel_advancements;

CREATE TABLE tv_advancement_history_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  from_position INTEGER NOT NULL,
  target_position INTEGER NOT NULL,
  previous_programme_id TEXT NOT NULL,
  previous_video_id TEXT NOT NULL,
  target_programme_id TEXT NOT NULL,
  target_video_id TEXT NOT NULL,
  progress_before_json TEXT NOT NULL,
  progress_after_json TEXT NOT NULL,
  advanced_at TEXT NOT NULL,
  undone_at TEXT,
  undo_owner_token TEXT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (previous_programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);
INSERT INTO tv_advancement_history_v2
SELECT id, household_id, household_id || '-tv', from_position, target_position,
  previous_programme_id, previous_video_id, target_programme_id, target_video_id,
  progress_before_json, progress_after_json, advanced_at, undone_at, undo_owner_token
FROM tv_advancement_history;
DROP TABLE tv_advancement_history;
ALTER TABLE tv_advancement_history_v2 RENAME TO tv_advancement_history;
CREATE INDEX tv_advancement_history_channel_idx
  ON tv_advancement_history (channel_id, advanced_at DESC);

CREATE TABLE movie_channel_state_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT PRIMARY KEY NOT NULL,
  cycle INTEGER NOT NULL,
  current_position INTEGER NOT NULL,
  selection_seed TEXT NOT NULL,
  initialized_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO movie_channel_state_v2
SELECT household_id, household_id || '-movie', cycle, current_position,
  selection_seed, initialized_at, revision FROM movie_channel_state;
DROP TABLE movie_channel_state;
ALTER TABLE movie_channel_state_v2 RENAME TO movie_channel_state;

CREATE TABLE movie_rotation_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  programme_id TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (channel_id, cycle, position),
  UNIQUE (channel_id, cycle, programme_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);
INSERT INTO movie_rotation_v2
SELECT household_id, household_id || '-movie', cycle, position, programme_id, consumed_at
FROM movie_rotation;
DROP TABLE movie_rotation;
ALTER TABLE movie_rotation_v2 RENAME TO movie_rotation;

CREATE TABLE movie_advancements_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  advanced_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, cycle, position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO movie_advancements_v2
SELECT household_id, household_id || '-movie', cycle, position, owner_token, advanced_at
FROM movie_advancements;
DROP TABLE movie_advancements;
ALTER TABLE movie_advancements_v2 RENAME TO movie_advancements;

CREATE TABLE movie_channel_mutations_v2 (
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, revision),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO movie_channel_mutations_v2
SELECT household_id, household_id || '-movie', revision, owner_token, claimed_at
FROM movie_channel_mutations;
DROP TABLE movie_channel_mutations;
ALTER TABLE movie_channel_mutations_v2 RENAME TO movie_channel_mutations;

CREATE TABLE movie_playback_history_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO movie_playback_history_v2
SELECT id, household_id, household_id || '-movie', programme_id, imdb_id,
  title, cycle, position, played_at FROM movie_playback_history;
DROP TABLE movie_playback_history;
ALTER TABLE movie_playback_history_v2 RENAME TO movie_playback_history;
CREATE INDEX movie_playback_history_channel_idx
  ON movie_playback_history (channel_id, played_at DESC);

CREATE TABLE tv_preparation_runs_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 25),
  started_at TEXT,
  deadline_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
INSERT INTO tv_preparation_runs_v2 SELECT * FROM tv_preparation_runs;

CREATE TABLE tv_preparation_items_v2 (
  run_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- Preparation visits Channels breadth-first, so the run's own order cannot be
  -- recovered from the Channel-relative schedule position alone.
  sequence INTEGER NOT NULL,
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  show_title TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  episode_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'trying', 'downloading', 'ready', 'unavailable', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  quality TEXT,
  filename TEXT,
  info_hash TEXT,
  message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, channel_id, position),
  FOREIGN KEY (run_id) REFERENCES tv_preparation_runs_v2(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);
INSERT INTO tv_preparation_items_v2
SELECT item.run_id, run.household_id || '-tv', item.position, item.position, item.programme_id,
  item.video_id, item.show_title, item.season, item.episode, item.episode_title,
  item.status, item.attempts, item.quality, item.filename, item.info_hash, item.message, item.updated_at
FROM tv_preparation_items item
JOIN tv_preparation_runs run ON run.id = item.run_id;

DROP TABLE tv_preparation_items;
DROP TABLE tv_preparation_runs;
ALTER TABLE tv_preparation_runs_v2 RENAME TO tv_preparation_runs;
ALTER TABLE tv_preparation_items_v2 RENAME TO tv_preparation_items;
CREATE UNIQUE INDEX tv_preparation_runs_active_household_idx
  ON tv_preparation_runs (household_id) WHERE status IN ('queued', 'running');
CREATE INDEX tv_preparation_runs_household_created_idx
  ON tv_preparation_runs (household_id, created_at DESC);
CREATE INDEX tv_preparation_items_status_idx
  ON tv_preparation_items (run_id, status);

DROP TABLE show_progress;

-- Pause state now belongs to a Channel Assignment rather than the programme.
ALTER TABLE approved_programmes DROP COLUMN paused_at;

PRAGMA defer_foreign_keys = off;
