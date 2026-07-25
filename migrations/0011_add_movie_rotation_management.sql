ALTER TABLE movie_channel_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE movie_channel_mutations (
  household_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (household_id, revision),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE TABLE movie_playback_history (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX movie_playback_history_household_idx
  ON movie_playback_history (household_id, played_at DESC);
