import { reconcileMovieChannel } from "./movie-channel";
import { tvChannelSchedule } from "./tv-channel";

export interface OverviewEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
}

export interface OverviewTvProgramme {
  programmeId: string;
  title: string;
  poster?: string;
  episode: OverviewEpisode;
}

export interface OverviewMovieProgramme {
  programmeId: string;
  title: string;
  poster?: string;
  releaseInfo?: string;
}

export interface HouseholdOverview {
  approved: { shows: number; movies: number };
  tv: { current: OverviewTvProgramme | null; next: OverviewTvProgramme[] };
  movie: { current: OverviewMovieProgramme | null };
}

interface CountRow { shows: number; movies: number }
interface TvRow {
  programme_id: string;
  title: string;
  poster: string | null;
  video_id: string;
  season: number;
  episode: number;
  episode_title: string;
}
interface MovieRow {
  programme_id: string;
  title: string;
  poster: string | null;
  release_info: string | null;
}

function tvProgramme(row: TvRow): OverviewTvProgramme {
  return {
    programmeId: row.programme_id,
    title: row.title,
    poster: row.poster ?? undefined,
    episode: {
      id: row.video_id,
      season: row.season,
      episode: row.episode,
      title: row.episode_title,
    },
  };
}

/** Builds the small Parent Page summary without loading library episode collections,
 * Channel history, or complete Channel rotations. */
export async function householdOverview(
  db: D1Database,
  householdId: string,
  tvSeed?: string,
  movieSeed?: string,
): Promise<HouseholdOverview> {
  // Keep lazy initialization, but do not rebuild valid Channel state during a read.
  await tvChannelSchedule(db, householdId, tvSeed);
  await reconcileMovieChannel(db, householdId, movieSeed);

  const [counts, currentTv, nextTvRows, currentMovie] = await Promise.all([
    db.prepare(`SELECT
      SUM(CASE WHEN content_type = 'show' THEN 1 ELSE 0 END) AS shows,
      SUM(CASE WHEN content_type = 'movie' THEN 1 ELSE 0 END) AS movies
      FROM approved_programmes WHERE household_id = ?`).bind(householdId).first<CountRow>(),
    db.prepare(`SELECT programme.id AS programme_id, canonical.title, canonical.poster,
        episode.video_id, episode.season, episode.episode, episode.title AS episode_title
      FROM current_programmes current
      JOIN approved_programmes programme ON programme.id = current.programme_id AND programme.household_id = current.household_id
      JOIN canonical_shows canonical ON canonical.imdb_id = programme.imdb_id
      JOIN show_episodes episode ON episode.programme_id = current.programme_id AND episode.video_id = current.video_id
      WHERE current.household_id = ? AND current.channel = 'tv'`).bind(householdId).first<TvRow>(),
    db.prepare(`SELECT programme.id AS programme_id, canonical.title, canonical.poster,
        episode.video_id, episode.season, episode.episode, episode.title AS episode_title
      FROM channel_schedule schedule
      JOIN channel_state state ON state.household_id = schedule.household_id AND state.channel = schedule.channel
      JOIN approved_programmes programme ON programme.id = schedule.programme_id AND programme.household_id = schedule.household_id
      JOIN canonical_shows canonical ON canonical.imdb_id = programme.imdb_id
      JOIN show_episodes episode ON episode.programme_id = schedule.programme_id AND episode.video_id = schedule.video_id
      WHERE schedule.household_id = ? AND schedule.channel = 'tv' AND schedule.position > state.current_position
      ORDER BY schedule.position
      LIMIT 2`).bind(householdId).all<TvRow>(),
    db.prepare(`SELECT programme.id AS programme_id, programme.title, programme.poster, programme.release_info
      FROM current_programmes current
      JOIN approved_programmes programme ON programme.id = current.programme_id AND programme.household_id = current.household_id
      WHERE current.household_id = ? AND current.channel = 'movie' AND programme.content_type = 'movie'`)
      .bind(householdId).first<MovieRow>(),
  ]);

  return {
    approved: { shows: Number(counts?.shows ?? 0), movies: Number(counts?.movies ?? 0) },
    tv: {
      current: currentTv ? tvProgramme(currentTv) : null,
      next: nextTvRows.results.map(tvProgramme).slice(0, 2),
    },
    movie: {
      current: currentMovie ? {
        programmeId: currentMovie.programme_id,
        title: currentMovie.title,
        poster: currentMovie.poster ?? undefined,
        releaseInfo: currentMovie.release_info ?? undefined,
      } : null,
    },
  };
}
