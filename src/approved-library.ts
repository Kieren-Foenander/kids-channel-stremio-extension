import type { CinemetaEpisode, CinemetaShow, CinemetaTitle, ContentType } from "./cinemeta";

export interface ApprovedProgramme {
  id: string;
  imdbId: string;
  type: ContentType;
  title: string;
  description?: string;
  poster?: string;
  background?: string;
  releaseInfo?: string;
  genres: string[];
  imdbRating?: string;
  approvedAt: string;
  pausedAt?: string;
  episodes?: CinemetaEpisode[];
  showProgress?: CinemetaEpisode;
}

export interface ApprovedProgrammeSummary {
  id: string;
  imdbId: string;
  type: ContentType;
  title: string;
  poster?: string;
  releaseInfo?: string;
  genres: string[];
  imdbRating?: string;
  approvedAt: string;
  pausedAt?: string;
  current: boolean;
  finished: boolean;
  showProgress?: CinemetaEpisode;
}

interface StoredProgramme {
  id: string;
  imdb_id: string;
  content_type: ContentType;
  title: string;
  description: string | null;
  poster: string | null;
  background: string | null;
  release_info: string | null;
  genres_json: string;
  imdb_rating: string | null;
  approved_at: string;
  paused_at: string | null;
  next_video_id: string | null;
}

function episodeFromRow(row: Record<string, unknown>): CinemetaEpisode {
  return {
    id: row.video_id as string,
    season: row.season as number,
    episode: row.episode as number,
    title: row.title as string,
    released: row.released_at as string,
    overview: (row.overview as string | null) ?? undefined,
  };
}

function programmeFromRow(row: StoredProgramme): ApprovedProgramme {
  return {
    id: row.id,
    imdbId: row.imdb_id,
    type: row.content_type,
    title: row.title,
    description: row.description ?? undefined,
    poster: row.poster ?? undefined,
    background: row.background ?? undefined,
    releaseInfo: row.release_info ?? undefined,
    genres: JSON.parse(row.genres_json) as string[],
    imdbRating: row.imdb_rating ?? undefined,
    approvedAt: row.approved_at,
    pausedAt: row.paused_at ?? undefined,
  };
}

export async function hasApprovedProgramme(
  db: D1Database,
  householdId: string,
  type: ContentType,
  imdbId: string,
): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS found FROM approved_programmes WHERE household_id = ? AND content_type = ? AND imdb_id = ?",
  ).bind(householdId, type, imdbId).first());
}

export async function approveProgramme(
  db: D1Database,
  householdId: string,
  title: CinemetaTitle | CinemetaShow,
  startingEpisodeId?: string,
): Promise<ApprovedProgramme> {
  const id = crypto.randomUUID();
  const approvedAt = new Date().toISOString();
  const statements = [db.prepare(`INSERT INTO approved_programmes
    (id, household_id, imdb_id, content_type, title, description, poster, background, release_info, genres_json, imdb_rating, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, householdId, title.id, title.type, title.title, title.description ?? null, title.poster ?? null,
      title.background ?? null, title.releaseInfo ?? null, JSON.stringify(title.genres), title.imdbRating ?? null, approvedAt)];

  let startingEpisode: CinemetaEpisode | undefined;
  if (title.type === "show") {
    const show = title as CinemetaShow;
    if (show.episodes.length === 0) throw new Error("show has no regular released episodes");
    startingEpisode = startingEpisodeId
      ? show.episodes.find((episode) => episode.id === startingEpisodeId)
      : show.episodes.find((episode) => episode.season === 1 && episode.episode === 1);
    if (!startingEpisode) throw new Error("starting episode is invalid");
    for (const episode of show.episodes) {
      statements.push(db.prepare(`INSERT INTO show_episodes
        (programme_id, video_id, season, episode, title, released_at, overview) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, episode.id, episode.season, episode.episode, episode.title, episode.released, episode.overview ?? null));
    }
    statements.push(db.prepare("INSERT INTO show_progress (programme_id, next_video_id) VALUES (?, ?)")
      .bind(id, startingEpisode.id));
  }

  await db.batch(statements);
  return { ...title, id, imdbId: title.id, approvedAt, showProgress: startingEpisode };
}

type SummaryRow = StoredProgramme & {
  is_current: number;
  progress_video_id: string | null;
  progress_season: number | null;
  progress_episode: number | null;
  progress_title: string | null;
  progress_released_at: string | null;
};

/** A compact Parent Page projection. Episode catalogues are deliberately loaded only by
 * the programme-detail endpoint; this list includes at most the single Show Progress episode. */
export async function approvedLibrary(db: D1Database, householdId: string): Promise<ApprovedProgrammeSummary[]> {
  const rows = await db.prepare(`SELECT p.*,
      CASE WHEN current.programme_id IS NULL THEN 0 ELSE 1 END AS is_current,
      progress.next_video_id AS progress_video_id,
      episode.season AS progress_season, episode.episode AS progress_episode,
      episode.title AS progress_title, episode.released_at AS progress_released_at
    FROM approved_programmes p
    LEFT JOIN current_programmes current
      ON current.household_id = p.household_id AND current.programme_id = p.id
    LEFT JOIN show_progress progress ON progress.programme_id = p.id
    LEFT JOIN show_episodes episode
      ON episode.programme_id = p.id AND episode.video_id = progress.next_video_id
    WHERE p.household_id = ?
    ORDER BY p.approved_at, p.title`).bind(householdId).all<SummaryRow>();

  return rows.results.map((row) => {
    const programme = programmeFromRow(row);
    const showProgress = row.progress_video_id && row.progress_season !== null && row.progress_episode !== null
      ? {
          id: row.progress_video_id,
          season: row.progress_season,
          episode: row.progress_episode,
          title: row.progress_title ?? "Untitled episode",
          released: row.progress_released_at ?? "",
        }
      : undefined;
    return {
      id: programme.id,
      imdbId: programme.imdbId,
      type: programme.type,
      title: programme.title,
      poster: programme.poster,
      releaseInfo: programme.releaseInfo,
      genres: programme.genres,
      imdbRating: programme.imdbRating,
      approvedAt: programme.approvedAt,
      pausedAt: programme.pausedAt,
      current: Boolean(row.is_current),
      finished: programme.type === "show" && !row.progress_video_id,
      showProgress,
    };
  });
}
