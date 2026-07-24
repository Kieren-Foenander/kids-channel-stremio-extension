CREATE TABLE approved_programmes (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('show', 'movie')),
  title TEXT NOT NULL,
  description TEXT,
  poster TEXT,
  background TEXT,
  release_info TEXT,
  genres_json TEXT NOT NULL DEFAULT '[]',
  imdb_rating TEXT,
  approved_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  UNIQUE (household_id, content_type, imdb_id)
);

CREATE INDEX approved_programmes_household_idx
  ON approved_programmes (household_id, approved_at);

CREATE TABLE show_episodes (
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT NOT NULL,
  released_at TEXT NOT NULL,
  overview TEXT,
  PRIMARY KEY (programme_id, video_id),
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE,
  UNIQUE (programme_id, season, episode)
);

CREATE TABLE show_progress (
  programme_id TEXT PRIMARY KEY NOT NULL,
  next_video_id TEXT NOT NULL,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);
