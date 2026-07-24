CREATE TABLE current_programmes (
  household_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('tv', 'movie')),
  programme_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (household_id, channel),
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  FOREIGN KEY (programme_id) REFERENCES approved_programmes(id) ON DELETE CASCADE
);

CREATE INDEX current_programmes_video_idx
  ON current_programmes (household_id, channel, video_id);
