import type { CinemetaEpisode } from "./cinemeta";

export const TV_SCHEDULE_LENGTH = 20;

export interface TvCurrentProgramme {
  programmeId: string;
  imdbId: string;
  showTitle: string;
  description?: string;
  poster?: string;
  background?: string;
  episode: CinemetaEpisode;
}

interface ShowRow {
  programme_id: string;
  imdb_id: string;
  show_title: string;
  description: string | null;
  poster: string | null;
  background: string | null;
  next_video_id: string;
}

interface EpisodeRow {
  programme_id: string;
  video_id: string;
  season: number;
  episode: number;
  episode_title: string;
  released_at: string;
  overview: string | null;
}

interface ScheduleRow extends EpisodeRow {
  position: number;
  imdb_id: string;
  show_title: string;
  description: string | null;
  poster: string | null;
  background: string | null;
}

interface StateRow {
  current_position: number;
  selection_seed: string;
}

interface AdvancementHistoryRow {
  id: string;
  from_position: number;
  target_position: number;
  previous_programme_id: string;
  previous_video_id: string;
  target_programme_id: string;
  target_video_id: string;
  progress_before_json: string;
  progress_after_json: string;
  advanced_at: string;
}

export interface TvPlaybackHistoryItem {
  showTitle: string;
  episode: CinemetaEpisode;
  playedAt: string;
}

export interface ParentTvChannelState {
  current?: TvScheduledProgramme;
  schedule: TvScheduledProgramme[];
  recentPlayback: TvPlaybackHistoryItem[];
  canUndo: boolean;
}

interface Show {
  programmeId: string;
  imdbId: string;
  title: string;
  description?: string;
  poster?: string;
  background?: string;
  episodes: CinemetaEpisode[];
  progressIndex: number;
}

export interface TvScheduledProgramme extends TvCurrentProgramme {
  position: number;
}

function episodeFromRow(row: EpisodeRow): CinemetaEpisode {
  return {
    id: row.video_id,
    season: row.season,
    episode: row.episode,
    title: row.episode_title,
    released: row.released_at,
    overview: row.overview ?? undefined,
  };
}

function programmeFromRow(row: ScheduleRow): TvScheduledProgramme {
  return {
    position: row.position,
    programmeId: row.programme_id,
    imdbId: row.imdb_id,
    showTitle: row.show_title,
    description: row.description ?? undefined,
    poster: row.poster ?? undefined,
    background: row.background ?? undefined,
    episode: episodeFromRow(row),
  };
}

async function loadShows(db: D1Database, householdId: string): Promise<Show[]> {
  const showRows = await db.prepare(`SELECT programme.id AS programme_id, programme.imdb_id,
      programme.title AS show_title, programme.description, programme.poster, programme.background,
      progress.next_video_id
    FROM approved_programmes programme
    JOIN show_progress progress ON progress.programme_id = programme.id
    WHERE programme.household_id = ? AND programme.content_type = 'show' AND programme.paused_at IS NULL
    ORDER BY programme.approved_at, programme.id`).bind(householdId).all<ShowRow>();

  const episodeRows = await db.prepare(`SELECT episode.programme_id, episode.video_id, episode.season,
      episode.episode, episode.title AS episode_title, episode.released_at, episode.overview
    FROM show_episodes episode
    JOIN approved_programmes programme ON programme.id = episode.programme_id
    WHERE programme.household_id = ? AND programme.content_type = 'show'
    ORDER BY episode.programme_id, episode.season, episode.episode`).bind(householdId).all<EpisodeRow>();

  return showRows.results.flatMap((row) => {
    const episodes = episodeRows.results.filter((episode) => episode.programme_id === row.programme_id).map(episodeFromRow);
    const progressIndex = episodes.findIndex((episode) => episode.id === row.next_video_id);
    return progressIndex < 0 ? [] : [{
      programmeId: row.programme_id,
      imdbId: row.imdb_id,
      title: row.show_title,
      description: row.description ?? undefined,
      poster: row.poster ?? undefined,
      background: row.background ?? undefined,
      episodes,
      progressIndex,
    }];
  });
}

// A stable seed makes each persisted schedule reproducible while still distributing choices randomly.
function selectionIndex(seed: string, position: number, count: number): number {
  let hash = 2166136261;
  for (const character of `${seed}:${position}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function project(
  shows: Show[],
  seed: string,
  startPosition: number,
  count: number,
  existing: Array<{ programmeId: string; videoId: string }> = [],
  initialPreviousProgrammeId?: string,
  blockedVideoIds: ReadonlySet<string> = new Set(),
): TvScheduledProgramme[] {
  const cursors = new Map(shows.map((show) => [show.programmeId, show.progressIndex]));
  let previousProgrammeId = initialPreviousProgrammeId;

  for (const item of existing) {
    const show = shows.find((candidate) => candidate.programmeId === item.programmeId);
    if (!show) continue;
    const index = show.episodes.findIndex((episode) => episode.id === item.videoId);
    if (index >= 0) cursors.set(show.programmeId, index + 1);
    previousProgrammeId = show.programmeId;
  }

  const scheduled: TvScheduledProgramme[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    for (const show of shows) {
      let cursor = cursors.get(show.programmeId) ?? show.episodes.length;
      while (cursor < show.episodes.length && blockedVideoIds.has(show.episodes[cursor].id)) cursor += 1;
      cursors.set(show.programmeId, cursor);
    }
    const eligible = shows.filter((show) => (cursors.get(show.programmeId) ?? show.episodes.length) < show.episodes.length);
    if (eligible.length === 0) break;
    const alternatives = eligible.length > 1
      ? eligible.filter((show) => show.programmeId !== previousProgrammeId)
      : eligible;
    const candidates = alternatives.length > 0 ? alternatives : eligible;
    const position = startPosition + offset;
    const show = candidates[selectionIndex(seed, position, candidates.length)];
    const episodeIndex = cursors.get(show.programmeId) ?? show.progressIndex;
    const episode = show.episodes[episodeIndex];
    scheduled.push({
      position,
      programmeId: show.programmeId,
      imdbId: show.imdbId,
      showTitle: show.title,
      description: show.description,
      poster: show.poster,
      background: show.background,
      episode,
    });
    cursors.set(show.programmeId, episodeIndex + 1);
    previousProgrammeId = show.programmeId;
  }
  return scheduled;
}

async function scheduleRows(db: D1Database, householdId: string): Promise<TvScheduledProgramme[]> {
  const rows = await db.prepare(`SELECT schedule.position, schedule.programme_id, programme.imdb_id,
      programme.title AS show_title, programme.description, programme.poster, programme.background,
      episode.video_id, episode.season, episode.episode, episode.title AS episode_title,
      episode.released_at, episode.overview
    FROM channel_schedule schedule
    JOIN approved_programmes programme ON programme.id = schedule.programme_id
    JOIN show_episodes episode ON episode.programme_id = schedule.programme_id AND episode.video_id = schedule.video_id
    JOIN channel_state state ON state.household_id = schedule.household_id AND state.channel = schedule.channel
    WHERE schedule.household_id = ? AND schedule.channel = 'tv' AND schedule.position >= state.current_position
    ORDER BY schedule.position
    LIMIT ?`).bind(householdId, TV_SCHEDULE_LENGTH).all<ScheduleRow>();
  return rows.results.map(programmeFromRow);
}

async function initializeSchedule(db: D1Database, householdId: string, configuredSeed?: string): Promise<void> {
  if (await db.prepare("SELECT 1 FROM channel_state WHERE household_id = ? AND channel = 'tv'").bind(householdId).first()) return;
  const shows = await loadShows(db, householdId);
  if (shows.length === 0) return;

  const seed = configuredSeed || crypto.randomUUID();
  const existingCurrent = await db.prepare(`SELECT programme_id, video_id FROM current_programmes
    WHERE household_id = ? AND channel = 'tv'`).bind(householdId).first<{ programme_id: string; video_id: string }>();
  const currentShow = existingCurrent
    ? shows.find((show) => show.programmeId === existingCurrent.programme_id
      && show.episodes.some((episode) => episode.id === existingCurrent.video_id))
    : undefined;
  const currentEpisode = currentShow?.episodes.find((episode) => episode.id === existingCurrent?.video_id);
  const programmes: TvScheduledProgramme[] = currentShow && currentEpisode
    ? [{
      position: 0,
      programmeId: currentShow.programmeId,
      imdbId: currentShow.imdbId,
      showTitle: currentShow.title,
      description: currentShow.description,
      poster: currentShow.poster,
      background: currentShow.background,
      episode: currentEpisode,
    }, ...project(shows, seed, 1, TV_SCHEDULE_LENGTH - 1, [{
      programmeId: currentShow.programmeId,
      videoId: currentEpisode.id,
    }])]
    : project(shows, seed, 0, TV_SCHEDULE_LENGTH);
  if (programmes.length === 0) return;
  const now = new Date().toISOString();
  const first = programmes[0];
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO channel_state
      (household_id, channel, current_position, selection_seed, initialized_at) VALUES (?, 'tv', 0, ?, ?)`)
      .bind(householdId, seed, now),
    db.prepare(`INSERT OR IGNORE INTO current_programmes
      (household_id, channel, programme_id, video_id, selected_at) VALUES (?, 'tv', ?, ?, ?)`)
      .bind(householdId, first.programmeId, first.episode.id, now),
  ];
  for (const programme of programmes) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO channel_schedule
      (household_id, channel, position, programme_id, video_id, scheduled_at)
      VALUES (?, 'tv', ?, ?, ?, ?)`).bind(householdId, programme.position, programme.programmeId, programme.episode.id, now));
  }
  await db.batch(statements);
}

export async function tvChannelSchedule(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<TvScheduledProgramme[]> {
  await initializeSchedule(db, householdId, configuredSeed);
  return scheduleRows(db, householdId);
}

async function state(db: D1Database, householdId: string): Promise<StateRow | null> {
  return db.prepare(`SELECT current_position, selection_seed FROM channel_state
    WHERE household_id = ? AND channel = 'tv'`).bind(householdId).first<StateRow>();
}

async function advanceOnce(
  db: D1Database,
  householdId: string,
  target: TvScheduledProgramme,
  currentState: StateRow,
  currentSchedule: TvScheduledProgramme[],
): Promise<void> {
  const bypassed = currentSchedule.filter((programme) =>
    programme.position >= currentState.current_position && programme.position < target.position);
  const retained = currentSchedule.filter((programme) => programme.position >= target.position);
  const shows = await loadShows(db, householdId);
  const progressBefore: Record<string, string | null> = {};
  const progressAfter: Record<string, string | null> = {};
  for (const show of shows) {
    const skipped = bypassed.filter((programme) => programme.programmeId === show.programmeId);
    if (skipped.length === 0) continue;
    progressBefore[show.programmeId] = show.episodes[show.progressIndex]?.id ?? null;
    show.progressIndex = show.episodes.findIndex((episode) => episode.id === skipped[skipped.length - 1].episode.id) + 1;
    progressAfter[show.programmeId] = show.episodes[show.progressIndex]?.id ?? null;
  }
  const appendCount = TV_SCHEDULE_LENGTH - retained.length;
  const appended = project(
    shows,
    currentState.selection_seed,
    retained.length === 0 ? target.position : retained[retained.length - 1].position + 1,
    appendCount,
    retained.map((programme) => ({ programmeId: programme.programmeId, videoId: programme.episode.id })),
  );
  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  const owns = `EXISTS (SELECT 1 FROM channel_advancements claim
    WHERE claim.household_id = ? AND claim.channel = 'tv' AND claim.from_position = ? AND claim.owner_token = ?)`;
  const ownership = [householdId, currentState.current_position, owner] as const;
  const previous = bypassed[0];
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO channel_advancements
      (household_id, channel, from_position, target_position, owner_token, advanced_at)
      VALUES (?, 'tv', ?, ?, ?, ?)`).bind(householdId, currentState.current_position, target.position, owner, now),
    db.prepare(`INSERT INTO tv_advancement_history
      (id, household_id, from_position, target_position, previous_programme_id, previous_video_id,
       target_programme_id, target_video_id, progress_before_json, progress_after_json, advanced_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${owns}`)
      .bind(owner, householdId, currentState.current_position, target.position,
        previous.programmeId, previous.episode.id, target.programmeId, target.episode.id,
        JSON.stringify(progressBefore), JSON.stringify(progressAfter), now, ...ownership),
  ];

  for (const show of shows) {
    const skipped = bypassed.filter((programme) => programme.programmeId === show.programmeId);
    if (skipped.length === 0) continue;
    const lastIndex = show.episodes.findIndex((episode) => episode.id === skipped[skipped.length - 1].episode.id);
    const next = show.episodes[lastIndex + 1];
    statements.push(next
      ? db.prepare(`UPDATE show_progress SET next_video_id = ? WHERE programme_id = ? AND ${owns}`)
        .bind(next.id, show.programmeId, ...ownership)
      : db.prepare(`DELETE FROM show_progress WHERE programme_id = ? AND ${owns}`)
        .bind(show.programmeId, ...ownership));
  }

  statements.push(
    db.prepare(`UPDATE channel_state SET current_position = ?
      WHERE household_id = ? AND channel = 'tv' AND current_position = ? AND ${owns}`)
      .bind(target.position, householdId, currentState.current_position, ...ownership),
    db.prepare(`UPDATE current_programmes SET programme_id = ?, video_id = ?, selected_at = ?
      WHERE household_id = ? AND channel = 'tv' AND ${owns}`)
      .bind(target.programmeId, target.episode.id, now, householdId, ...ownership),
    db.prepare(`DELETE FROM channel_schedule WHERE household_id = ? AND channel = 'tv'
      AND position < ? AND ${owns}`).bind(householdId, target.position, ...ownership),
  );
  for (const programme of appended) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO channel_schedule
      (household_id, channel, position, programme_id, video_id, scheduled_at)
      SELECT ?, 'tv', ?, ?, ?, ? WHERE ${owns}`)
      .bind(householdId, programme.position, programme.programmeId, programme.episode.id, now, ...ownership));
  }
  await db.batch(statements);
}

export async function refreshTvChannelSchedule(
  db: D1Database,
  householdId: string,
  regenerate = false,
  configuredSeed?: string,
): Promise<TvScheduledProgramme[]> {
  const currentState = await state(db, householdId);
  if (!currentState) {
    await initializeSchedule(db, householdId, configuredSeed);
    return scheduleRows(db, householdId);
  }

  const shows = await loadShows(db, householdId);
  if (shows.length === 0) {
    await db.batch([
      db.prepare("DELETE FROM channel_schedule WHERE household_id = ? AND channel = 'tv'").bind(householdId),
      db.prepare("DELETE FROM current_programmes WHERE household_id = ? AND channel = 'tv'").bind(householdId),
      db.prepare("DELETE FROM channel_advancements WHERE household_id = ? AND channel = 'tv'").bind(householdId),
      db.prepare("DELETE FROM channel_state WHERE household_id = ? AND channel = 'tv'").bind(householdId),
    ]);
    return [];
  }

  const storedCurrent = await db.prepare(`SELECT programme_id, video_id FROM current_programmes
    WHERE household_id = ? AND channel = 'tv'`).bind(householdId)
    .first<{ programme_id: string; video_id: string }>();
  const currentShow = storedCurrent
    ? shows.find((show) => show.programmeId === storedCurrent.programme_id
      && show.episodes.some((episode) => episode.id === storedCurrent.video_id))
    : undefined;
  const currentEpisode = currentShow?.episodes.find((episode) => episode.id === storedCurrent?.video_id);
  const seed = regenerate ? crypto.randomUUID() : currentState.selection_seed;
  const position = currentState.current_position;
  const programmes: TvScheduledProgramme[] = currentShow && currentEpisode
    ? [{
      position,
      programmeId: currentShow.programmeId,
      imdbId: currentShow.imdbId,
      showTitle: currentShow.title,
      description: currentShow.description,
      poster: currentShow.poster,
      background: currentShow.background,
      episode: currentEpisode,
    }, ...project(
      shows,
      seed,
      position + 1,
      TV_SCHEDULE_LENGTH - 1,
      currentShow.episodes[currentShow.progressIndex]?.id === currentEpisode.id
        ? [{ programmeId: currentShow.programmeId, videoId: currentEpisode.id }]
        : [],
      currentShow.programmeId,
      new Set([currentEpisode.id]),
    )]
    : project(shows, seed, position, TV_SCHEDULE_LENGTH);

  if (programmes.length === 0) return [];
  const now = new Date().toISOString();
  const first = programmes[0];
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM channel_schedule WHERE household_id = ? AND channel = 'tv'").bind(householdId),
    db.prepare(`UPDATE channel_state SET selection_seed = ?
      WHERE household_id = ? AND channel = 'tv'`).bind(seed, householdId),
    db.prepare(`INSERT INTO current_programmes (household_id, channel, programme_id, video_id, selected_at)
      VALUES (?, 'tv', ?, ?, ?)
      ON CONFLICT(household_id, channel) DO UPDATE SET programme_id = excluded.programme_id,
        video_id = excluded.video_id, selected_at = excluded.selected_at`)
      .bind(householdId, first.programmeId, first.episode.id, now),
  ];
  for (const programme of programmes) {
    statements.push(db.prepare(`INSERT INTO channel_schedule
      (household_id, channel, position, programme_id, video_id, scheduled_at)
      VALUES (?, 'tv', ?, ?, ?, ?)`)
      .bind(householdId, programme.position, programme.programmeId, programme.episode.id, now));
  }
  await db.batch(statements);
  return scheduleRows(db, householdId);
}

export async function parentTvChannelState(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<ParentTvChannelState> {
  const schedule = await tvChannelSchedule(db, householdId, configuredSeed);
  const history = await db.prepare(`SELECT programme.title AS show_title,
      episode.video_id, episode.season, episode.episode, episode.title, episode.released_at, episode.overview,
      history.advanced_at
    FROM tv_advancement_history history
    JOIN approved_programmes programme ON programme.id = history.previous_programme_id
    JOIN show_episodes episode ON episode.programme_id = history.previous_programme_id
      AND episode.video_id = history.previous_video_id
    WHERE history.household_id = ?
    ORDER BY history.advanced_at DESC LIMIT 10`).bind(householdId).all<Record<string, unknown>>();
  const canUndo = Boolean(await db.prepare(`SELECT 1 FROM tv_advancement_history history
    JOIN channel_state state ON state.household_id = history.household_id AND state.channel = 'tv'
    WHERE history.household_id = ? AND history.undone_at IS NULL
      AND history.target_position = state.current_position
    ORDER BY history.advanced_at DESC LIMIT 1`).bind(householdId).first());
  return {
    current: schedule[0],
    schedule,
    recentPlayback: history.results.map((row) => ({
      showTitle: row.show_title as string,
      episode: episodeFromRow({
        programme_id: "",
        video_id: row.video_id as string,
        season: row.season as number,
        episode: row.episode as number,
        episode_title: row.title as string,
        released_at: row.released_at as string,
        overview: row.overview as string | null,
      }),
      playedAt: row.advanced_at as string,
    })),
    canUndo,
  };
}

export async function setShowProgress(
  db: D1Database,
  householdId: string,
  programmeId: string,
  videoId: string,
  configuredSeed?: string,
): Promise<void> {
  const episode = await db.prepare(`SELECT episode.video_id FROM show_episodes episode
    JOIN approved_programmes programme ON programme.id = episode.programme_id
    WHERE programme.household_id = ? AND programme.id = ? AND programme.content_type = 'show'
      AND episode.video_id = ?`).bind(householdId, programmeId, videoId).first();
  if (!episode) throw new Error("episode is invalid");
  await db.prepare(`INSERT INTO show_progress (programme_id, next_video_id) VALUES (?, ?)
    ON CONFLICT(programme_id) DO UPDATE SET next_video_id = excluded.next_video_id`)
    .bind(programmeId, videoId).run();
  await refreshTvChannelSchedule(db, householdId, false, configuredSeed);
}

export async function undoLatestTvAdvancement(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<boolean> {
  const history = await db.prepare(`SELECT history.* FROM tv_advancement_history history
    JOIN channel_state state ON state.household_id = history.household_id AND state.channel = 'tv'
    WHERE history.household_id = ? AND history.undone_at IS NULL
      AND history.target_position = state.current_position
    ORDER BY history.advanced_at DESC LIMIT 1`).bind(householdId).first<AdvancementHistoryRow>();
  if (!history) return false;

  const before = JSON.parse(history.progress_before_json) as Record<string, string | null>;
  const after = JSON.parse(history.progress_after_json) as Record<string, string | null>;
  const now = new Date().toISOString();
  const undoOwner = crypto.randomUUID();
  const ownsUndo = "EXISTS (SELECT 1 FROM tv_advancement_history WHERE id = ? AND undo_owner_token = ?)";
  const ownership = [history.id, undoOwner] as const;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE tv_advancement_history SET undone_at = ?, undo_owner_token = ?
      WHERE id = ? AND undone_at IS NULL AND EXISTS (
        SELECT 1 FROM channel_state WHERE household_id = ? AND channel = 'tv' AND current_position = ?)`)
      .bind(now, undoOwner, history.id, householdId, history.target_position),
  ];
  for (const [programmeId, previousVideoId] of Object.entries(before)) {
    const expectedVideoId = after[programmeId];
    if (previousVideoId === null) continue;
    if (expectedVideoId === null) {
      statements.push(db.prepare(`INSERT INTO show_progress (programme_id, next_video_id)
        SELECT ?, ? WHERE ${ownsUndo} AND NOT EXISTS (SELECT 1 FROM show_progress WHERE programme_id = ?)`)
        .bind(programmeId, previousVideoId, ...ownership, programmeId));
    } else {
      statements.push(db.prepare(`UPDATE show_progress SET next_video_id = ?
        WHERE programme_id = ? AND next_video_id = ? AND ${ownsUndo}`)
        .bind(previousVideoId, programmeId, expectedVideoId, ...ownership));
    }
  }
  statements.push(
    db.prepare(`UPDATE channel_state SET current_position = ?
      WHERE household_id = ? AND channel = 'tv' AND current_position = ? AND ${ownsUndo}`)
      .bind(history.from_position, householdId, history.target_position, ...ownership),
    db.prepare(`UPDATE current_programmes SET programme_id = ?, video_id = ?, selected_at = ?
      WHERE household_id = ? AND channel = 'tv' AND ${ownsUndo}`)
      .bind(history.previous_programme_id, history.previous_video_id, now, householdId, ...ownership),
  );
  await db.batch(statements);
  await refreshTvChannelSchedule(db, householdId, false, configuredSeed);
  return true;
}

export async function requestTvProgramme(
  db: D1Database,
  householdId: string,
  videoId: string,
  configuredSeed?: string,
): Promise<TvScheduledProgramme[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const schedule = await tvChannelSchedule(db, householdId, configuredSeed);
    const currentState = await state(db, householdId);
    if (!currentState || schedule.length === 0) return schedule;
    const target = schedule.find((programme) => programme.episode.id === videoId);
    if (!target || target.position <= currentState.current_position) return schedule;
    await advanceOnce(db, householdId, target, currentState, schedule);
    const latest = await state(db, householdId);
    if (!latest || latest.current_position >= target.position) return scheduleRows(db, householdId);
  }
  return scheduleRows(db, householdId);
}
