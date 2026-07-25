CREATE TABLE channel_state (
  household_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('tv', 'movie')),
  current_position INTEGER NOT NULL,
  selection_seed TEXT NOT NULL,
  initialized_at TEXT NOT NULL,
  PRIMARY KEY (household_id, channel),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE TABLE channel_schedule (
  household_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('tv', 'movie')),
  position INTEGER NOT NULL,
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  PRIMARY KEY (household_id, channel, position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_schedule_video_idx
  ON channel_schedule (household_id, channel, video_id);

CREATE TABLE channel_advancements (
  household_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('tv', 'movie')),
  from_position INTEGER NOT NULL,
  target_position INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  advanced_at TEXT NOT NULL,
  PRIMARY KEY (household_id, channel, from_position),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
