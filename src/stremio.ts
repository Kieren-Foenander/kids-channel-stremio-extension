export const TV_CATALOG_ID = "kids-tv-channel";
export const MOVIE_CATALOG_ID = "kids-movie-channel";

export interface HouseholdIdentity {
  id: string;
  secret: string;
}

export function manifestFor(household: HouseholdIdentity) {
  return {
    id: `community.kids-channels.${household.id}`,
    version: "0.1.0",
    name: "Kids Channels",
    description: "Two parent-curated Channels for the household.",
    resources: ["catalog"],
    types: ["tv", "movie"],
    catalogs: [
      { type: "tv", id: TV_CATALOG_ID, name: "Kids Channels - TV" },
      { type: "movie", id: MOVIE_CATALOG_ID, name: "Kids Channels - Movies" },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

export function catalogFor(type: string, id: string, origin: string) {
  if (type === "tv" && id === TV_CATALOG_ID) {
    return {
      metas: [
        {
          id: "kids-channels:tv",
          type: "tv",
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
