import { MOVIE_CHANNEL_ID, type MovieProgramme } from "./movie-channel";
import type { TvScheduledProgramme } from "./tv-channel";

export const TV_CATALOG_ID = "kids-tv-channel";
export const MOVIE_CATALOG_ID = "kids-movie-channel";
export const TV_CHANNEL_ID = "kids-channels:tv";

export interface HouseholdIdentity {
  id: string;
  secret: string;
}

export function manifestFor(household: HouseholdIdentity) {
  return {
    id: `community.kids-channels.${household.id}`,
    version: "0.4.1",
    name: "Kids Channels",
    description: "Two parent-curated Channels for the household.",
    resources: ["catalog", "meta", "stream"],
    types: ["series", "movie"],
    catalogs: [
      { type: "series", id: TV_CATALOG_ID, name: "Kids Channels - TV" },
      { type: "movie", id: MOVIE_CATALOG_ID, name: "Kids Channels - Movies" },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

export function tvChannelMetadata(schedule: TvScheduledProgramme[], origin: string) {
  const current = schedule[0];
  if (!current) return { meta: null };
  return {
    meta: {
      id: TV_CHANNEL_ID,
      type: "series",
      name: "TV Channel",
      description: `Current Programme: ${current.showTitle} — ${current.episode.title}. Upcoming programmes alternate across the household's approved shows.`,
      poster: `${origin}/assets/tv-channel.svg`,
      posterShape: "square",
      background: current.background,
      behaviorHints: { defaultVideoId: current.episode.id },
      videos: schedule.map((programme) => ({
        id: programme.episode.id,
        title: `${programme.showTitle} — ${programme.episode.title}`,
        released: programme.episode.released,
        // Schedule coordinates let Stremio order episodes across different canonical shows.
        // The canonical video ID remains unchanged for providers, Viewing Progress, and subtitles.
        season: 1,
        episode: programme.position + 1,
        overview: programme.episode.overview,
      })),
    },
  };
}

export function movieChannelMetadata(programme: MovieProgramme | null, origin: string, installationSecret: string) {
  if (!programme) return { meta: null };
  return {
    meta: {
      id: MOVIE_CHANNEL_ID,
      type: "movie",
      name: "Movie Channel",
      description: `Current Programme: ${programme.title}. The Channel stops after a short sign-off.`,
      poster: programme.poster ?? `${origin}/assets/movie-channel.svg`,
      posterShape: programme.poster ? "poster" : "square",
      background: programme.background,
      releaseInfo: programme.releaseInfo,
      behaviorHints: { defaultVideoId: programme.imdbId },
      videos: [
        {
          id: programme.imdbId,
          title: programme.title,
          released: programme.approvedAt,
          season: 1,
          episode: 1,
          overview: programme.description,
        },
        {
          id: programme.signOffId,
          title: "Kids Channels sign-off",
          released: programme.approvedAt,
          season: 1,
          episode: 2,
          overview: "A five-second sign-off. Playback stops when it finishes.",
          // Inline streams are exclusive in Stremio, so installed providers are not asked to
          // resolve this synthetic video and the child does not see another source picker.
          streams: [{
            url: `${origin}/addons/${installationSecret}/media/movie-sign-off/${programme.cycle}/${programme.position}.mp4`,
            behaviorHints: {
              filename: "kids-channels-sign-off.mp4",
            },
          }],
        },
      ],
    },
  };
}

export function catalogFor(type: string, id: string, origin: string) {
  if (type === "series" && id === TV_CATALOG_ID) {
    return {
      metas: [
        {
          id: TV_CHANNEL_ID,
          type: "series",
          name: "TV Channel",
          description: "One shared, continuously replenished schedule from your household's approved shows.",
          poster: `${origin}/assets/tv-channel.svg`,
          posterShape: "square",
        },
      ],
    };
  }

  if (type === "movie" && id === MOVIE_CATALOG_ID) {
    return {
      metas: [
        {
          id: MOVIE_CHANNEL_ID,
          type: "movie",
          name: "Movie Channel",
          description: "Your household's approved movies, without repeats.",
          poster: `${origin}/assets/movie-channel.svg`,
          posterShape: "square",
        },
      ],
    };
  }

  return null;
}
