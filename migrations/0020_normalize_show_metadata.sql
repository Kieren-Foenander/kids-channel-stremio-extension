PRAGMA defer_foreign_keys = on;

CREATE TABLE canonical_shows (
  imdb_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  poster TEXT,
  background TEXT,
  release_info TEXT,
  genres_json TEXT NOT NULL DEFAULT '[]',
  imdb_rating TEXT
);

CREATE TABLE canonical_show_episodes (
  show_imdb_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT NOT NULL,
  released_at TEXT NOT NULL,
  overview TEXT,
  PRIMARY KEY (show_imdb_id, video_id),
  FOREIGN KEY (show_imdb_id) REFERENCES canonical_shows(imdb_id) ON DELETE CASCADE,
  UNIQUE (show_imdb_id, season, episode)
);

-- Prefer the most recently approved copy when historical Household snapshots differ.
INSERT INTO canonical_shows
  (imdb_id, title, description, poster, background, release_info, genres_json, imdb_rating)
SELECT programme.imdb_id, programme.title, programme.description, programme.poster,
  programme.background, programme.release_info, programme.genres_json, programme.imdb_rating
FROM approved_programmes programme
WHERE programme.content_type = 'show'
  AND NOT EXISTS (
    SELECT 1 FROM approved_programmes newer
    WHERE newer.content_type = 'show' AND newer.imdb_id = programme.imdb_id
      AND (newer.approved_at > programme.approved_at
        OR (newer.approved_at = programme.approved_at AND newer.id > programme.id))
  );

INSERT OR IGNORE INTO canonical_show_episodes
  (show_imdb_id, video_id, season, episode, title, released_at, overview)
SELECT programme.imdb_id, episode.video_id, episode.season, episode.episode,
  episode.title, episode.released_at, episode.overview
FROM show_episodes episode
JOIN approved_programmes programme ON programme.id = episode.programme_id
WHERE programme.content_type = 'show'
ORDER BY programme.approved_at DESC, programme.id DESC;

DROP TABLE show_episodes;

-- Preserve the old logical shape for callers and migrations while the physical rows are canonical.
CREATE VIEW show_episodes AS
SELECT programme.id AS programme_id, episode.video_id, episode.season, episode.episode,
  episode.title, episode.released_at, episode.overview
FROM approved_programmes programme
JOIN canonical_show_episodes episode ON episode.show_imdb_id = programme.imdb_id
WHERE programme.content_type = 'show';

CREATE TRIGGER show_episodes_insert
INSTEAD OF INSERT ON show_episodes
BEGIN
  INSERT INTO canonical_show_episodes
    (show_imdb_id, video_id, season, episode, title, released_at, overview)
  SELECT programme.imdb_id, NEW.video_id, NEW.season, NEW.episode,
    NEW.title, NEW.released_at, NEW.overview
  FROM approved_programmes programme
  WHERE programme.id = NEW.programme_id AND programme.content_type = 'show'
  ON CONFLICT(show_imdb_id, video_id) DO UPDATE SET
    season = excluded.season,
    episode = excluded.episode,
    title = excluded.title,
    released_at = excluded.released_at,
    overview = excluded.overview
  WHERE canonical_show_episodes.season IS NOT excluded.season
    OR canonical_show_episodes.episode IS NOT excluded.episode
    OR canonical_show_episodes.title IS NOT excluded.title
    OR canonical_show_episodes.released_at IS NOT excluded.released_at
    OR canonical_show_episodes.overview IS NOT excluded.overview;
END;

CREATE TRIGGER show_episodes_update
INSTEAD OF UPDATE ON show_episodes
BEGIN
  UPDATE canonical_show_episodes SET
    video_id = NEW.video_id,
    season = NEW.season,
    episode = NEW.episode,
    title = NEW.title,
    released_at = NEW.released_at,
    overview = NEW.overview
  WHERE show_imdb_id = (
    SELECT imdb_id FROM approved_programmes
    WHERE id = OLD.programme_id AND content_type = 'show'
  ) AND video_id = OLD.video_id;
END;

-- Household removal must never delete shared canonical episode metadata.
CREATE TRIGGER show_episodes_delete
INSTEAD OF DELETE ON show_episodes
BEGIN
  SELECT 1;
END;

CREATE TRIGGER approved_show_metadata_insert
AFTER INSERT ON approved_programmes
WHEN NEW.content_type = 'show'
BEGIN
  INSERT INTO canonical_shows
    (imdb_id, title, description, poster, background, release_info, genres_json, imdb_rating)
  VALUES (NEW.imdb_id, NEW.title, NEW.description, NEW.poster, NEW.background,
    NEW.release_info, NEW.genres_json, NEW.imdb_rating)
  ON CONFLICT(imdb_id) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    poster = excluded.poster,
    background = excluded.background,
    release_info = excluded.release_info,
    genres_json = excluded.genres_json,
    imdb_rating = excluded.imdb_rating
  WHERE canonical_shows.title IS NOT excluded.title
    OR canonical_shows.description IS NOT excluded.description
    OR canonical_shows.poster IS NOT excluded.poster
    OR canonical_shows.background IS NOT excluded.background
    OR canonical_shows.release_info IS NOT excluded.release_info
    OR canonical_shows.genres_json IS NOT excluded.genres_json
    OR canonical_shows.imdb_rating IS NOT excluded.imdb_rating;

  UPDATE approved_programmes SET
    title = '', description = NULL, poster = NULL, background = NULL,
    release_info = NULL, genres_json = '[]', imdb_rating = NULL
  WHERE id = NEW.id;
END;

-- Historical show snapshots are no longer authoritative after canonical rows exist.
UPDATE approved_programmes SET
  title = '', description = NULL, poster = NULL, background = NULL,
  release_info = NULL, genres_json = '[]', imdb_rating = NULL
WHERE content_type = 'show';

PRAGMA defer_foreign_keys = off;
