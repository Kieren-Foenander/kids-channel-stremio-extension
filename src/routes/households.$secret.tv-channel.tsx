import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Ident } from "../components/Ident";
import { PageHeader } from "../components/PageHeader";
import { StateBadge } from "../components/StateBadge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { useTvChannel } from "../lib/channel-queries";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/tv-channel")({ component: TvChannelPage });

type Episode = {
  id: string;
  season: number;
  episode: number;
  title: string;
  released?: string;
};

type ScheduledProgramme = {
  position: number;
  programmeId: string;
  showTitle: string;
  poster?: string;
  episode: Episode;
};

type PlaybackItem = {
  showTitle: string;
  episode: Episode;
  playedAt: string;
};

type TvState = {
  current?: ScheduledProgramme;
  schedule: ScheduledProgramme[];
  recentPlayback: PlaybackItem[];
  canUndo: boolean;
};

const HISTORY_PREVIEW_SIZE = 5;

function episodeLabel(episode: Episode) {
  return `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} — ${episode.title}`;
}

function TvChannelPage() {
  const { secret } = Route.useParams();
  const base = `/api/households/${secret}`;
  const queryClient = useQueryClient();
  const channelQuery = useTvChannel<TvState>(secret);
  const state = channelQuery.data;
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [mutationStatus, setMutationStatus] = useState("");
  const [mutationFailed, setMutationFailed] = useState(false);
  const [confirmingRegeneration, setConfirmingRegeneration] = useState(false);
  const actionMutation = useMutation({
    mutationFn: async (kind: "undo" | "regenerate") => {
      const path = kind === "undo" ? "/tv-schedule/undo" : "/tv-schedule/regenerate";
      return parentApi<{ message?: string }>(`${base}${path}`, { method: "POST" });
    },
  });

  async function performAction(kind: "undo" | "regenerate") {
    if (actionMutation.isPending) return;
    setMutationStatus("");
    setMutationFailed(false);
    try {
      const result = await actionMutation.mutateAsync(kind);
      await queryClient.invalidateQueries({ queryKey: parentKeys.tv(secret) });
      setMutationStatus(result.message || (kind === "undo" ? "Most recent advancement undone." : "Upcoming TV selections regenerated."));
      window.dispatchEvent(new Event("stremio-restart-required"));
    } catch (error) {
      setMutationFailed(true);
      setMutationStatus(apiErrorMessage(error, "The TV Channel could not be changed. Check your connection and try again."));
      throw error;
    }
  }

  const mutation = actionMutation.isPending ? actionMutation.variables : null;
  const history = state?.recentPlayback ?? [];
  const visibleHistory = historyExpanded ? history : history.slice(0, HISTORY_PREVIEW_SIZE);

  return (
    <section className="grid gap-10" aria-labelledby="page-heading">
      <PageHeader ident="Channel" title="TV Channel" description="Inspect what will resume, review upcoming selections, and correct the latest advancement." />

      {!state ? (
        channelQuery.isError ? (
          <section className="rounded-[4px] border bg-card p-5" role="alert">
            <h2 className="text-lg font-semibold">TV Channel unavailable</h2>
            <p className="mt-1 text-sm text-muted-foreground">{apiErrorMessage(channelQuery.error, "TV Channel data could not be loaded. Check your connection and try again.")}</p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => void channelQuery.refetch()}>Try again</Button>
          </section>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {channelQuery.isError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">Channel data may be out of date.</p>}
          <p className="sr-only" role="status" aria-live="polite">{channelQuery.isFetching ? "Refreshing Channel data…" : ""}</p>

          <section className="relative flex min-h-48 items-center gap-6 rounded-[4px] border bg-card p-6 before:absolute before:inset-y-4 before:left-0 before:w-0.5 before:rounded-full before:bg-signal" aria-labelledby="current-programme-heading">
            <div className="min-w-0 flex-1">
              <h2 id="current-programme-heading" className="sr-only">Current Programme</h2>
              <Ident className="mb-3">On now</Ident>
              <h3 className="text-[clamp(1.4rem,4vw,2rem)] leading-tight font-semibold tracking-[-0.02em] break-words">{state.current?.showTitle || "Nothing scheduled"}</h3>
              {state.current
                ? <p className="mt-2 font-mono text-sm text-muted-foreground">{episodeLabel(state.current.episode)}</p>
                : <p className="mt-2 text-sm text-muted-foreground">Add or resume an approved show to start the TV Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.showTitle}`} className="h-36 w-24 shrink-0 rounded-[3px] object-cover max-sm:h-27 max-sm:w-18" />}
          </section>

          <section aria-labelledby="schedule-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h2 id="schedule-heading" className="text-xl font-semibold tracking-[-0.01em]">Channel Schedule</h2>
              <span className="font-mono text-xs font-medium text-muted-foreground">{state.schedule.length} programme{state.schedule.length === 1 ? "" : "s"}</span>
            </div>
            {state.schedule.length ? (
              <ol className="divide-y border-y" aria-labelledby="schedule-heading">
                {state.schedule.map((programme, index) => (
                  <li key={`${programme.position}-${programme.episode.id}`} aria-current={index === 0 ? "true" : undefined} className="relative flex min-w-0 items-center gap-3 px-2 py-3 aria-[current=true]:before:absolute aria-[current=true]:before:inset-y-2 aria-[current=true]:before:left-0 aria-[current=true]:before:w-0.5 aria-[current=true]:before:rounded-full aria-[current=true]:before:bg-signal">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-[3px] border font-mono text-xs font-semibold text-muted-foreground" aria-hidden="true">{index + 1}</span>
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm font-medium">{programme.showTitle}</strong>
                      <span className="truncate font-mono text-xs text-muted-foreground">{episodeLabel(programme.episode)}</span>
                    </div>
                    {index === 0 && <StateBadge current className="ml-auto max-sm:hidden">Current</StateBadge>}
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">No programmes are scheduled. Add or resume shows in the Approved Library.</p>}
          </section>

          <section aria-labelledby="history-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h2 id="history-heading" className="text-xl font-semibold tracking-[-0.01em]">Recent playback</h2>
              {state.canUndo && <Button type="button" variant="outline" size="sm" disabled={mutation !== null} onClick={() => void performAction("undo")}>{mutation === "undo" ? "Undoing…" : "Undo latest advancement"}</Button>}
            </div>
            {history.length ? (
              <ol id="recent-playback-list" className="divide-y border-y" aria-labelledby="history-heading">
                {visibleHistory.map((item, index) => (
                  <li key={`${item.playedAt}-${item.episode.id}-${index}`} className="flex min-w-0 items-center gap-3 px-2 py-3">
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm font-medium">{item.showTitle}</strong>
                      <span className="truncate font-mono text-xs text-muted-foreground">{episodeLabel(item.episode)}</span>
                    </div>
                    <time dateTime={item.playedAt} className="ml-auto shrink-0 font-mono text-xs text-muted-foreground max-sm:hidden">{new Date(item.playedAt).toLocaleDateString()}</time>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">No recent playback.</p>}
            {history.length > HISTORY_PREVIEW_SIZE && <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={historyExpanded} aria-controls="recent-playback-list" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? "Show fewer" : `Show all ${history.length}`}</Button>}
          </section>

          <section className="flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="regeneration-heading">
            <div>
              <h2 id="regeneration-heading" className="text-base font-semibold">Regenerate upcoming selections</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Choose a new order for future programmes without interrupting the Current Programme.</p>
            </div>
            <Button type="button" variant="outline" className="shrink-0 max-sm:w-full" disabled={mutation !== null || state.schedule.length === 0} onClick={() => setConfirmingRegeneration(true)}>Regenerate schedule</Button>
          </section>

          <p className={mutationFailed ? "rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" : "min-h-5 text-sm font-medium text-accent"} role={mutationFailed ? "alert" : "status"} aria-live="polite">{mutationStatus}</p>
        </>
      )}

      <ConfirmationDialog open={confirmingRegeneration} pending={mutation === "regenerate"} onOpenChange={setConfirmingRegeneration} onConfirm={() => performAction("regenerate")} />
    </section>
  );
}

function ChannelSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-live="polite" aria-busy="true" aria-label="Loading TV Channel">
      <Skeleton className="h-48" />
      <Skeleton className="h-96" />
      <span className="sr-only">Loading TV Channel…</span>
    </div>
  );
}

function ConfirmationDialog({ open, pending, onOpenChange, onConfirm }: { open: boolean; pending: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  return (
    <Dialog modal={false} open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="data-closed:hidden" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Regenerate upcoming selections?</DialogTitle>
          <DialogDescription>This changes only upcoming TV selections. The Current Programme and Show Progress remain unchanged.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => { void onConfirm().then(() => onOpenChange(false)).catch(() => undefined); }}>{pending ? "Regenerating…" : "Regenerate selections"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
