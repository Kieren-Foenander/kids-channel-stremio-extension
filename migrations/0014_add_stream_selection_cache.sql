CREATE TABLE stream_selections (
  household_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('series', 'movie')),
  video_id TEXT NOT NULL,
  torrent_id TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  quality TEXT NOT NULL,
  seeders INTEGER NOT NULL,
  selected_at TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  PRIMARY KEY (household_id, content_type, video_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX stream_selections_stale_idx
  ON stream_selections (household_id, stale_at);
