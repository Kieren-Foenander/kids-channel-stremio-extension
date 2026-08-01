CREATE TABLE tv_preparation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 20),
  started_at TEXT,
  deadline_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX tv_preparation_runs_active_household_idx
  ON tv_preparation_runs (household_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX tv_preparation_runs_household_created_idx
  ON tv_preparation_runs (household_id, created_at DESC);

CREATE TABLE tv_preparation_items (
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
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
  PRIMARY KEY (run_id, position),
  FOREIGN KEY (run_id) REFERENCES tv_preparation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX tv_preparation_items_status_idx
  ON tv_preparation_items (run_id, status);
