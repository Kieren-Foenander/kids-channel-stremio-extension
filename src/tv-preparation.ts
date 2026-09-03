import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { loadTorBoxCredential, torBoxCredentialStatus } from "./torbox-credentials";
import { selectCachedStream, type StreamSelectionEnv, type StreamSelectionOutcome } from "./stream-selection";
import { tvChannelSchedule, type TvScheduledProgramme } from "./tv-channel";
import { channelsForHousehold } from "./channels";

const MAX_ROUNDS = 96;
const ITEMS_PER_STEP = 5;
const MAX_ITEM_BATCHES = 5;
const AUTOMATIC_PREPARATION_COUNT = 5;
const MAX_AUTOMATIC_PREPARATION_ITEMS = 25;
const AUTOMATIC_PREPARATION_WINDOW_HOURS = 8;
const AUTOMATIC_HOUSEHOLD_LIMIT = 100;

export type TvPreparationRunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type TvPreparationItemStatus = "queued" | "trying" | "downloading" | "ready" | "unavailable" | "cancelled";

export interface TvPreparationItem {
  channelId: string;
  position: number;
  programmeId: string;
  videoId: string;
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle: string;
  status: TvPreparationItemStatus;
  attempts: number;
  quality?: string;
  filename?: string;
  infoHash?: string;
  message?: string;
  updatedAt: string;
}

export interface TvPreparationRun {
  id: string;
  status: TvPreparationRunStatus;
  requestedCount: number;
  startedAt?: string;
  deadlineAt: string;
  completedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  counts: Record<TvPreparationItemStatus, number>;
  items: TvPreparationItem[];
}

interface RunRow {
  id: string;
  status: TvPreparationRunStatus;
  requested_count: number;
  started_at: string | null;
  deadline_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  channel_id: string;
  position: number;
  programme_id: string;
  video_id: string;
  show_imdb_id: string | null;
  release_info: string | null;
  show_title: string;
  season: number;
  episode: number;
  episode_title: string;
  status: TvPreparationItemStatus;
  attempts: number;
  quality: string | null;
  filename: string | null;
  info_hash: string | null;
  message: string | null;
  next_attempt_at: string | null;
  updated_at: string;
}

interface SelectionStateRow {
  download_pending: number;
  quality: string;
  filename: string;
  info_hash: string;
}

export function tvPreparationOutcomeMessage(outcome?: StreamSelectionOutcome): string {
  if (!outcome) return "Looking for a usable source";
  if (outcome.status === "no_candidates") return "No matching torrent sources found; searching again next round";
  if (outcome.status === "candidates_exhausted") return "Known sources are temporarily exhausted; searching again next round";
  if (outcome.status === "candidate_rejected") return "Source rejected; the next round will try another source";
  if (outcome.status === "temporarily_unavailable") return "TorBox could not inspect this source; it will be retried";
  if (outcome.status === "downloading") return "TorBox is downloading this source";
  return "Cached by TorBox";
}

export interface TvPreparationWorkflowParams {
  runId: string;
  householdId: string;
}

interface TvPreparationWorkflowEnv extends StreamSelectionEnv {
  DB: D1Database;
  CONFIG_SECRET?: string;
}

export interface AutomaticTvPreparationEnv extends TvPreparationWorkflowEnv {
  TV_PREPARATION: Workflow<TvPreparationWorkflowParams>;
  TV_SCHEDULE_SEED?: string;
  AUTOMATIC_TV_PREPARATION_DISABLED?: string;
}

export async function createTvPreparationRun(
  db: D1Database,
  householdId: string,
  schedule: TvScheduledProgramme[],
  count: number,
  windowHours: number,
  now = new Date(),
): Promise<TvPreparationRun> {
  const selected = schedule.slice(0, count);
  if (!selected.length) throw new Error("schedule is empty");
  const id = crypto.randomUUID();
  const timestamp = now.toISOString();
  const deadline = new Date(now.getTime() + windowHours * 60 * 60 * 1000).toISOString();
  try {
    await db.prepare(`INSERT INTO tv_preparation_runs
      (id, household_id, status, requested_count, deadline_at, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)`).bind(
      id, householdId, selected.length, deadline, timestamp, timestamp,
    ).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new Error("preparation already active");
    }
    throw error;
  }
  try {
    await db.batch(selected.map((programme, sequence) => db.prepare(`INSERT INTO tv_preparation_items
      (run_id, channel_id, position, sequence, programme_id, video_id, show_imdb_id, release_info,
       show_title, season, episode, episode_title, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).bind(
      id,
      programme.channelId,
      programme.position,
      sequence,
      programme.programmeId,
      programme.episode.id,
      programme.imdbId,
      programme.releaseInfo ?? null,
      programme.showTitle,
      programme.episode.season,
      programme.episode.episode,
      programme.episode.title,
      timestamp,
    )));
  } catch (error) {
    await db.prepare("DELETE FROM tv_preparation_runs WHERE id = ?").bind(id).run();
    throw error;
  }
  return (await tvPreparationRun(db, householdId, id))!;
}

export async function tvPreparationRun(
  db: D1Database,
  householdId: string,
  runId?: string,
): Promise<TvPreparationRun | null> {
  const row = runId
    ? await db.prepare("SELECT * FROM tv_preparation_runs WHERE household_id = ? AND id = ?")
      .bind(householdId, runId).first<RunRow>()
    : await db.prepare("SELECT * FROM tv_preparation_runs WHERE household_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(householdId).first<RunRow>();
  if (!row) return null;
  const { results } = await db.prepare(`SELECT * FROM tv_preparation_items
      WHERE run_id = ? ORDER BY sequence`)
    .bind(row.id).all<ItemRow>();
  const items = results.map((item): TvPreparationItem => {
    return {
      channelId: item.channel_id,
      position: item.position,
      programmeId: item.programme_id,
      videoId: item.video_id,
      showTitle: item.show_title,
      season: item.season,
      episode: item.episode,
      episodeTitle: item.episode_title,
      status: item.status,
      attempts: item.attempts,
      quality: item.quality ?? undefined,
      filename: item.filename ?? undefined,
      infoHash: item.info_hash ?? undefined,
      message: item.message ?? undefined,
      updatedAt: item.updated_at,
    };
  });
  return {
    id: row.id,
    status: row.status,
    requestedCount: row.requested_count,
    startedAt: row.started_at ?? undefined,
    deadlineAt: row.deadline_at,
    completedAt: row.completed_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: itemCounts(items),
    items,
  };
}

function itemCounts(items: TvPreparationItem[]): Record<TvPreparationItemStatus, number> {
  const counts: Record<TvPreparationItemStatus, number> = {
    queued: 0, trying: 0, downloading: 0, ready: 0, unavailable: 0, cancelled: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** One Preparation Run covers the whole Household, so a Channel's view of it must
 * count only its own positions rather than every Channel's. */
export function tvPreparationRunForChannel(run: TvPreparationRun, channelId: string): TvPreparationRun {
  const items = run.items.filter((item) => item.channelId === channelId);
  return { ...run, requestedCount: items.length, counts: itemCounts(items), items };
}

export async function cancelTvPreparationRun(
  db: D1Database,
  householdId: string,
  now = new Date(),
  message = "Stopped by Parent",
): Promise<TvPreparationRun | null> {
  const active = await db.prepare(`SELECT id FROM tv_preparation_runs
    WHERE household_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
    .bind(householdId).first<{ id: string }>();
  if (!active) return null;
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE tv_preparation_runs SET status = 'cancelled', completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`).bind(timestamp, timestamp, active.id),
    db.prepare(`UPDATE tv_preparation_items SET status = 'cancelled', message = ?, updated_at = ?
      WHERE run_id = ? AND status NOT IN ('ready', 'unavailable')`).bind(message, timestamp, active.id),
  ]);
  return tvPreparationRun(db, householdId, active.id);
}

async function activeTvPreparationRun(db: D1Database, householdId: string): Promise<TvPreparationRun | null> {
  const active = await db.prepare(`SELECT id FROM tv_preparation_runs
    WHERE household_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
    .bind(householdId).first<{ id: string }>();
  return active ? tvPreparationRun(db, householdId, active.id) : null;
}

function snapshotMatches(run: TvPreparationRun, schedule: TvScheduledProgramme[]): boolean {
  return run.items.length === schedule.length
    && run.items.every((item, index) => item.channelId === schedule[index]?.channelId
      && item.videoId === schedule[index]?.episode.id);
}

async function scheduleIsHot(
  db: D1Database,
  householdId: string,
  schedule: TvScheduledProgramme[],
  now: Date,
): Promise<boolean> {
  if (!schedule.length) return true;
  const videoIds = [...new Set(schedule.map((item) => item.episode.id))];
  const placeholders = videoIds.map(() => "?").join(", ");
  const row = await db.prepare(`SELECT COUNT(DISTINCT video_id) AS count FROM stream_selections
    WHERE household_id = ? AND content_type = 'series' AND download_pending = 0 AND stale_at > ?
      AND video_id IN (${placeholders})`)
    .bind(householdId, now.toISOString(), ...videoIds)
    .first<{ count: number }>();
  return (row?.count ?? 0) === videoIds.length;
}

async function householdPreparationSchedule(
  db: D1Database,
  householdId: string,
  configuredSeed?: string,
): Promise<TvScheduledProgramme[]> {
  const channels = await channelsForHousehold(db, householdId, "tv");
  const schedules = await Promise.all(channels.map((channel) =>
    tvChannelSchedule(db, householdId, channel.id, configuredSeed, AUTOMATIC_PREPARATION_COUNT)));
  const flattened: TvScheduledProgramme[] = [];
  for (let position = 0; position < AUTOMATIC_PREPARATION_COUNT; position += 1) {
    for (const schedule of schedules) {
      const programme = schedule[position];
      if (programme) flattened.push(programme);
    }
  }
  return flattened;
}

async function terminateRun(env: AutomaticTvPreparationEnv, runId: string): Promise<void> {
  if (env.AUTOMATIC_TV_PREPARATION_DISABLED === "true") return;
  try { await (await env.TV_PREPARATION.get(runId)).terminate(); } catch { /* D1 status prevents further useful work */ }
}

export async function stopAutomaticTvPreparation(
  env: AutomaticTvPreparationEnv,
  householdId: string,
  message: string,
  now = new Date(),
): Promise<void> {
  const active = await activeTvPreparationRun(env.DB, householdId);
  if (!active) return;
  await cancelTvPreparationRun(env.DB, householdId, now, message);
  await terminateRun(env, active.id);
}

export async function restartAutomaticTvPreparation(
  env: AutomaticTvPreparationEnv,
  householdId: string,
  now = new Date(),
): Promise<TvPreparationRun | null> {
  await stopAutomaticTvPreparation(env, householdId, "Restarted after the TorBox connection changed", now);
  return ensureAutomaticTvPreparation(env, householdId, undefined, now);
}

async function markRunFailed(db: D1Database, runId: string, reason: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await db.prepare(`UPDATE tv_preparation_runs
    SET status = 'failed', failure_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(reason, timestamp, timestamp, runId).run();
}

export async function ensureAutomaticTvPreparation(
  env: AutomaticTvPreparationEnv,
  householdId: string,
  suppliedSchedule?: TvScheduledProgramme[],
  now = new Date(),
): Promise<TvPreparationRun | null> {
  if (!(await torBoxCredentialStatus(env.DB, householdId)).configured) return null;
  const schedule = (suppliedSchedule
    ? suppliedSchedule.slice(0, AUTOMATIC_PREPARATION_COUNT)
    : await householdPreparationSchedule(env.DB, householdId, env.TV_SCHEDULE_SEED))
    .slice(0, MAX_AUTOMATIC_PREPARATION_ITEMS);
  const active = await activeTvPreparationRun(env.DB, householdId);
  if (active && snapshotMatches(active, schedule)) return active;
  if (active) {
    await cancelTvPreparationRun(env.DB, householdId, now, "Replaced by the latest Channel Schedule");
    await terminateRun(env, active.id);
  }
  if (!schedule.length || await scheduleIsHot(env.DB, householdId, schedule, now)) return null;

  let run: TvPreparationRun;
  try {
    run = await createTvPreparationRun(
      env.DB,
      householdId,
      schedule,
      schedule.length,
      AUTOMATIC_PREPARATION_WINDOW_HOURS,
      now,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "preparation already active") {
      return activeTvPreparationRun(env.DB, householdId);
    }
    throw error;
  }
  try {
    if (env.AUTOMATIC_TV_PREPARATION_DISABLED === "true") return run;
    await env.TV_PREPARATION.create({
      id: run.id,
      params: { runId: run.id, householdId },
      retention: { successRetention: "7 days", errorRetention: "7 days" },
    });
  } catch (error) {
    await markRunFailed(env.DB, run.id, "Cloudflare could not start automatic Channel preparation.", now);
    throw error;
  }
  return run;
}

export async function ensureAutomaticTvPreparationForAll(env: AutomaticTvPreparationEnv): Promise<void> {
  const timestamp = new Date().toISOString();
  const { results } = await env.DB.prepare(`SELECT household.id FROM households household
    WHERE household.torbox_token_ciphertext IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tv_preparation_runs run
        WHERE run.household_id = household.id AND run.status IN ('queued', 'running')
      )
      AND EXISTS (
        SELECT 1 FROM channel_schedule schedule
        WHERE schedule.household_id = household.id
          AND NOT EXISTS (
            SELECT 1 FROM stream_selections selection
            WHERE selection.household_id = household.id AND selection.content_type = 'series'
              AND selection.video_id = schedule.video_id AND selection.download_pending = 0
              AND selection.stale_at > ?
          )
      )
    ORDER BY household.created_at LIMIT ?`)
    .bind(timestamp, AUTOMATIC_HOUSEHOLD_LIMIT)
    .all<{ id: string }>();
  for (const household of results) {
    try {
      await ensureAutomaticTvPreparation(env, household.id);
    } catch (error) {
      console.error(JSON.stringify({
        message: "automatic TV preparation reconciliation failed",
        householdId: household.id,
        reason: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }
}

export function tvPreparationRetryDelayMinutes(
  outcome: StreamSelectionOutcome | undefined,
  attempt: number,
): number {
  if (outcome?.status === "downloading") return 5;
  if (attempt <= 3) return 5;
  if (attempt <= 7) return 15;
  return 30;
}

function releaseYear(value: string | null): number | undefined {
  const match = value?.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

async function processBatch(
  env: TvPreparationWorkflowEnv,
  runId: string,
  householdId: string,
  token: string,
  batchIndex: number,
): Promise<{ stop: boolean }> {
  const run = await env.DB.prepare("SELECT * FROM tv_preparation_runs WHERE household_id = ? AND id = ?")
    .bind(householdId, runId).first<RunRow>();
  if (!run || run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
    return { stop: true };
  }
  const now = new Date();
  if (Date.parse(run.deadline_at) <= now.getTime()) {
    await finishRun(env.DB, runId, now, "Preparation window ended");
    return { stop: true };
  }
  const sequenceStart = batchIndex * ITEMS_PER_STEP;
  const { results: items } = await env.DB.prepare(`SELECT * FROM tv_preparation_items
    WHERE run_id = ? AND sequence >= ? AND sequence < ?
      AND status NOT IN ('ready', 'unavailable', 'cancelled')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY sequence`).bind(
    runId,
    sequenceStart,
    sequenceStart + ITEMS_PER_STEP,
    now.toISOString(),
  ).all<ItemRow>();
  for (const item of items) {
    let outcome: StreamSelectionOutcome | undefined;
    const selection = await selectCachedStream(
      env.DB, householdId, "series", item.video_id, token, env, now, new Set(),
      {
        maxCacheChecks: 10,
        cacheCheckTimeoutMs: 1_000,
        onOutcome: (value) => { outcome = value; },
        programme: item.show_imdb_id ? {
          programmeId: item.programme_id,
          imdbId: item.show_imdb_id,
          title: item.show_title,
          year: releaseYear(item.release_info),
          season: item.season,
          episode: item.episode,
        } : undefined,
      },
    );
    const stored = await env.DB.prepare(`SELECT download_pending, quality, filename, info_hash FROM stream_selections
      WHERE household_id = ? AND content_type = 'series' AND video_id = ?`)
      .bind(householdId, item.video_id).first<SelectionStateRow>();
    const status: TvPreparationItemStatus = selection || (stored && stored.download_pending !== 1)
      ? "ready"
      : stored
        ? "downloading"
        : "trying";
    const message = tvPreparationOutcomeMessage(outcome);
    const attempt = item.attempts + 1;
    const nextAttemptAt = status === "ready"
      ? null
      : new Date(now.getTime() + tvPreparationRetryDelayMinutes(outcome, attempt) * 60 * 1000).toISOString();
    await env.DB.prepare(`UPDATE tv_preparation_items SET status = ?, attempts = attempts + 1,
      quality = ?, filename = ?, info_hash = ?, message = ?, next_attempt_at = ?, updated_at = ?
      WHERE run_id = ? AND channel_id = ? AND position = ? AND EXISTS (
        SELECT 1 FROM tv_preparation_runs run
        WHERE run.id = tv_preparation_items.run_id AND run.status IN ('queued', 'running')
      )`)
      .bind(
        status,
        selection?.quality ?? stored?.quality ?? null,
        selection?.filename ?? stored?.filename ?? null,
        selection?.infoHash ?? stored?.info_hash ?? null,
        message,
        nextAttemptAt,
        now.toISOString(),
        runId,
        item.channel_id,
        item.position,
      ).run();
  }
  return { stop: false };
}

export async function finishTvPreparationRound(
  db: D1Database,
  householdId: string,
  runId: string,
  now = new Date(),
): Promise<{ complete: boolean; sleepMs: number }> {
  const run = await db.prepare("SELECT * FROM tv_preparation_runs WHERE household_id = ? AND id = ?")
    .bind(householdId, runId).first<RunRow>();
  if (!run || run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
    return { complete: true, sleepMs: 0 };
  }
  if (Date.parse(run.deadline_at) <= now.getTime()) {
    await finishRun(db, runId, now, "Preparation window ended");
    return { complete: true, sleepMs: 0 };
  }
  const unfinished = await db.prepare(`SELECT COUNT(*) AS count,
      MIN(COALESCE(next_attempt_at, ?)) AS next_attempt_at
    FROM tv_preparation_items
    WHERE run_id = ? AND status NOT IN ('ready', 'unavailable', 'cancelled')`)
    .bind(now.toISOString(), runId).first<{ count: number; next_attempt_at: string | null }>();
  if ((unfinished?.count ?? 0) === 0) {
    await finishRun(db, runId, now);
    return { complete: true, sleepMs: 0 };
  }
  await db.prepare("UPDATE tv_preparation_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status != 'cancelled'")
    .bind(now.toISOString(), now.toISOString(), runId).run();
  const fallback = now.getTime() + 5 * 60 * 1000;
  const requestedWake = unfinished?.next_attempt_at ? Date.parse(unfinished.next_attempt_at) : fallback;
  const wakeAt = Math.min(Number.isFinite(requestedWake) ? requestedWake : fallback, Date.parse(run.deadline_at));
  return { complete: false, sleepMs: Math.max(1_000, wakeAt - now.getTime()) };
}

async function finishRun(db: D1Database, runId: string, now: Date, unfinishedMessage?: string): Promise<void> {
  const timestamp = now.toISOString();
  const statements = [];
  if (unfinishedMessage) statements.push(db.prepare(`UPDATE tv_preparation_items
    SET status = 'unavailable', message = ?, updated_at = ?
    WHERE run_id = ? AND status NOT IN ('ready', 'unavailable', 'cancelled')`).bind(unfinishedMessage, timestamp, runId));
  statements.push(db.prepare(`UPDATE tv_preparation_runs SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')`).bind(timestamp, timestamp, runId));
  await db.batch(statements);
}

export class TvSchedulePreparationWorkflow extends WorkflowEntrypoint<TvPreparationWorkflowEnv, TvPreparationWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<TvPreparationWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const { runId, householdId } = event.payload;
    try {
      const plan = await step.do("load preparation plan", async () => {
        const run = await this.env.DB.prepare("SELECT requested_count, status FROM tv_preparation_runs WHERE household_id = ? AND id = ?")
          .bind(householdId, runId).first<{ requested_count: number; status: TvPreparationRunStatus }>();
        return {
          stop: !run || ["cancelled", "failed", "completed"].includes(run.status),
          batchCount: Math.ceil((run?.requested_count ?? 0) / ITEMS_PER_STEP),
        };
      });
      if (plan.stop || plan.batchCount === 0) return;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        // Retain all five historical step names so active pre-deploy instances can replay their
        // cached boolean results. Surplus steps in new instances return without touching D1.
        for (let batch = 0; batch < MAX_ITEM_BATCHES; batch += 1) {
          const result = await step.do(`prepare round ${round + 1} batch ${batch + 1}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
            async () => {
              if (batch >= plan.batchCount) return { stop: false };
              if (!this.env.CONFIG_SECRET) throw new Error("Configuration secret is unavailable");
              // Keep the decrypted credential inside the step callback so it is never persisted as Workflow output.
              const token = await loadTorBoxCredential(this.env.DB, householdId, this.env.CONFIG_SECRET);
              if (!token) throw new Error("TorBox is not configured");
              return processBatch(this.env, runId, householdId, token, batch);
            }) as boolean | { stop: boolean };
          if (result === true || (typeof result === "object" && result.stop)) return;
        }
        const roundStatus = await step.do(`finish round ${round + 1}`, () =>
          finishTvPreparationRound(this.env.DB, householdId, runId));
        if (roundStatus.complete) return;
        await step.sleep(`wait for round ${round + 2}`, roundStatus.sleepMs);
      }
      await step.do("finish preparation window", () => finishRun(this.env.DB, runId, new Date(), "Preparation window ended"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preparation failed";
      await step.do("record preparation failure", async () => {
        const timestamp = new Date().toISOString();
        await this.env.DB.prepare(`UPDATE tv_preparation_runs SET status = 'failed', failure_reason = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')`).bind(message, timestamp, timestamp, runId).run();
      });
      throw error;
    }
  }
}
