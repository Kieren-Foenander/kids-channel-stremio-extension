export const MOVIE_CHANNEL_ID = "kids-channels:movie";
const SIGN_OFF_PREFIX = `${MOVIE_CHANNEL_ID}:sign-off`;

interface MovieRow {
  programme_id: string;
  imdb_id: string;
  title: string;
  description: string | null;
  poster: string | null;
  background: string | null;
  release_info: string | null;
  approved_at: string;
}

interface MovieStateRow {
  cycle: number;
  current_position: number;
  selection_seed: string;
}

interface CurrentMovieRow extends MovieRow, MovieStateRow {}

export interface MovieProgramme {
  programmeId: string;
  imdbId: string;
  title: string;
  description?: string;
  poster?: string;
  background?: string;
  releaseInfo?: string;
  approvedAt: string;
  cycle: number;
  position: number;
  signOffId: string;
}

function stableIndex(seed: string, cycle: number, position: number, count: number): number {
  let hash = 2166136261;
  for (const character of `${seed}:${cycle}:${position}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function shuffled(movies: MovieRow[], seed: string, cycle: number): MovieRow[] {
  const remaining = [...movies];
  const result: MovieRow[] = [];
  while (remaining.length > 0) {
    result.push(remaining.splice(stableIndex(seed, cycle, result.length, remaining.length), 1)[0]);
  }
  return result;
}

async function approvedMovies(db: D1Database, householdId: string): Promise<MovieRow[]> {
  const rows = await db.prepare(`SELECT id AS programme_id, imdb_id, title, description, poster,
      background, release_info, approved_at
    FROM approved_programmes
    WHERE household_id = ? AND content_type = 'movie'
    ORDER BY approved_at, id`).bind(householdId).all<MovieRow>();
  return rows.results;
}

function programmeFromRow(row: CurrentMovieRow): MovieProgramme {
  return {
    programmeId: row.programme_id,
    imdbId: row.imdb_id,
    title: row.title,
    description: row.description ?? undefined,
    poster: row.poster ?? undefined,
    background: row.background ?? undefined,
    releaseInfo: row.release_info ?? undefined,
    approvedAt: row.approved_at,
    cycle: row.cycle,
    position: row.current_position,
    signOffId: `${SIGN_OFF_PREFIX}:${row.cycle}:${row.current_position}`,
  };
}

async function initialize(db: D1Database, householdId: string, configuredSeed?: string): Promise<void> {
  if (await db.prepare("SELECT 1 FROM movie_channel_state WHERE household_id = ?").bind(householdId).first()) return;
  const movies = await approvedMovies(db, householdId);
  if (movies.length === 0) return;

  const seed = configuredSeed || crypto.randomUUID();
  const rotation = shuffled(movies, seed, 0);
  const now = new Date().toISOString();
  const first = rotation[0];
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO movie_channel_state
      (household_id, cycle, current_position, selection_seed, initialized_at)
      VALUES (?, 0, 0, ?, ?)`).bind(householdId, seed, now),
  ];
  for (const [position, movie] of rotation.entries()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
      (household_id, cycle, position, programme_id) VALUES (?, 0, ?, ?)`)
      .bind(householdId, position, movie.programme_id));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO current_programmes
    (household_id, channel, programme_id, video_id, selected_at)
    VALUES (?, 'movie', ?, ?, ?)`).bind(householdId, first.programme_id, first.imdb_id, now));
  await db.batch(statements);
}

async function synchronizeRotation(db: D1Database, householdId: string): Promise<void> {
  const state = await db.prepare(`SELECT cycle, current_position, selection_seed
    FROM movie_channel_state WHERE household_id = ?`).bind(householdId).first<MovieStateRow>();
  if (!state) return;
  const missing = await db.prepare(`SELECT programme.id AS programme_id, programme.imdb_id,
      programme.title, programme.description, programme.poster, programme.background,
      programme.release_info, programme.approved_at
    FROM approved_programmes programme
    LEFT JOIN movie_rotation rotation ON rotation.household_id = programme.household_id
      AND rotation.cycle = ? AND rotation.programme_id = programme.id
    WHERE programme.household_id = ? AND programme.content_type = 'movie'
      AND rotation.programme_id IS NULL
    ORDER BY programme.approved_at, programme.id`).bind(state.cycle, householdId).all<MovieRow>();
  if (missing.results.length === 0) return;
  const maximum = await db.prepare(`SELECT COALESCE(MAX(position), -1) AS position FROM movie_rotation
    WHERE household_id = ? AND cycle = ?`).bind(householdId, state.cycle).first<number>("position");
  const additions = shuffled(missing.results, state.selection_seed, state.cycle);
  await db.batch(additions.map((movie, offset) => db.prepare(`INSERT OR IGNORE INTO movie_rotation
    (household_id, cycle, position, programme_id) VALUES (?, ?, ?, ?)`)
    .bind(householdId, state.cycle, (maximum ?? -1) + offset + 1, movie.programme_id)));
}

async function current(db: D1Database, householdId: string): Promise<MovieProgramme | null> {
  const row = await db.prepare(`SELECT state.cycle, state.current_position, state.selection_seed,
      programme.id AS programme_id, programme.imdb_id, programme.title, programme.description,
      programme.poster, programme.background, programme.release_info, programme.approved_at
    FROM movie_channel_state state
    JOIN movie_rotation rotation ON rotation.household_id = state.household_id
      AND rotation.cycle = state.cycle AND rotation.position = state.current_position
      AND rotation.consumed_at IS NULL
    JOIN approved_programmes programme ON programme.id = rotation.programme_id
    WHERE state.household_id = ?`).bind(householdId).first<CurrentMovieRow>();
  return row ? programmeFromRow(row) : null;
}

export async function movieChannelProgramme(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  await initialize(db, householdId, configuredSeed);
  await synchronizeRotation(db, householdId);
  return current(db, householdId);
}

export function parseSignOffId(videoId: string): { cycle: number; position: number } | null {
  const match = videoId.match(new RegExp(`^${SIGN_OFF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):(\\d+)$`));
  if (!match) return null;
  return { cycle: Number(match[1]), position: Number(match[2]) };
}

export async function requestMovieSignOff(
  db: D1Database,
  householdId: string,
  expectedCycle: number,
  expectedPosition: number,
): Promise<void> {
  const state = await db.prepare(`SELECT cycle, current_position, selection_seed
    FROM movie_channel_state WHERE household_id = ?`).bind(householdId).first<MovieStateRow>();
  if (!state || state.cycle !== expectedCycle || state.current_position !== expectedPosition) return;

  const movies = await approvedMovies(db, householdId);
  if (movies.length === 0) return;
  const remaining = await db.prepare(`SELECT position FROM movie_rotation
    WHERE household_id = ? AND cycle = ? AND position > ? AND consumed_at IS NULL
    ORDER BY position LIMIT 1`).bind(householdId, state.cycle, state.current_position).first<{ position: number }>();
  const nextCycle = remaining ? state.cycle : state.cycle + 1;
  const nextPosition = remaining?.position ?? 0;
  const nextRotation = remaining ? [] : shuffled(movies, state.selection_seed, nextCycle);
  const nextProgrammeId = remaining
    ? await db.prepare(`SELECT programme_id FROM movie_rotation
        WHERE household_id = ? AND cycle = ? AND position = ?`)
      .bind(householdId, nextCycle, nextPosition).first<string>("programme_id")
    : nextRotation[0]?.programme_id;
  const nextMovie = movies.find((movie) => movie.programme_id === nextProgrammeId);
  if (!nextMovie) return;

  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  const owns = `EXISTS (SELECT 1 FROM movie_advancements claim
    WHERE claim.household_id = ? AND claim.cycle = ? AND claim.position = ? AND claim.owner_token = ?)`;
  const ownership = [householdId, state.cycle, state.current_position, owner] as const;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO movie_advancements
      (household_id, cycle, position, owner_token, advanced_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(householdId, state.cycle, state.current_position, owner, now),
    db.prepare(`UPDATE movie_rotation SET consumed_at = ?
      WHERE household_id = ? AND cycle = ? AND position = ? AND ${owns}`)
      .bind(now, householdId, state.cycle, state.current_position, ...ownership),
  ];
  for (const [position, movie] of nextRotation.entries()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
      (household_id, cycle, position, programme_id)
      SELECT ?, ?, ?, ? WHERE ${owns}`)
      .bind(householdId, nextCycle, position, movie.programme_id, ...ownership));
  }
  statements.push(
    db.prepare(`UPDATE movie_channel_state SET cycle = ?, current_position = ?
      WHERE household_id = ? AND cycle = ? AND current_position = ? AND ${owns}`)
      .bind(nextCycle, nextPosition, householdId, state.cycle, state.current_position, ...ownership),
    db.prepare(`UPDATE current_programmes SET programme_id = ?, video_id = ?, selected_at = ?
      WHERE household_id = ? AND channel = 'movie' AND ${owns}`)
      .bind(nextMovie.programme_id, nextMovie.imdb_id, now, householdId, ...ownership),
  );
  await db.batch(statements);
}
