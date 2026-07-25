ALTER TABLE households ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE pin_attempts (
  household_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER,
  PRIMARY KEY (household_id, origin_hash),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
