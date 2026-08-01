ALTER TABLE stream_selections
  ADD COLUMN last_progress REAL NOT NULL DEFAULT 0;

ALTER TABLE stream_selections
  ADD COLUMN last_progress_at TEXT;

CREATE TABLE stream_candidate_failures (
  household_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('series', 'movie')),
  video_id TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  PRIMARY KEY (household_id, content_type, video_id, info_hash),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX stream_candidate_failures_retry_idx
  ON stream_candidate_failures (household_id, content_type, video_id, retry_at);
