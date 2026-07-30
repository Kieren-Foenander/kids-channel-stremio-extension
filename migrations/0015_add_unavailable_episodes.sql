CREATE TABLE unavailable_episodes (
  household_id TEXT NOT NULL,
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  unavailable_at TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  PRIMARY KEY (household_id, video_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX unavailable_episodes_retry_idx
  ON unavailable_episodes (household_id, retry_at);
