import type { CinemetaEpisode, CinemetaShow, CinemetaTitle, ContentType } from "./cinemeta";
import { channelTypeForContent, channelsForHousehold, type ChannelType } from "./channels";

export interface ProgrammeAssignment {
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  createdAt: string;
  pausedAt?: string;
  current: boolean;
  finished: boolean;
  showProgress?: CinemetaEpisode;
}

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
  assignments: ProgrammeAssignment[];
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
  assignments: ProgrammeAssignment[];
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

interface AssignmentRow {
  channel_id: string;
  channel_name: string;
  channel_type: ChannelType;
  created_at: string;
  paused_at: string | null;
  next_video_id: string | null;
  is_current: number;
  progress_season: number | null;
  progress_episode: number | null;
  progress_title: string | null;
  progress_released_at: string | null;
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
    assignments: [],
  };
}

function assignmentFromRow(row: AssignmentRow): ProgrammeAssignment {
  const showProgress = row.next_video_id && row.progress_season !== null && row.progress_episode !== null
    ? {
        id: row.next_video_id,
        season: row.progress_season,
        episode: row.progress_episode,
        title: row.progress_title ?? "Untitled episode",
        released: row.progress_released_at ?? "",
      }
    : undefined;
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelType: row.channel_type,
    createdAt: row.created_at,
    pausedAt: row.paused_at ?? undefined,
    current: Boolean(row.is_current),
    finished: row.channel_type === "tv" && !row.next_video_id,
    showProgress,
  };
}

async function assignmentRows(
  db: D1Database,
  householdId: string,
  programmeId?: string,
): Promise<Array<AssignmentRow & { programme_id: string }>> {
  const condition = programmeId ? "AND assignment.programme_id = ?" : "";
  const query = db.prepare(`SELECT assignment.programme_id, assignment.channel_id,
      channel.name AS channel_name, channel.channel_type, assignment.created_at,
      assignment.paused_at, assignment.next_video_id,
      CASE WHEN current.programme_id IS NULL THEN 0 ELSE 1 END AS is_current,
      episode.season AS progress_season, episode.episode AS progress_episode,
      episode.title AS progress_title, episode.released_at AS progress_released_at
    FROM channel_assignments assignment
    JOIN channels channel ON channel.id = assignment.channel_id
    JOIN approved_programmes programme ON programme.id = assignment.programme_id
    LEFT JOIN current_programmes current
      ON current.channel_id = assignment.channel_id AND current.programme_id = assignment.programme_id
    LEFT JOIN canonical_show_episodes episode
      ON programme.content_type = 'show' AND episode.show_imdb_id = programme.imdb_id
        AND episode.video_id = assignment.next_video_id
    WHERE channel.household_id = ? ${condition}
    ORDER BY channel.channel_type, channel.created_at, channel.id`);
  const rows = programmeId
    ? await query.bind(householdId, programmeId).all<AssignmentRow & { programme_id: string }>()
    : await query.bind(householdId).all<AssignmentRow & { programme_id: string }>();
  return rows.results;
}

export async function approvedProgrammeDetail(
  db: D1Database,
  householdId: string,
  programmeId: string,
): Promise<ApprovedProgramme | null> {
  const row = await db.prepare(`SELECT p.id, p.imdb_id, p.content_type,
      CASE WHEN p.content_type = 'show' THEN canonical.title ELSE p.title END AS title,
      CASE WHEN p.content_type = 'show' THEN canonical.description ELSE p.description END AS description,
      CASE WHEN p.content_type = 'show' THEN canonical.poster ELSE p.poster END AS poster,
      CASE WHEN p.content_type = 'show' THEN canonical.background ELSE p.background END AS background,
      CASE WHEN p.content_type = 'show' THEN canonical.release_info ELSE p.release_info END AS release_info,
      CASE WHEN p.content_type = 'show' THEN canonical.genres_json ELSE p.genres_json END AS genres_json,
      CASE WHEN p.content_type = 'show' THEN canonical.imdb_rating ELSE p.imdb_rating END AS imdb_rating,
      p.approved_at, NULL AS paused_at, NULL AS next_video_id
    FROM approved_programmes p
    LEFT JOIN canonical_shows canonical
      ON p.content_type = 'show' AND canonical.imdb_id = p.imdb_id
    WHERE p.id = ? AND p.household_id = ?`).bind(programmeId, householdId)
    .first<StoredProgramme & { next_video_id: string | null }>();
  if (!row) return null;

  const programme = programmeFromRow(row);
  const assignments = await assignmentRows(db, householdId, programmeId);
  programme.assignments = assignments.map(assignmentFromRow);
  const primary = programme.assignments[0];
  programme.pausedAt = primary?.pausedAt;
  programme.showProgress = primary?.showProgress;
  if (programme.type !== "show") return programme;

  const episodes = await db.prepare(`SELECT video_id, season, episode, title, released_at, overview
    FROM show_episodes WHERE programme_id = ? ORDER BY season, episode`).bind(programme.id)
    .all<Record<string, unknown>>();
  programme.episodes = episodes.results.map(episodeFromRow);
  return programme;
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
  requestedChannelIds?: string[],
): Promise<ApprovedProgramme> {
  const id = crypto.randomUUID();
  const approvedAt = new Date().toISOString();
  const compatibleType = channelTypeForContent(title.type);
  const compatibleChannels = await channelsForHousehold(db, householdId, compatibleType);
  const requested = requestedChannelIds?.length
    ? [...new Set(requestedChannelIds)]
    : compatibleChannels.length === 1
      ? [compatibleChannels[0].id]
      : [];
  if (requested.length === 0) {
    throw new Error(compatibleChannels.length === 0 ? "compatible channel is required" : "channel selection is required");
  }
  const channelById = new Map(compatibleChannels.map((channel) => [channel.id, channel]));
  if (requested.some((channelId) => !channelById.has(channelId))) throw new Error("channel selection is invalid");
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
  }

  for (const channelId of requested) {
    statements.push(db.prepare(`INSERT INTO channel_assignments
      (channel_id, programme_id, next_video_id, created_at) VALUES (?, ?, ?, ?)`)
      .bind(channelId, id, startingEpisode?.id ?? null, approvedAt));
  }

  await db.batch(statements);
  return {
    ...title,
    id,
    imdbId: title.id,
    approvedAt,
    showProgress: startingEpisode,
    assignments: requested.map((channelId) => ({
      channelId,
      channelName: channelById.get(channelId)!.name,
      channelType: compatibleType,
      createdAt: approvedAt,
      current: false,
      finished: false,
      showProgress: startingEpisode,
    })),
  };
}

type SummaryRow = StoredProgramme & {
  is_current: number;
  progress_video_id: string | null;
  progress_season: number | null;
  progress_episode: number | null;
  progress_title: string | null;
  progress_released_at: string | null;
};

export const APPROVED_LIBRARY_SQL = `SELECT p.id, p.imdb_id, p.content_type,
      CASE WHEN p.content_type = 'show' THEN canonical.title ELSE p.title END AS title,
      CASE WHEN p.content_type = 'show' THEN canonical.description ELSE p.description END AS description,
      CASE WHEN p.content_type = 'show' THEN canonical.poster ELSE p.poster END AS poster,
      CASE WHEN p.content_type = 'show' THEN canonical.background ELSE p.background END AS background,
      CASE WHEN p.content_type = 'show' THEN canonical.release_info ELSE p.release_info END AS release_info,
      CASE WHEN p.content_type = 'show' THEN canonical.genres_json ELSE p.genres_json END AS genres_json,
      CASE WHEN p.content_type = 'show' THEN canonical.imdb_rating ELSE p.imdb_rating END AS imdb_rating,
      p.approved_at, NULL AS paused_at,
      0 AS is_current, NULL AS progress_video_id,
      NULL AS progress_season, NULL AS progress_episode,
      NULL AS progress_title, NULL AS progress_released_at
    FROM approved_programmes p
    LEFT JOIN canonical_shows canonical
      ON p.content_type = 'show' AND canonical.imdb_id = p.imdb_id
    WHERE p.household_id = ?
      AND EXISTS (SELECT 1 FROM channel_assignments assignment WHERE assignment.programme_id = p.id)
    ORDER BY p.approved_at, title`;

/** A compact Parent Page projection. Episode catalogues are deliberately loaded only by
 * the programme-detail endpoint; this list includes at most the single Show Progress episode.
 * A programme enters the Approved Library through Channel Assignments and leaves it with
 * the last one, so an unassigned programme is not part of the library. */
export async function approvedLibrary(db: D1Database, householdId: string): Promise<ApprovedProgrammeSummary[]> {
  const [rows, assignments] = await Promise.all([
    db.prepare(APPROVED_LIBRARY_SQL).bind(householdId).all<SummaryRow>(),
    assignmentRows(db, householdId),
  ]);
  const assignmentsByProgramme = new Map<string, ProgrammeAssignment[]>();
  for (const row of assignments) {
    const values = assignmentsByProgramme.get(row.programme_id) ?? [];
    values.push(assignmentFromRow(row));
    assignmentsByProgramme.set(row.programme_id, values);
  }

  return rows.results.map((row) => {
    const programme = programmeFromRow(row);
    const programmeAssignments = assignmentsByProgramme.get(programme.id) ?? [];
    const primary = programmeAssignments[0];
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
      pausedAt: primary?.pausedAt,
      current: programmeAssignments.some((assignment) => assignment.current),
      finished: programme.type === "show" && programmeAssignments.length > 0
        && programmeAssignments.every((assignment) => assignment.finished),
      showProgress: primary?.showProgress,
      assignments: programmeAssignments,
    };
  });
}
