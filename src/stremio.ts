import { MOVIE_CHANNEL_ID, type MovieProgramme } from "./movie-channel";
import type { TvScheduledProgramme } from "./tv-channel";
import type { Channel } from "./channels";

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
    description: "Parent-curated TV and Movie Channels for the household.",
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

export function stremioChannelId(channel: Channel): string {
  if (channel.legacyKey === "tv") return TV_CHANNEL_ID;
  if (channel.legacyKey === "movie") return MOVIE_CHANNEL_ID;
  return `kids-channels:${channel.type}:${channel.id}`;
}

export function channelIdFromStremioId(channels: Channel[], metadataId: string): string | null {
  return channels.find((channel) => stremioChannelId(channel) === metadataId)?.id ?? null;
}

export function tvChannelMetadata(
  channel: Channel,
  schedule: TvScheduledProgramme[],
  origin: string,
  installationSecret: string,
) {
  const current = schedule[0];
  return {
    meta: {
      id: stremioChannelId(channel),
      type: "series",
      name: channel.name,
      description: current
        ? `Current Programme: ${current.showTitle} — ${current.episode.title}. Upcoming programmes alternate across this Channel's assigned shows.`
        : "No shows are assigned to this Channel.",
      poster: `${origin}/assets/tv-channel.svg`,
      posterShape: "square",
      background: current?.background,
      behaviorHints: current ? { defaultVideoId: current.episode.id } : undefined,
      videos: schedule.map((programme) => ({
        id: programme.episode.id,
        title: `${programme.showTitle} — ${programme.episode.title}`,
        released: programme.episode.released,
        // Schedule coordinates let Stremio order episodes across different canonical shows.
        // The canonical video ID remains unchanged for providers, Viewing Progress, and subtitles.
        season: 1,
        episode: programme.position + 1,
        overview: programme.episode.overview,
        streams: [{
          url: `${origin}/addons/${installationSecret}/play/series/${channel.id}/${encodeURIComponent(programme.episode.id)}`,
          behaviorHints: {
            bingeGroup: `kids-channels-tv-${channel.id}`,
            filename: `${programme.showTitle} - S${programme.episode.season}E${programme.episode.episode}`,
          },
        }],
      })),
    },
  };
}

export function movieChannelMetadata(
  channel: Channel,
  programme: MovieProgramme | null,
  origin: string,
  installationSecret: string,
) {
  return {
    meta: {
      id: stremioChannelId(channel),
      type: "movie",
      name: channel.name,
      description: programme
        ? `Current Programme: ${programme.title}. The Channel stops after a short sign-off.`
        : "No movies are assigned to this Channel.",
      poster: programme?.poster ?? `${origin}/assets/movie-channel.svg`,
      posterShape: programme?.poster ? "poster" : "square",
      background: programme?.background,
      releaseInfo: programme?.releaseInfo,
      behaviorHints: programme ? { defaultVideoId: programme.imdbId } : undefined,
      videos: programme ? [
        {
          id: programme.imdbId,
          title: programme.title,
          released: programme.approvedAt,
          season: 1,
          episode: 1,
          overview: programme.description,
          streams: [{
            url: `${origin}/addons/${installationSecret}/play/movie/${channel.id}/${programme.imdbId}`,
            behaviorHints: {
              filename: programme.title,
            },
          }],
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
          url: `${origin}/addons/${installationSecret}/media/movie-sign-off/${channel.id}/${programme.cycle}/${programme.position}.mp4`,
            behaviorHints: {
              filename: "kids-channels-sign-off.mp4",
            },
          }],
        },
      ] : [],
    },
  };
}

export function catalogFor(type: string, id: string, origin: string, channels: Channel[]) {
  if (type === "series" && id === TV_CATALOG_ID) {
    return {
      metas: channels.filter((channel) => channel.type === "tv").map((channel) => ({
          id: stremioChannelId(channel),
          type: "series",
          name: channel.name,
          description: "A continuously replenished schedule from this Channel's assigned shows.",
          poster: `${origin}/assets/tv-channel.svg`,
          posterShape: "square",
        })),
    };
  }

  if (type === "movie" && id === MOVIE_CATALOG_ID) {
    return {
      metas: channels.filter((channel) => channel.type === "movie").map((channel) => ({
          id: stremioChannelId(channel),
          type: "movie",
          name: channel.name,
          description: "This Channel's assigned movies, without repeats.",
          poster: `${origin}/assets/movie-channel.svg`,
          posterShape: "square",
        })),
    };
  }

  return null;
}
