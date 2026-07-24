import type { CinemetaEpisode } from "./cinemeta";

export interface TvCurrentProgramme {
  programmeId: string;
  imdbId: string;
  showTitle: string;
  description?: string;
  poster?: string;
  background?: string;
  episode: CinemetaEpisode;
}

interface CurrentProgrammeRow {
  programme_id: string;
  imdb_id: string;
  show_title: string;
  description: string | null;
  poster: string | null;
  background: string | null;
  video_id: string;
  season: number;
  episode: number;
  episode_title: string;
  released_at: string;
  overview: string | null;
}

function fromRow(row: CurrentProgrammeRow): TvCurrentProgramme {
  return {
    programmeId: row.programme_id,
    imdbId: row.imdb_id,
    showTitle: row.show_title,
    description: row.description ?? undefined,
    poster: row.poster ?? undefined,
    background: row.background ?? undefined,
    episode: {
      id: row.video_id,
      season: row.season,
      episode: row.episode,
      title: row.episode_title,
      released: row.released_at,
      overview: row.overview ?? undefined,
    },
  };
}

async function selectedTvProgramme(db: D1Database, householdId: string): Promise<TvCurrentProgramme | null> {
  const row = await db.prepare(`SELECT current.programme_id, programme.imdb_id, programme.title AS show_title,
      programme.description, programme.poster, programme.background, episode.video_id, episode.season,
      episode.episode, episode.title AS episode_title, episode.released_at, episode.overview
    FROM current_programmes current
    JOIN approved_programmes programme ON programme.id = current.programme_id
    JOIN show_episodes episode ON episode.programme_id = current.programme_id AND episode.video_id = current.video_id
    WHERE current.household_id = ? AND current.channel = 'tv'`)
    .bind(householdId).first<CurrentProgrammeRow>();
  return row ? fromRow(row) : null;
}

export async function tvCurrentProgramme(db: D1Database, householdId: string): Promise<TvCurrentProgramme | null> {
  const existing = await selectedTvProgramme(db, householdId);
  if (existing) return existing;

  await db.prepare(`INSERT OR IGNORE INTO current_programmes
      (household_id, channel, programme_id, video_id, selected_at)
    SELECT programme.household_id, 'tv', programme.id, progress.next_video_id, ?
    FROM approved_programmes programme
    JOIN show_progress progress ON progress.programme_id = programme.id
    JOIN show_episodes episode ON episode.programme_id = programme.id AND episode.video_id = progress.next_video_id
    WHERE programme.household_id = ? AND programme.content_type = 'show'
    ORDER BY programme.approved_at, programme.id
    LIMIT 1`)
    .bind(new Date().toISOString(), householdId).run();

  return selectedTvProgramme(db, householdId);
}
