-- Target the measured production access paths that otherwise scan complete tables.
CREATE INDEX movie_rotation_household_cycle_idx
  ON movie_rotation (household_id, channel_id, cycle);

CREATE INDEX stream_selections_identity_idx
  ON stream_selections (household_id, torrent_id, file_id);

CREATE INDEX canonical_show_episodes_video_idx
  ON canonical_show_episodes (video_id, show_imdb_id);

-- Preparation steps already know this metadata. Persist it with the snapshot so retries do
-- not rediscover the same canonical episode through the Approved Library on every attempt.
ALTER TABLE tv_preparation_items ADD COLUMN show_imdb_id TEXT;
ALTER TABLE tv_preparation_items ADD COLUMN release_info TEXT;
ALTER TABLE tv_preparation_items ADD COLUMN next_attempt_at TEXT;

UPDATE tv_preparation_items
SET show_imdb_id = (
      SELECT programme.imdb_id FROM approved_programmes programme
      WHERE programme.id = tv_preparation_items.programme_id
    ),
    release_info = (
      SELECT canonical.release_info
      FROM approved_programmes programme
      JOIN canonical_shows canonical ON canonical.imdb_id = programme.imdb_id
      WHERE programme.id = tv_preparation_items.programme_id
    );

PRAGMA optimize;
