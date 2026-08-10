import { channelsForHousehold } from "./channels";
import { parentMovieChannelState } from "./movie-channel";
import { parentTvChannelState } from "./tv-channel";

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

export interface OverviewTvChannel {
  id: string;
  name: string;
  current: OverviewTvProgramme | null;
  next: OverviewTvProgramme[];
}

export interface OverviewMovieChannel {
  id: string;
  name: string;
  current: OverviewMovieProgramme | null;
}

export interface HouseholdOverview {
  approved: { shows: number; movies: number };
  tvChannels: OverviewTvChannel[];
  movieChannels: OverviewMovieChannel[];
}

interface CountRow { shows: number; movies: number }

/** Builds the Parent Page summary for every configured Channel. */
export async function householdOverview(
  db: D1Database,
  householdId: string,
  tvSeed?: string,
  movieSeed?: string,
): Promise<HouseholdOverview> {
  const [counts, channels] = await Promise.all([
    db.prepare(`SELECT
      SUM(CASE WHEN content_type = 'show' THEN 1 ELSE 0 END) AS shows,
      SUM(CASE WHEN content_type = 'movie' THEN 1 ELSE 0 END) AS movies
      FROM approved_programmes WHERE household_id = ?`).bind(householdId).first<CountRow>(),
    channelsForHousehold(db, householdId),
  ]);

  const tvChannels = await Promise.all(channels.filter((channel) => channel.type === "tv").map(async (channel) => {
    const state = await parentTvChannelState(db, householdId, channel.id, tvSeed);
    const programmes = state.schedule.map((programme) => ({
      programmeId: programme.programmeId,
      title: programme.showTitle,
      poster: programme.poster,
      episode: programme.episode,
    }));
    return {
      id: channel.id,
      name: channel.name,
      current: programmes[0] ?? null,
      next: programmes.slice(1, 3),
    };
  }));

  const movieChannels = await Promise.all(channels.filter((channel) => channel.type === "movie").map(async (channel) => {
    const state = await parentMovieChannelState(db, householdId, channel.id, movieSeed);
    return {
      id: channel.id,
      name: channel.name,
      current: state.current ? {
        programmeId: state.current.programmeId,
        title: state.current.title,
        poster: state.current.poster,
        releaseInfo: state.current.releaseInfo,
      } : null,
    };
  }));

  return {
    approved: { shows: Number(counts?.shows ?? 0), movies: Number(counts?.movies ?? 0) },
    tvChannels,
    movieChannels,
  };
}
