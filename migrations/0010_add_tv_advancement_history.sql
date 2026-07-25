CREATE TABLE tv_advancement_history (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
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
  FOREIGN KEY (previous_programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX tv_advancement_history_household_idx
  ON tv_advancement_history (household_id, advanced_at DESC);
