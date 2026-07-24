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
  episodes?: CinemetaEpisode[];
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

export async function approvedLibrary(db: D1Database, householdId: string): Promise<ApprovedProgramme[]> {
  const rows = await db.prepare(`SELECT p.*, progress.next_video_id
    FROM approved_programmes p
    LEFT JOIN show_progress progress ON progress.programme_id = p.id
    WHERE p.household_id = ? ORDER BY p.approved_at, p.title`).bind(householdId).all<StoredProgramme>();

  const programmes: ApprovedProgramme[] = [];
  for (const row of rows.results) {
    const programme = programmeFromRow(row);
    if (programme.type === "show") {
      const episodeRows = await db.prepare(`SELECT video_id, season, episode, title, released_at, overview
        FROM show_episodes WHERE programme_id = ? ORDER BY season, episode`).bind(programme.id).all<Record<string, unknown>>();
      programme.episodes = episodeRows.results.map(episodeFromRow);
      programme.showProgress = programme.episodes.find((episode) => episode.id === row.next_video_id);
    }
    programmes.push(programme);
  }
  return programmes;
}
