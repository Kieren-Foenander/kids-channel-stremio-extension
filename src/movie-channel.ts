export const MOVIE_CHANNEL_ID = "kids-channels:movie";
const SIGN_OFF_PREFIX = "kids-channels:movie-sign-off";
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
  channelId: string;
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

async function approvedMovies(db: D1Database, householdId: string, channelId: string): Promise<MovieRow[]> {
  const rows = await db.prepare(`SELECT id AS programme_id, imdb_id, title, description, poster,
      background, release_info, approved_at
    FROM approved_programmes programme
    JOIN channel_assignments assignment ON assignment.programme_id = programme.id
    WHERE programme.household_id = ? AND assignment.channel_id = ? AND content_type = 'movie'
    ORDER BY assignment.created_at, id`).bind(householdId, channelId).all<MovieRow>();
  return rows.results;
}

async function state(db: D1Database, householdId: string, channelId: string): Promise<MovieStateRow | null> {
  return db.prepare(`SELECT cycle, current_position, selection_seed, revision
    FROM movie_channel_state WHERE household_id = ? AND channel_id = ?`)
    .bind(householdId, channelId).first<MovieStateRow>();
}

function programmeFromRow(
  row: CurrentMovieRow | RotationRow,
  channelId: string,
  requestedCycle?: number,
): MovieProgramme {
  const cycle = requestedCycle ?? ("cycle" in row ? row.cycle : 0);
  const position = "position" in row ? row.position : row.current_position;
  return {
    channelId,
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
    signOffId: `${SIGN_OFF_PREFIX}:${channelId}:${cycle}:${position}`,
  };
}

function mutationOwnership(householdId: string, channelId: string, revision: number, owner: string) {
  const sql = `EXISTS (SELECT 1 FROM movie_channel_mutations mutation
    WHERE mutation.household_id = ? AND mutation.channel_id = ?
      AND mutation.revision = ? AND mutation.owner_token = ?)`;
  return { sql, values: [householdId, channelId, revision, owner] as const };
}

function claimMutation(
  db: D1Database,
  householdId: string,
  channelId: string,
  revision: number,
  owner: string,
  now: string,
) {
  return db.prepare(`INSERT OR IGNORE INTO movie_channel_mutations
    (household_id, channel_id, revision, owner_token, claimed_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(householdId, channelId, revision, owner, now);
}

async function ownsMutation(
  db: D1Database,
  householdId: string,
  channelId: string,
  revision: number,
  owner: string,
): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM movie_channel_mutations
    WHERE household_id = ? AND channel_id = ? AND revision = ? AND owner_token = ?`)
    .bind(householdId, channelId, revision, owner).first());
}

async function initialize(db: D1Database, householdId: string, channelId: string, configuredSeed?: string): Promise<void> {
  if (await state(db, householdId, channelId)) return;
  const movies = await approvedMovies(db, householdId, channelId);
  if (movies.length === 0) return;

  const seed = configuredSeed || crypto.randomUUID();
  const rotation = shuffled(movies, seed, 0);
  const now = new Date().toISOString();
  const first = rotation[0];
  const ownsInitialState = `EXISTS (SELECT 1 FROM movie_channel_state
    WHERE household_id = ? AND channel_id = ? AND selection_seed = ? AND revision = 0)`;
  const initialOwnership = [householdId, channelId, seed] as const;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO movie_channel_state
      (household_id, channel_id, cycle, current_position, selection_seed, initialized_at, revision)
      VALUES (?, ?, 0, 0, ?, ?, 0)`).bind(householdId, channelId, seed, now),
  ];
  for (const [position, movie] of rotation.entries()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
      (household_id, channel_id, cycle, position, programme_id)
      SELECT ?, ?, 0, ?, ? WHERE ${ownsInitialState}`)
      .bind(householdId, channelId, position, movie.programme_id, ...initialOwnership));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO current_programmes
    (household_id, channel_id, programme_id, video_id, selected_at)
    SELECT ?, ?, ?, ?, ? WHERE ${ownsInitialState}`)
    .bind(householdId, channelId, first.programme_id, first.imdb_id, now, ...initialOwnership));
  await db.batch(statements);
}

async function current(db: D1Database, householdId: string, channelId: string): Promise<MovieProgramme | null> {
  const row = await db.prepare(`SELECT state.cycle, state.current_position, state.selection_seed, state.revision,
      programme.id AS programme_id, programme.imdb_id, programme.title, programme.description,
      programme.poster, programme.background, programme.release_info, programme.approved_at
    FROM movie_channel_state state
    JOIN movie_rotation rotation ON rotation.channel_id = state.channel_id
      AND rotation.cycle = state.cycle AND rotation.position = state.current_position
      AND rotation.consumed_at IS NULL
    JOIN approved_programmes programme ON programme.id = rotation.programme_id
    WHERE state.household_id = ? AND state.channel_id = ?`).bind(householdId, channelId).first<CurrentMovieRow>();
  return row ? programmeFromRow(row, channelId) : null;
}

async function remainingRows(
  db: D1Database,
  householdId: string,
  channelId: string,
  currentState: MovieStateRow,
): Promise<RotationRow[]> {
  const rows = await db.prepare(`SELECT rotation.position, programme.id AS programme_id, programme.imdb_id,
      programme.title, programme.description, programme.poster, programme.background,
      programme.release_info, programme.approved_at
    FROM movie_rotation rotation
    JOIN approved_programmes programme ON programme.id = rotation.programme_id
    WHERE rotation.household_id = ? AND rotation.channel_id = ? AND rotation.cycle = ? AND rotation.position > ?
      AND rotation.consumed_at IS NULL AND programme.content_type = 'movie'
    ORDER BY rotation.position`).bind(householdId, channelId, currentState.cycle, currentState.current_position).all<RotationRow>();
  return rows.results;
}

async function synchronizeRotation(db: D1Database, householdId: string, channelId: string): Promise<void> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId, channelId);
    if (!currentState) return;
    const [movies, membership] = await Promise.all([
      approvedMovies(db, householdId, channelId),
      db.prepare(`SELECT position, programme_id FROM movie_rotation
        WHERE household_id = ? AND channel_id = ? AND cycle = ?`)
        .bind(householdId, channelId, currentState.cycle).all<{ position: number; programme_id: string }>(),
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
    const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, channelId, currentState.revision, owner, now),
    ];
    for (const [offset, movie] of additions.entries()) {
      statements.push(db.prepare(`INSERT INTO movie_rotation (household_id, channel_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, channelId, currentState.cycle, finalPosition + offset + 1,
          movie.programme_id, ...owns.values));
    }
    statements.push(db.prepare(`UPDATE movie_channel_state SET revision = revision + 1
      WHERE household_id = ? AND channel_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
      .bind(householdId, channelId, currentState.cycle, currentState.current_position, currentState.revision, ...owns.values));
    await db.batch(statements);
    if (await ownsMutation(db, householdId, channelId, currentState.revision, owner)) return;
  }
}

async function clearEmptyChannel(
  db: D1Database,
  householdId: string,
  channelId: string,
  currentState: MovieStateRow,
): Promise<void> {
  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
  await db.batch([
    claimMutation(db, householdId, channelId, currentState.revision, owner, now),
    db.prepare(`DELETE FROM current_programmes WHERE household_id = ? AND channel_id = ? AND ${owns.sql}`)
      .bind(householdId, channelId, ...owns.values),
    db.prepare(`DELETE FROM movie_advancements WHERE household_id = ? AND channel_id = ? AND ${owns.sql}`)
      .bind(householdId, channelId, ...owns.values),
    db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND channel_id = ? AND ${owns.sql}`)
      .bind(householdId, channelId, ...owns.values),
    db.prepare(`DELETE FROM movie_channel_state WHERE household_id = ? AND channel_id = ? AND revision = ? AND ${owns.sql}`)
      .bind(householdId, channelId, currentState.revision, ...owns.values),
  ]);
}

async function selectValidCurrent(db: D1Database, householdId: string, channelId: string): Promise<MovieProgramme | null> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentProgramme = await current(db, householdId, channelId);
    if (currentProgramme) return currentProgramme;
    const currentState = await state(db, householdId, channelId);
    if (!currentState) return null;
    const movies = await approvedMovies(db, householdId, channelId);
    if (movies.length === 0) {
      await clearEmptyChannel(db, householdId, channelId, currentState);
      return null;
    }

    const remaining = await remainingRows(db, householdId, channelId, currentState);
    const nextCycle = remaining.length > 0 ? currentState.cycle : currentState.cycle + 1;
    const nextPosition = remaining[0]?.position ?? 0;
    const nextRotation = remaining.length > 0 ? [] : shuffled(movies, currentState.selection_seed, nextCycle);
    const nextMovie = remaining[0] ?? nextRotation[0];
    if (!nextMovie) return null;
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [claimMutation(db, householdId, channelId, currentState.revision, owner, now)];
    for (const [position, movie] of nextRotation.entries()) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
        (household_id, channel_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, channelId, nextCycle, position, movie.programme_id, ...owns.values));
    }
    statements.push(
      db.prepare(`UPDATE movie_channel_state SET cycle = ?, current_position = ?, revision = revision + 1
        WHERE household_id = ? AND channel_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
        .bind(nextCycle, nextPosition, householdId, channelId, currentState.cycle, currentState.current_position,
          currentState.revision, ...owns.values),
      db.prepare(`INSERT INTO current_programmes (household_id, channel_id, programme_id, video_id, selected_at)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}
        ON CONFLICT(channel_id) DO UPDATE SET programme_id = excluded.programme_id,
          video_id = excluded.video_id, selected_at = excluded.selected_at`)
        .bind(householdId, channelId, nextMovie.programme_id, nextMovie.imdb_id, now, ...owns.values),
    );
    await db.batch(statements);
    if (await ownsMutation(db, householdId, channelId, currentState.revision, owner)) {
      return current(db, householdId, channelId);
    }
  }
  return current(db, householdId, channelId);
}

export async function reconcileMovieChannel(
  db: D1Database,
  householdId: string,
  channelId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  await initialize(db, householdId, channelId, configuredSeed);
  await synchronizeRotation(db, householdId, channelId);
  return selectValidCurrent(db, householdId, channelId);
}

export async function movieChannelProgramme(
  db: D1Database,
  householdId: string,
  channelId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  return reconcileMovieChannel(db, householdId, channelId, configuredSeed);
}

export async function parentMovieChannelState(
  db: D1Database,
  householdId: string,
  channelId: string,
  configuredSeed?: string,
): Promise<ParentMovieChannelState> {
  const currentProgramme = await reconcileMovieChannel(db, householdId, channelId, configuredSeed);
  const currentState = await state(db, householdId, channelId);
  const remaining = currentState ? await remainingRows(db, householdId, channelId, currentState) : [];
  const history = await db.prepare(`SELECT programme_id, imdb_id, title, played_at
    FROM movie_playback_history WHERE household_id = ? AND channel_id = ? ORDER BY played_at DESC LIMIT 10`)
    .bind(householdId, channelId).all<{ programme_id: string; imdb_id: string; title: string; played_at: string }>();
  return {
    current: currentProgramme ?? undefined,
    remaining: remaining.map((movie) => programmeFromRow(movie, channelId, currentState!.cycle)),
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
  channelId: string,
  configuredSeed?: string,
): Promise<MovieProgramme | null> {
  await reconcileMovieChannel(db, householdId, channelId, configuredSeed);
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId, channelId);
    const currentProgramme = await current(db, householdId, channelId);
    if (!currentState || !currentProgramme) return currentProgramme;
    const movies = await approvedMovies(db, householdId, channelId);
    const seed = configuredSeed ? `${configuredSeed}:reset:${currentState.revision}` : crypto.randomUUID();
    const future = shuffled(movies.filter((movie) => movie.programme_id !== currentProgramme.programmeId), seed, currentState.cycle);
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, channelId, currentState.revision, owner, now),
      db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND channel_id = ?
        AND cycle = ? AND position != ? AND ${owns.sql}`)
        .bind(householdId, channelId, currentState.cycle, currentState.current_position, ...owns.values),
      db.prepare(`UPDATE movie_rotation SET consumed_at = NULL WHERE household_id = ? AND channel_id = ? AND cycle = ?
        AND position = ? AND ${owns.sql}`)
        .bind(householdId, channelId, currentState.cycle, currentState.current_position, ...owns.values),
    ];
    for (const [offset, movie] of future.entries()) {
      statements.push(db.prepare(`INSERT INTO movie_rotation (household_id, channel_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, channelId, currentState.cycle, currentState.current_position + offset + 1,
          movie.programme_id, ...owns.values));
    }
    statements.push(db.prepare(`UPDATE movie_channel_state SET selection_seed = ?, revision = revision + 1
      WHERE household_id = ? AND channel_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
      .bind(seed, householdId, channelId, currentState.cycle, currentState.current_position,
        currentState.revision, ...owns.values));
    await db.batch(statements);
    if (await ownsMutation(db, householdId, channelId, currentState.revision, owner)) {
      return current(db, householdId, channelId);
    }
  }
  return current(db, householdId, channelId);
}

export async function removeApprovedMovie(
  db: D1Database,
  householdId: string,
  channelId: string,
  programmeId: string,
  configuredSeed?: string,
): Promise<void> {
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId, channelId);
    if (!currentState) {
      await db.batch([
        db.prepare("DELETE FROM current_programmes WHERE household_id = ? AND channel_id = ? AND programme_id = ?")
          .bind(householdId, channelId, programmeId),
        db.prepare("DELETE FROM movie_rotation WHERE household_id = ? AND channel_id = ? AND programme_id = ?")
          .bind(householdId, channelId, programmeId),
        db.prepare("DELETE FROM channel_assignments WHERE channel_id = ? AND programme_id = ?")
          .bind(channelId, programmeId),
      ]);
      return;
    }
    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
    await db.batch([
      claimMutation(db, householdId, channelId, currentState.revision, owner, now),
      db.prepare(`DELETE FROM current_programmes WHERE household_id = ? AND channel_id = ?
        AND programme_id = ? AND ${owns.sql}`).bind(householdId, channelId, programmeId, ...owns.values),
      db.prepare(`DELETE FROM movie_rotation WHERE household_id = ? AND channel_id = ?
        AND programme_id = ? AND ${owns.sql}`).bind(householdId, channelId, programmeId, ...owns.values),
      db.prepare(`DELETE FROM channel_assignments WHERE channel_id = ? AND programme_id = ? AND ${owns.sql}`)
        .bind(channelId, programmeId, ...owns.values),
      db.prepare(`UPDATE movie_channel_state SET revision = revision + 1
        WHERE household_id = ? AND channel_id = ? AND revision = ? AND ${owns.sql}`)
        .bind(householdId, channelId, currentState.revision, ...owns.values),
    ]);
    if (await ownsMutation(db, householdId, channelId, currentState.revision, owner)) break;
  }
  await reconcileMovieChannel(db, householdId, channelId, configuredSeed);
}

export function parseSignOffId(videoId: string): { channelId?: string; cycle: number; position: number } | null {
  const escapedPrefix = SIGN_OFF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoped = videoId.match(new RegExp(`^${escapedPrefix}:([^:]+):(\\d+):(\\d+)$`));
  if (scoped) return { channelId: scoped[1], cycle: Number(scoped[2]), position: Number(scoped[3]) };
  const legacy = videoId.match(new RegExp(`^${escapedPrefix}:(\\d+):(\\d+)$`));
  return legacy ? { cycle: Number(legacy[1]), position: Number(legacy[2]) } : null;
}

export async function requestMovieSignOff(
  db: D1Database,
  householdId: string,
  channelId: string,
  expectedCycle: number,
  expectedPosition: number,
): Promise<void> {
  await reconcileMovieChannel(db, householdId, channelId);
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    const currentState = await state(db, householdId, channelId);
    if (!currentState || currentState.cycle !== expectedCycle || currentState.current_position !== expectedPosition) return;
    const currentProgramme = await current(db, householdId, channelId);
    const movies = await approvedMovies(db, householdId, channelId);
    if (!currentProgramme || movies.length === 0) return;
    const remaining = await remainingRows(db, householdId, channelId, currentState);
    const nextCycle = remaining.length > 0 ? currentState.cycle : currentState.cycle + 1;
    const nextPosition = remaining[0]?.position ?? 0;
    const nextRotation = remaining.length > 0 ? [] : shuffled(movies, currentState.selection_seed, nextCycle);
    const nextMovie = remaining[0] ?? nextRotation[0];
    if (!nextMovie) return;

    const owner = crypto.randomUUID();
    const now = new Date().toISOString();
    const owns = mutationOwnership(householdId, channelId, currentState.revision, owner);
    const statements: D1PreparedStatement[] = [
      claimMutation(db, householdId, channelId, currentState.revision, owner, now),
      db.prepare(`INSERT OR IGNORE INTO movie_advancements
        (household_id, channel_id, cycle, position, owner_token, advanced_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, channelId, currentState.cycle, currentState.current_position, owner, now, ...owns.values),
      db.prepare(`INSERT INTO movie_playback_history
        (id, household_id, channel_id, programme_id, imdb_id, title, cycle, position, played_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(owner, householdId, channelId, currentProgramme.programmeId, currentProgramme.imdbId,
          currentProgramme.title, currentState.cycle, currentState.current_position, now, ...owns.values),
      db.prepare(`UPDATE movie_rotation SET consumed_at = ?
        WHERE household_id = ? AND channel_id = ? AND cycle = ? AND position = ? AND ${owns.sql}`)
        .bind(now, householdId, channelId, currentState.cycle, currentState.current_position, ...owns.values),
    ];
    for (const [position, movie] of nextRotation.entries()) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO movie_rotation
        (household_id, channel_id, cycle, position, programme_id)
        SELECT ?, ?, ?, ?, ? WHERE ${owns.sql}`)
        .bind(householdId, channelId, nextCycle, position, movie.programme_id, ...owns.values));
    }
    statements.push(
      db.prepare(`UPDATE movie_channel_state SET cycle = ?, current_position = ?, revision = revision + 1
        WHERE household_id = ? AND channel_id = ? AND cycle = ? AND current_position = ? AND revision = ? AND ${owns.sql}`)
        .bind(nextCycle, nextPosition, householdId, channelId, currentState.cycle, currentState.current_position,
          currentState.revision, ...owns.values),
      db.prepare(`UPDATE current_programmes SET programme_id = ?, video_id = ?, selected_at = ?
        WHERE household_id = ? AND channel_id = ? AND ${owns.sql}`)
        .bind(nextMovie.programme_id, nextMovie.imdb_id, now, householdId, channelId, ...owns.values),
    );
    await db.batch(statements);
    if (await ownsMutation(db, householdId, channelId, currentState.revision, owner)) return;
  }
}
