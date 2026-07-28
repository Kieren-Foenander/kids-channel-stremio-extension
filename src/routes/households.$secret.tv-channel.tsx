import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Card } from "../components/ui/card";
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
    <section className="destination tv-channel-page" aria-labelledby="page-heading">
      <header className="destination-header">
        <p className="eyebrow">Channel</p>
        <h1 id="page-heading">TV Channel</h1>
        <p>Inspect what will resume, review upcoming selections, and correct the latest advancement.</p>
      </header>

      {!state ? (
        channelQuery.isError ? (
          <Card className="channel-load-error">
            <h2>TV Channel unavailable</h2>
            <p role="alert">{apiErrorMessage(channelQuery.error, "TV Channel data could not be loaded. Check your connection and try again.")}</p>
            <Button type="button" className="button-secondary" onClick={() => void channelQuery.refetch()}>Try again</Button>
          </Card>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {channelQuery.isError && <p className="inline-error" role="alert">Channel data may be out of date.</p>}
          <p className="sr-status" role="status" aria-live="polite">{channelQuery.isFetching ? "Refreshing Channel data…" : ""}</p>

          <Card className="current-programme" aria-labelledby="current-programme-heading">
            <div>
              <h2 id="current-programme-heading" className="eyebrow">Current Programme</h2>
              <h3>{state.current?.showTitle || "Nothing scheduled"}</h3>
              {state.current ? <p className="current-episode">{episodeLabel(state.current.episode)}</p> : <p>Add or resume an approved show to start the TV Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.showTitle}`} />}
          </Card>

          <section className="channel-section" aria-labelledby="schedule-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Full schedule</p><h2 id="schedule-heading">Channel Schedule</h2></div>
              <span className="item-count">{state.schedule.length} programme{state.schedule.length === 1 ? "" : "s"}</span>
            </div>
            {state.schedule.length ? (
              <ol className="schedule-list" aria-labelledby="schedule-heading">
                {state.schedule.map((programme, index) => (
                  <li key={`${programme.position}-${programme.episode.id}`} aria-current={index === 0 ? "true" : undefined}>
                    <span className="schedule-marker" aria-hidden="true">{index + 1}</span>
                    <div><strong>{programme.showTitle}</strong><span>{episodeLabel(programme.episode)}</span></div>
                    {index === 0 && <span className="current-badge">Current</span>}
                  </li>
                ))}
              </ol>
            ) : <div className="card channel-empty"><p>No programmes are scheduled. Add or resume shows in the Approved Library.</p></div>}
          </section>

          <section className="channel-section" aria-labelledby="history-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Playback</p><h2 id="history-heading">Recent playback</h2></div>
              {state.canUndo && <Button type="button" className="button-secondary compact-button" disabled={mutation !== null} onClick={() => void performAction("undo")}>{mutation === "undo" ? "Undoing…" : "Undo latest advancement"}</Button>}
            </div>
            {history.length ? (
              <ol id="recent-playback-list" className="history-list" aria-labelledby="history-heading">
                {visibleHistory.map((item, index) => <li key={`${item.playedAt}-${item.episode.id}-${index}`}><div><strong>{item.showTitle}</strong><span>{episodeLabel(item.episode)}</span></div><time dateTime={item.playedAt}>{new Date(item.playedAt).toLocaleDateString()}</time></li>)}
              </ol>
            ) : <p className="muted-copy">No recent playback.</p>}
            {history.length > HISTORY_PREVIEW_SIZE && <Button type="button" className="button-secondary disclosure-button" aria-expanded={historyExpanded} aria-controls="recent-playback-list" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? "Show fewer" : `Show all ${history.length}`}</Button>}
          </section>

          <section className="card regeneration" aria-labelledby="regeneration-heading">
            <div><h2 id="regeneration-heading">Regenerate upcoming selections</h2><p>Choose a new order for future programmes without interrupting the Current Programme.</p></div>
            <Button type="button" className="button-secondary" disabled={mutation !== null || state.schedule.length === 0} onClick={() => setConfirmingRegeneration(true)}>Regenerate schedule</Button>
          </section>

          <p className={mutationFailed ? "inline-error" : "action-status"} role={mutationFailed ? "alert" : "status"} aria-live="polite">{mutationStatus}</p>
        </>
      )}

      <ConfirmationDialog open={confirmingRegeneration} pending={mutation === "regenerate"} onOpenChange={setConfirmingRegeneration} onConfirm={() => performAction("regenerate")} />
    </section>
  );
}

function ChannelSkeleton() {
  return <div className="channel-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Loading TV Channel"><Skeleton className="skeleton-block skeleton-current" /><Skeleton className="skeleton-block skeleton-list" /><span className="sr-only">Loading TV Channel…</span></div>;
}

function ConfirmationDialog({ open, pending, onOpenChange, onConfirm }: { open: boolean; pending: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  return <Dialog modal={false} open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent className="data-closed:hidden" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Regenerate upcoming selections?</DialogTitle>
        <DialogDescription>This changes only upcoming TV selections. The Current Programme and Show Progress remain unchanged.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" className="button-secondary" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={pending} onClick={() => { void onConfirm().then(() => onOpenChange(false)).catch(() => undefined); }}>{pending ? "Regenerating…" : "Regenerate selections"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
