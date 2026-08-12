import { channelsForHousehold } from "./channels";
import { movieChannelProgramme } from "./movie-channel";
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

const OVERVIEW_SCHEDULE_LENGTH = 3;

/** Builds the Parent Page summary for every configured Channel. This runs for up to ten
 * Channels on a polled endpoint, so it reads the shortest window each card renders rather
 * than the full Channel Schedule, remaining rotation, and playback history. */
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
      FROM approved_programmes programme WHERE household_id = ?
        AND EXISTS (SELECT 1 FROM channel_assignments assignment
          WHERE assignment.programme_id = programme.id)`).bind(householdId).first<CountRow>(),
    channelsForHousehold(db, householdId),
  ]);

  const tvChannels = await Promise.all(channels.filter((channel) => channel.type === "tv").map(async (channel) => {
    const schedule = await tvChannelSchedule(db, householdId, channel.id, tvSeed, OVERVIEW_SCHEDULE_LENGTH);
    const programmes = schedule.map((programme) => ({
      programmeId: programme.programmeId,
      title: programme.showTitle,
      poster: programme.poster,
      episode: programme.episode,
    }));
    return {
      id: channel.id,
      name: channel.name,
      current: programmes[0] ?? null,
      next: programmes.slice(1),
    };
  }));

  const movieChannels = await Promise.all(channels.filter((channel) => channel.type === "movie").map(async (channel) => {
    const current = await movieChannelProgramme(db, householdId, channel.id, movieSeed);
    return {
      id: channel.id,
      name: channel.name,
      current: current ? {
        programmeId: current.programmeId,
        title: current.title,
        poster: current.poster,
        releaseInfo: current.releaseInfo,
      } : null,
    };
  }));

  return {
    approved: { shows: Number(counts?.shows ?? 0), movies: Number(counts?.movies ?? 0) },
    tvChannels,
    movieChannels,
  };
}
