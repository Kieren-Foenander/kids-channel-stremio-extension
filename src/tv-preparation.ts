import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { loadTorBoxCredential } from "./torbox-credentials";
import { selectCachedStream, type StreamSelectionEnv, type StreamSelectionOutcome } from "./stream-selection";
import type { TvScheduledProgramme } from "./tv-channel";

const ROUND_INTERVAL = "5 minutes";
const MAX_ROUNDS = 96;
const ITEMS_PER_STEP = 5;
const MAX_ITEM_BATCHES = 4;

export type TvPreparationRunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type TvPreparationItemStatus = "queued" | "trying" | "downloading" | "ready" | "unavailable" | "cancelled";

export interface TvPreparationItem {
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
  position: number;
  programme_id: string;
  video_id: string;
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
    await db.batch(selected.map((programme) => db.prepare(`INSERT INTO tv_preparation_items
      (run_id, position, programme_id, video_id, show_title, season, episode, episode_title, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).bind(
      id,
      programme.position,
      programme.programmeId,
      programme.episode.id,
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
  const { results } = await db.prepare("SELECT * FROM tv_preparation_items WHERE run_id = ? ORDER BY position")
    .bind(row.id).all<ItemRow>();
  const counts: Record<TvPreparationItemStatus, number> = {
    queued: 0, trying: 0, downloading: 0, ready: 0, unavailable: 0, cancelled: 0,
  };
  const items = results.map((item): TvPreparationItem => {
    counts[item.status] += 1;
    return {
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
    counts,
    items,
  };
}

export async function cancelTvPreparationRun(db: D1Database, householdId: string, now = new Date()): Promise<TvPreparationRun | null> {
  const active = await db.prepare(`SELECT id FROM tv_preparation_runs
    WHERE household_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
    .bind(householdId).first<{ id: string }>();
  if (!active) return null;
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE tv_preparation_runs SET status = 'cancelled', completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`).bind(timestamp, timestamp, active.id),
    db.prepare(`UPDATE tv_preparation_items SET status = 'cancelled', message = 'Stopped by Parent', updated_at = ?
      WHERE run_id = ? AND status NOT IN ('ready', 'unavailable')`).bind(timestamp, active.id),
  ]);
  return tvPreparationRun(db, householdId, active.id);
}

async function processBatch(
  env: TvPreparationWorkflowEnv,
  runId: string,
  householdId: string,
  token: string,
  batchIndex: number,
): Promise<boolean> {
  const run = await tvPreparationRun(env.DB, householdId, runId);
  if (!run || run.status === "cancelled" || run.status === "failed" || run.status === "completed") return true;
  const now = new Date();
  if (Date.parse(run.deadlineAt) <= now.getTime()) {
    await finishRun(env.DB, runId, now, "Preparation window ended");
    return true;
  }
  const items = run.items
    .slice(batchIndex * ITEMS_PER_STEP, (batchIndex + 1) * ITEMS_PER_STEP)
    .filter((candidate) => !["ready", "unavailable", "cancelled"].includes(candidate.status));
  for (const item of items) {
    let outcome: StreamSelectionOutcome | undefined;
    const selection = await selectCachedStream(
      env.DB, householdId, "series", item.videoId, token, env, now, new Set(),
      { maxCacheChecks: 10, cacheCheckTimeoutMs: 1_000, onOutcome: (value) => { outcome = value; } },
    );
    const stored = await env.DB.prepare(`SELECT download_pending, quality, filename, info_hash FROM stream_selections
      WHERE household_id = ? AND content_type = 'series' AND video_id = ?`)
      .bind(householdId, item.videoId).first<SelectionStateRow>();
    const status: TvPreparationItemStatus = selection || (stored && stored.download_pending !== 1)
      ? "ready"
      : stored
        ? "downloading"
        : "trying";
    const message = tvPreparationOutcomeMessage(outcome);
    await env.DB.prepare(`UPDATE tv_preparation_items SET status = ?, attempts = attempts + 1,
      quality = ?, filename = ?, info_hash = ?, message = ?, updated_at = ?
      WHERE run_id = ? AND position = ? AND EXISTS (
        SELECT 1 FROM tv_preparation_runs run
        WHERE run.id = tv_preparation_items.run_id AND run.status IN ('queued', 'running')
      )`)
      .bind(
        status,
        selection?.quality ?? stored?.quality ?? null,
        selection?.filename ?? stored?.filename ?? null,
        selection?.infoHash ?? stored?.info_hash ?? null,
        message,
        now.toISOString(),
        runId,
        item.position,
      ).run();
  }
  const unfinished = await env.DB.prepare(`SELECT COUNT(*) AS count FROM tv_preparation_items
    WHERE run_id = ? AND status NOT IN ('ready', 'unavailable', 'cancelled')`).bind(runId).first<{ count: number }>();
  if ((unfinished?.count ?? 0) === 0) {
    await finishRun(env.DB, runId, now);
    return true;
  }
  await env.DB.prepare("UPDATE tv_preparation_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status != 'cancelled'")
    .bind(now.toISOString(), now.toISOString(), runId).run();
  return false;
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
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        for (let batch = 0; batch < MAX_ITEM_BATCHES; batch += 1) {
          const complete = await step.do(`prepare round ${round + 1} batch ${batch + 1}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
            async () => {
              if (!this.env.CONFIG_SECRET) throw new Error("Configuration secret is unavailable");
              // Keep the decrypted credential inside the step callback so it is never persisted as Workflow output.
              const token = await loadTorBoxCredential(this.env.DB, householdId, this.env.CONFIG_SECRET);
              if (!token) throw new Error("TorBox is not configured");
              return processBatch(this.env, runId, householdId, token, batch);
            });
          if (complete) return;
        }
        await step.sleep(`wait for round ${round + 2}`, ROUND_INTERVAL);
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
