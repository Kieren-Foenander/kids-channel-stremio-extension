export type ContentType = "show" | "movie";

export interface CinemetaTitle {
  id: string;
  type: ContentType;
  title: string;
  description?: string;
  poster?: string;
  background?: string;
  releaseInfo?: string;
  genres: string[];
  imdbRating?: string;
}

export interface CinemetaEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string;
  overview?: string;
}

export interface CinemetaShow extends CinemetaTitle {
  type: "show";
  episodes: CinemetaEpisode[];
}

type CinemetaMeta = Record<string, unknown>;

const IMDB_ID = /^tt\d+$/;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function titleFrom(meta: CinemetaMeta, type: ContentType): CinemetaTitle | null {
  const id = text(meta.imdb_id) ?? text(meta.id);
  const title = text(meta.name);
  if (!id || !IMDB_ID.test(id) || !title) return null;
  return {
    id,
    type,
    title,
    description: text(meta.description),
    poster: text(meta.poster),
    background: text(meta.background),
    releaseInfo: text(meta.releaseInfo) ?? text(meta.year),
    genres: Array.isArray(meta.genres) ? meta.genres.filter((genre): genre is string => typeof genre === "string") : [],
    imdbRating: text(meta.imdbRating),
  };
}

function regularReleasedEpisodes(meta: CinemetaMeta, imdbId: string, now: number): CinemetaEpisode[] {
  if (!Array.isArray(meta.videos)) return [];
  return meta.videos.flatMap((value): CinemetaEpisode[] => {
    if (typeof value !== "object" || value === null) return [];
    const video = value as CinemetaMeta;
    const id = text(video.id);
    const season = video.season;
    const episode = video.episode;
    const title = text(video.title) ?? text(video.name);
    const released = text(video.released);
    const releasedAt = released ? Date.parse(released) : Number.NaN;
    if (
      !id || !id.startsWith(`${imdbId}:`) || !Number.isInteger(season) || !Number.isInteger(episode)
      || (season as number) < 1 || (episode as number) < 1 || !title || !released
      || !Number.isFinite(releasedAt) || releasedAt > now
    ) return [];
    return [{ id, season: season as number, episode: episode as number, title, released, overview: text(video.overview) }];
  }).sort((left, right) => left.season - right.season || left.episode - right.episode);
}

export class CinemetaClient {
  constructor(
    private readonly origin = "https://v3-cinemeta.strem.io",
    private readonly request?: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.request ? this.request.call(globalThis, input, init) : fetch(input, init);
  }

  private async json(path: string): Promise<CinemetaMeta> {
    const response = await this.fetch(new URL(path, this.origin), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 404 ? "cinemeta title not found" : "cinemeta request failed");
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) throw new Error("cinemeta response invalid");
    return body as CinemetaMeta;
  }

  async search(query: string): Promise<CinemetaTitle[]> {
    const encoded = encodeURIComponent(query);
    const [shows, movies] = await Promise.all([
      this.json(`/catalog/series/top/search=${encoded}.json`),
      this.json(`/catalog/movie/top/search=${encoded}.json`),
    ]);
    const normalize = (body: CinemetaMeta, type: ContentType) =>
      (Array.isArray(body.metas) ? body.metas : []).flatMap((meta): CinemetaTitle[] => {
        if (typeof meta !== "object" || meta === null) return [];
        const normalized = titleFrom(meta as CinemetaMeta, type);
        return normalized ? [normalized] : [];
      });
    return [...normalize(shows, "show"), ...normalize(movies, "movie")];
  }

  async title(type: ContentType, imdbId: string): Promise<CinemetaTitle | CinemetaShow | null> {
    if (!IMDB_ID.test(imdbId)) return null;
    const resourceType = type === "show" ? "series" : "movie";
    const body = await this.json(`/meta/${resourceType}/${imdbId}.json`);
    if (typeof body.meta !== "object" || body.meta === null) return null;
    const meta = body.meta as CinemetaMeta;
    const normalized = titleFrom(meta, type);
    if (!normalized || normalized.id !== imdbId) return null;
    if (type === "movie") return normalized;
    return { ...normalized, type: "show", episodes: regularReleasedEpisodes(meta, imdbId, this.now()) };
  }
}
