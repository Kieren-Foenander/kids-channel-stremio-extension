export const MOVIE_CHANNEL_ID = "kids-channels:movie";
const SIGN_OFF_PREFIX = `${MOVIE_CHANNEL_ID}:sign-off`;
const MUTATION_ATTEMPTS = 5;

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
  revision: number;
}

interface RotationRow extends MovieRow {
  position: number;
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

export interface MoviePlaybackHistoryItem {
  programmeId: string;
  imdbId: string;
  title: string;
  playedAt: string;
}

export interface ParentMovieChannelState {
  current?: MovieProgramme;
  remaining: MovieProgramme[];
  recentPlayback: MoviePlaybackHistoryItem[];
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

async function state(db: D1Database, householdId: string): Promise<MovieStateRow | null> {
  return db.prepare(`SELECT cycle, current_position, selection_seed, revision
    FROM movie_channel_state WHERE household_id = ?`).bind(householdId).first<MovieStateRow>();
}

function programmeFromRow(row: CurrentMovieRow | RotationRow, requestedCycle?: number): MovieProgramme {
  const cycle = requestedCycle ?? ("cycle" in row ? row.cycle : 0);
  const position = "position" in row ? row.position : row.current_position;
  return {
    programmeId: row.programme_id,
    imdbId: row.imdb_id,
    title: row.title,
    description: row.description ?? undefined,
    poster: row.poster ?? undefined,
    background: row.background ?? undefined,
    releaseInfo: row.release_info ?? undefined,
    approvedAt: row.approved_at,
    cycle,
    position,
    signOffId: `${SIGN_OFF_PREFIX}:${cycle}:${position}`,
  };
}

function mutationOwnership(householdId: string, revision: number, owner: string) {
  const sql = `EXISTS (SELECT 1 FROM movie_channel_mutations mutation
    WHERE mutation.household_id = ? AND mutation.revision = ? AND mutation.owner_token = ?)`;
  return { sql, values: [householdId, revision, owner] as const };
}

function claimMutation(db: D1Database, householdId: string, revision: number, owner: string, now: string) {
  return db.prepare(`INSERT OR IGNORE INTO movie_channel_mutations
    (household_id, revision, owner_token, claimed_at) VALUES (?, ?, ?, ?)`)
    .bind(householdId, revision, owner, now);
}

async function ownsMutation(db: D1Database, householdId: string, revision: number, owner: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM movie_channel_mutations
    WHERE household_id = ? AND revision = ? AND owner_token = ?`).bind(householdId, revision, owner).first());
}

async function initialize(db: D1Database, householdId: string, configuredSeed?: string): Promise<void> {
  if (await state(db, householdId)) return;
  const movies = await approvedMovies(db, householdId);
  if (movies.length === 0) return;

  const seed = configuredSeed || crypto.randomUUID();
  const rotation = shuffled(movies, seed, 0);
  const now = new Date().toISOString();
  const first = rotation[0];
  const ownsInitialState = `EXISTS (SELECT 1 FROM movie_channel_state
    WHERE household_id = ? AND selection_seed = ? AND revision = 0)`;
  const initialOwnership = [householdId, seed] as const;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO movie_channel_state
      (household_id, cycle, current_position, selection_seed, initialized_at, revision)
      VALUES (?, 0, 0, ?, ?, 0)`).bind(householdId, seed, now),
  ];
  for (const [position, movie] of rotation.entries()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
      (household_id, cycle, position, programme_id)
      SELECT ?, 0, ?, ? WHERE ${ownsInitialState}`)
      .bind(householdId, position, movie.programme_id, ...initialOwnership));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO current_programmes
    (household_id, channel, programme_id, video_id, selected_at)
    SELECT ?, 'movie', ?, ?, ? WHERE ${ownsInitialState}`)
    .bind(householdId, first.programme_id, first.imdb_id, now, ...initialOwnership));
  await db.batch(statements);
}

async function current(db: D1Database, householdId: string): Promise<MovieProgramme | null> {
  const row = await db.prepare(`SELECT state.cycle, state.current_position, state.selection_seed, state.revision,
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

async function remainingRows(db: D1Database, householdId: string, currentState: MovieStateRow): Promise<RotationRow[]> {
  const rows = await db.prepare(`SELECT rotation.position, programme.id AS programme_id, programme.imdb_id,
      programme.title, programme.description, programme.poster, programme.background,
      programme.release_info, programme.approved_at
    FROM movie_rotation rotation
    JOIN approved_programmes programme ON programme.id = rotation.programme_id
    WHERE rotation.household_id = ? AND rotation.cycle = ? AND rotation.position > ?
      AND rotation.consumed_at IS NULL AND programme.content_type = 'movie'
    ORDER BY rotation.position`).bind(householdId, currentState.cycle, currentState.current_position).all<RotationRow>();
  return rows.results;
}

async function synchronizeRotation(db: D1Database, householdId: string): Promise<void> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId);
    if (!currentState) return;
    const [movies, membership] = await Promise.all([
      approvedMovies(db, householdId),
      db.prepare(`SELECT position, programme_id FROM movie_rotation WHERE household_id = ? AND cycle = ?`)
        .bind(householdId, currentState.cycle).all<{ position: number; programme_id: string }>(),
    ]);
    const present = new Set(membership.results.map((movie) => movie.programme_id));
    const additions = movies.filter((movie) => !present.has(movie.programme_id));
    if (additions.length === 0) return;

    // Keep every existing coordinate stable: sign-off URLs embed cycle and position, and
    // rewriting the complete tail makes sequential approvals quadratic. Newly approved
    // movies join the end of this cycle in deterministic approval order, before any repeat.
    const finalPosition = membership.results.reduce(
      (maximum, movie) => Math.max(maximum, movie.position),
      currentState.current_position,
    );
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, currentState.revision, owner, now),
    ];
    for (const [offset, movie] of additions.entries()) {
      statements.push(db.prepare(`INSERT INTO movie_rotation (household_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, currentState.cycle, finalPosition + offset + 1,
          movie.programme_id, ...owns.values));
    }
    statements.push(db.prepare(`UPDATE movie_channel_state SET revision = revision + 1
      WHERE household_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
      .bind(householdId, currentState.cycle, currentState.current_position, currentState.revision, ...owns.values));
    await db.batch(statements);
    if (await ownsMutation(db, householdId, currentState.revision, owner)) return;
  }
}

async function clearEmptyChannel(db: D1Database, householdId: string, currentState: MovieStateRow): Promise<void> {
  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  const owns = mutationOwnership(householdId, currentState.revision, owner);
  await db.batch([
    claimMutation(db, householdId, currentState.revision, owner, now),
    db.prepare(`DELETE FROM current_programmes WHERE household_id = ? AND channel = 'movie' AND ${owns.sql}`)
      .bind(householdId, ...owns.values),
    db.prepare(`DELETE FROM movie_advancements WHERE household_id = ? AND ${owns.sql}`).bind(householdId, ...owns.values),
    db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND ${owns.sql}`).bind(householdId, ...owns.values),
    db.prepare(`DELETE FROM movie_channel_state WHERE household_id = ? AND revision = ? AND ${owns.sql}`)
      .bind(householdId, currentState.revision, ...owns.values),
  ]);
}

async function selectValidCurrent(db: D1Database, householdId: string): Promise<MovieProgramme | null> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentProgramme = await current(db, householdId);
    if (currentProgramme) return currentProgramme;
    const currentState = await state(db, householdId);
    if (!currentState) return null;
    const movies = await approvedMovies(db, householdId);
    if (movies.length === 0) {
      await clearEmptyChannel(db, householdId, currentState);
      return null;
    }

    const remaining = await remainingRows(db, householdId, currentState);
    const nextCycle = remaining.length > 0 ? currentState.cycle : currentState.cycle + 1;
    const nextPosition = remaining[0]?.position ?? 0;
    const nextRotation = remaining.length > 0 ? [] : shuffled(movies, currentState.selection_seed, nextCycle);
    const nextMovie = remaining[0] ?? nextRotation[0];
    if (!nextMovie) return null;
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [claimMutation(db, householdId, currentState.revision, owner, now)];
    for (const [position, movie] of nextRotation.entries()) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
        (household_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, nextCycle, position, movie.programme_id, ...owns.values));
    }
    statements.push(
      db.prepare(`UPDATE movie_channel_state SET cycle = ?, current_position = ?, revision = revision + 1
        WHERE household_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
        .bind(nextCycle, nextPosition, householdId, currentState.cycle, currentState.current_position,
          currentState.revision, ...owns.values),
      db.prepare(`INSERT INTO current_programmes (household_id, channel, programme_id, video_id, selected_at)
        SELECT ?, 'movie', ?, ?, ? WHERE ${owns.sql}
        ON CONFLICT(household_id, channel) DO UPDATE SET programme_id = excluded.programme_id,
          video_id = excluded.video_id, selected_at = excluded.selected_at`)
        .bind(householdId, nextMovie.programme_id, nextMovie.imdb_id, now, ...owns.values),
    );
    await db.batch(statements);
    if (await ownsMutation(db, householdId, currentState.revision, owner)) return current(db, householdId);
  }
  return current(db, householdId);
}

export async function reconcileMovieChannel(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  await initialize(db, householdId, configuredSeed);
  await synchronizeRotation(db, householdId);
  return selectValidCurrent(db, householdId);
}

export async function movieChannelProgramme(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  return reconcileMovieChannel(db, householdId, configuredSeed);
}

export async function parentMovieChannelState(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<ParentMovieChannelState> {
  const currentProgramme = await reconcileMovieChannel(db, householdId, configuredSeed);
  const currentState = await state(db, householdId);
  const remaining = currentState ? await remainingRows(db, householdId, currentState) : [];
  const history = await db.prepare(`SELECT programme_id, imdb_id, title, played_at
    FROM movie_playback_history WHERE household_id = ? ORDER BY played_at DESC LIMIT 10`)
    .bind(householdId).all<{ programme_id: string; imdb_id: string; title: string; played_at: string }>();
  return {
    current: currentProgramme ?? undefined,
    remaining: remaining.map((movie) => programmeFromRow(movie, currentState!.cycle)),
    recentPlayback: history.results.map((item) => ({
      programmeId: item.programme_id,
      imdbId: item.imdb_id,
      title: item.title,
      playedAt: item.played_at,
    })),
  };
}

export async function resetMovieRotation(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  await reconcileMovieChannel(db, householdId, configuredSeed);
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId);
    const currentProgramme = await current(db, householdId);
    if (!currentState || !currentProgramme) return currentProgramme;
    const movies = await approvedMovies(db, householdId);
    const seed = configuredSeed ? `${configuredSeed}:reset:${currentState.revision}` : crypto.randomUUID();
    const future = shuffled(movies.filter((movie) => movie.programme_id !== currentProgramme.programmeId), seed, currentState.cycle);
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, currentState.revision, owner, now),
      db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND cycle = ? AND position != ? AND ${owns.sql}`)
        .bind(householdId, currentState.cycle, currentState.current_position, ...owns.values),
      db.prepare(`UPDATE movie_rotation SET consumed_at = NULL WHERE household_id = ? AND cycle = ?
        AND position = ? AND ${owns.sql}`)
        .bind(householdId, currentState.cycle, currentState.current_position, ...owns.values),
    ];
    for (const [offset, movie] of future.entries()) {
      statements.push(db.prepare(`INSERT INTO movie_rotation (household_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, currentState.cycle, currentState.current_position + offset + 1,
          movie.programme_id, ...owns.values));
    }
    statements.push(db.prepare(`UPDATE movie_channel_state SET selection_seed = ?, revision = revision + 1
      WHERE household_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
      .bind(seed, householdId, currentState.cycle, currentState.current_position,
        currentState.revision, ...owns.values));
    await db.batch(statements);
    if (await ownsMutation(db, householdId, currentState.revision, owner)) return current(db, householdId);
  }
  return current(db, householdId);
}

export async function removeApprovedMovie(
  db: D1Database,
  householdId: string,
  programmeId: string,
  configuredSeed?: string,
): Promise<void> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId);
    if (!currentState) {
      await db.batch([
        db.prepare("DELETE FROM current_programmes WHERE household_id = ? AND channel = 'movie' AND programme_id = ?")
          .bind(householdId, programmeId),
        db.prepare("DELETE FROM movie_rotation WHERE household_id = ? AND programme_id = ?").bind(householdId, programmeId),
        db.prepare("DELETE FROM approved_programmes WHERE household_id = ? AND id = ? AND content_type = 'movie'")
          .bind(householdId, programmeId),
      ]);
      return;
    }
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, currentState.revision, owner);
    await db.batch([
      claimMutation(db, householdId, currentState.revision, owner, now),
      db.prepare(`DELETE FROM current_programmes WHERE household_id = ? AND channel = 'movie'
        AND programme_id = ? AND ${owns.sql}`).bind(householdId, programmeId, ...owns.values),
      db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND programme_id = ? AND ${owns.sql}`)
        .bind(householdId, programmeId, ...owns.values),
      db.prepare(`DELETE FROM approved_programmes WHERE household_id = ? AND id = ?
        AND content_type = 'movie' AND ${owns.sql}`).bind(householdId, programmeId, ...owns.values),
      db.prepare(`UPDATE movie_channel_state SET revision = revision + 1
        WHERE household_id = ? AND revision = ? AND ${owns.sql}`)
        .bind(householdId, currentState.revision, ...owns.values),
    ]);
    if (await ownsMutation(db, householdId, currentState.revision, owner)) break;
  }
  await reconcileMovieChannel(db, householdId, configuredSeed);
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
  await reconcileMovieChannel(db, householdId);
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId);
    if (!currentState || currentState.cycle !== expectedCycle || currentState.current_position !== expectedPosition) return;
    const currentProgramme = await current(db, householdId);
    const movies = await approvedMovies(db, householdId);
    if (!currentProgramme || movies.length === 0) return;
    const remaining = await remainingRows(db, householdId, currentState);
    const nextCycle = remaining.length > 0 ? currentState.cycle : currentState.cycle + 1;
    const nextPosition = remaining[0]?.position ?? 0;
    const nextRotation = remaining.length > 0 ? [] : shuffled(movies, currentState.selection_seed, nextCycle);
    const nextMovie = remaining[0] ?? nextRotation[0];
    if (!nextMovie) return;

    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, currentState.revision, owner, now),
      db.prepare(`INSERT OR IGNORE INTO movie_advancements
        (household_id, cycle, position, owner_token, advanced_at)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, currentState.cycle, currentState.current_position, owner, now, ...owns.values),
      db.prepare(`INSERT INTO movie_playback_history
        (id, household_id, programme_id, imdb_id, title, cycle, position, played_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(owner, householdId, currentProgramme.programmeId, currentProgramme.imdbId,
          currentProgramme.title, currentState.cycle, currentState.current_position, now, ...owns.values),
      db.prepare(`UPDATE movie_rotation SET consumed_at = ?
        WHERE household_id = ? AND cycle = ? AND position = ? AND ${owns.sql}`)
        .bind(now, householdId, currentState.cycle, currentState.current_position, ...owns.values),
    ];
    for (const [position, movie] of nextRotation.entries()) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
        (household_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, nextCycle, position, movie.programme_id, ...owns.values));
    }
    statements.push(
      db.prepare(`UPDATE movie_channel_state SET cycle = ?, current_position = ?, revision = revision + 1
        WHERE household_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
        .bind(nextCycle, nextPosition, householdId, currentState.cycle, currentState.current_position,
          currentState.revision, ...owns.values),
      db.prepare(`UPDATE current_programmes SET programme_id = ?, video_id = ?, selected_at = ?
        WHERE household_id = ? AND channel = 'movie' AND ${owns.sql}`)
        .bind(nextMovie.programme_id, nextMovie.imdb_id, now, householdId, ...owns.values),
    );
    await db.batch(statements);
    if (await ownsMutation(db, householdId, currentState.revision, owner)) return;
  }
}
