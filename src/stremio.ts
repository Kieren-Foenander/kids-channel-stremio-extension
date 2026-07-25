import type { TvCurrentProgramme } from "./current-programme";

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
    version: "0.2.0",
    name: "Kids Channels",
    description: "Two parent-curated Channels for the household.",
    resources: ["catalog", "meta"],
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

export function tvChannelMetadata(current: TvCurrentProgramme | null) {
  if (!current) return { meta: null };
  return {
    meta: {
      id: TV_CHANNEL_ID,
      type: "series",
      name: "TV Channel",
      description: current.description ?? `Current Programme: ${current.showTitle}`,
      poster: current.poster,
      background: current.background,
      behaviorHints: { defaultVideoId: current.episode.id },
      videos: [
        {
          id: current.episode.id,
          title: `${current.showTitle} — ${current.episode.title}`,
          released: current.episode.released,
          season: current.episode.season,
          episode: current.episode.episode,
          overview: current.episode.overview,
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
          description: "Your household's approved shows, in episode order.",
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
          id: "kids-channels:movie",
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
