CREATE TABLE movie_channel_state (
  household_id TEXT PRIMARY KEY NOT NULL,
  cycle INTEGER NOT NULL,
  current_position INTEGER NOT NULL,
  selection_seed TEXT NOT NULL,
  initialized_at TEXT NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE TABLE movie_rotation (
  household_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  programme_id TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (household_id, cycle, position),
  UNIQUE (household_id, cycle, programme_id),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE TABLE movie_advancements (
  household_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  position INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  advanced_at TEXT NOT NULL,
  PRIMARY KEY (household_id, cycle, position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
