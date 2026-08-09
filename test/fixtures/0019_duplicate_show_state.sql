INSERT INTO households (id, secret, pin_salt, pin_hash, created_at)
VALUES
  ('household-a', 'secret-a', 'salt', 'hash', '2026-01-01T00:00:00.000Z'),
  ('household-b', 'secret-b', 'salt', 'hash', '2026-01-02T00:00:00.000Z');

INSERT INTO approved_programmes
  (id, household_id, imdb_id, content_type, title, description, poster, background,
   release_info, genres_json, imdb_rating, approved_at, paused_at)
VALUES
  ('programme-a', 'household-a', 'tt1234567', 'show', 'Example Show', 'Description',
   'poster', 'background', '2020', '["Family"]', '8.0', '2026-01-01T00:00:00.000Z', NULL),
  ('programme-b', 'household-b', 'tt1234567', 'show', 'Example Show', 'Description',
   'poster', 'background', '2020', '["Family"]', '8.0', '2026-01-02T00:00:00.000Z', NULL);

INSERT INTO show_episodes
  (programme_id, video_id, season, episode, title, released_at, overview)
VALUES
  ('programme-a', 'tt1234567:1:1', 1, 1, 'First', '2020-01-01T00:00:00.000Z', 'First overview'),
  ('programme-a', 'tt1234567:1:2', 1, 2, 'Second', '2020-01-08T00:00:00.000Z', 'Second overview'),
  ('programme-b', 'tt1234567:1:1', 1, 1, 'First', '2020-01-01T00:00:00.000Z', 'First overview'),
  ('programme-b', 'tt1234567:1:2', 1, 2, 'Second', '2020-01-08T00:00:00.000Z', 'Second overview');

INSERT INTO show_progress (programme_id, next_video_id)
VALUES
  ('programme-a', 'tt1234567:1:1'),
  ('programme-b', 'tt1234567:1:2');

INSERT INTO current_programmes
  (household_id, channel, programme_id, video_id, selected_at)
VALUES
  ('household-a', 'tv', 'programme-a', 'tt1234567:1:1', '2026-01-03T00:00:00.000Z'),
  ('household-b', 'tv', 'programme-b', 'tt1234567:1:2', '2026-01-03T00:00:00.000Z');

INSERT INTO channel_state
  (household_id, channel, current_position, selection_seed, initialized_at)
VALUES
  ('household-a', 'tv', 0, 'seed-a', '2026-01-03T00:00:00.000Z'),
  ('household-b', 'tv', 0, 'seed-b', '2026-01-03T00:00:00.000Z');

INSERT INTO channel_schedule
  (household_id, channel, position, programme_id, video_id, scheduled_at)
VALUES
  ('household-a', 'tv', 0, 'programme-a', 'tt1234567:1:1', '2026-01-03T00:00:00.000Z'),
  ('household-b', 'tv', 0, 'programme-b', 'tt1234567:1:2', '2026-01-03T00:00:00.000Z');

