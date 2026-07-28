import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { useMovieChannel } from "../lib/channel-queries";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/movie-channel")({ component: MovieChannelPage });

type MovieProgramme = {
  programmeId: string;
  imdbId: string;
  title: string;
  poster?: string;
  releaseInfo?: string;
  position: number;
};

type PlaybackItem = {
  programmeId: string;
  imdbId: string;
  title: string;
  playedAt: string;
};

type MovieState = {
  current?: MovieProgramme;
  remaining: MovieProgramme[];
  recentPlayback: PlaybackItem[];
};

const ROTATION_PREVIEW_SIZE = 6;
const HISTORY_PREVIEW_SIZE = 5;

function MovieChannelPage() {
  const { secret } = Route.useParams();
  const base = `/api/households/${secret}`;
  const queryClient = useQueryClient();
  const channelQuery = useMovieChannel<MovieState>(secret);
  const state = channelQuery.data;
  const [rotationExpanded, setRotationExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [mutationStatus, setMutationStatus] = useState("");
  const [mutationFailed, setMutationFailed] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetMutation = useMutation({
    mutationFn: () => parentApi<{ message?: string }>(`${base}/movie-rotation/reset`, { method: "POST" }),
  });

  async function resetRotation() {
    if (resetMutation.isPending) return;
    setMutationStatus("");
    setMutationFailed(false);
    try {
      const result = await resetMutation.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: parentKeys.movie(secret) });
      setMutationStatus(result.message || "Movie rotation reset without interrupting the Current Programme.");
      window.dispatchEvent(new Event("stremio-restart-required"));
    } catch (error) {
      setMutationFailed(true);
      setMutationStatus(apiErrorMessage(error, "The Movie Channel could not be changed. Check your connection and try again."));
      throw error;
    }
  }

  const resetting = resetMutation.isPending;
  const remaining = state?.remaining ?? [];
  const history = state?.recentPlayback ?? [];
  const visibleRotation = rotationExpanded ? remaining : remaining.slice(0, ROTATION_PREVIEW_SIZE);
  const visibleHistory = historyExpanded ? history : history.slice(0, HISTORY_PREVIEW_SIZE);

  return (
    <section className="destination movie-channel-page" aria-labelledby="page-heading">
      <header className="destination-header">
        <p className="eyebrow">Channel</p>
        <h1 id="page-heading">Movie Channel</h1>
        <p>Inspect the movie that will resume and review what remains in this rotation.</p>
      </header>

      {!state ? (
        channelQuery.isError ? (
          <Card className="channel-load-error">
            <h2>Movie Channel unavailable</h2>
            <p role="alert">{apiErrorMessage(channelQuery.error, "Movie Channel data could not be loaded. Check your connection and try again.")}</p>
            <Button type="button" className="button-secondary" onClick={() => void channelQuery.refetch()}>Try again</Button>
          </Card>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {channelQuery.isError && <p className="inline-error" role="alert">Movie Channel data may be out of date.</p>}
          <p className="sr-status" role="status" aria-live="polite">{channelQuery.isFetching ? "Refreshing Movie Channel data…" : ""}</p>

          <Card className="current-programme movie-current-programme" aria-labelledby="current-programme-heading">
            <div>
              <h2 id="current-programme-heading" className="eyebrow">Current Programme</h2>
              <h3>{state.current?.title || "Nothing selected"}</h3>
              {state.current
                ? <p className="current-episode">{state.current.releaseInfo || "Ready to resume in Stremio"}</p>
                : <p>Add an approved movie to start the Movie Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.title}`} />}
          </Card>

          <section className="channel-section" aria-labelledby="rotation-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Up next</p><h2 id="rotation-heading">Remaining rotation</h2></div>
              <span className="item-count">{remaining.length} movie{remaining.length === 1 ? "" : "s"}</span>
            </div>
            {remaining.length ? (
              <ol id="remaining-rotation-list" className="schedule-list movie-rotation-list" aria-labelledby="rotation-heading">
                {visibleRotation.map((movie, index) => (
                  <li key={`${movie.position}-${movie.programmeId}`}>
                    <span className="schedule-marker" aria-hidden="true">{index + 1}</span>
                    <div><strong>{movie.title}</strong>{movie.releaseInfo && <span>{movie.releaseInfo}</span>}</div>
                  </li>
                ))}
              </ol>
            ) : <div className="card channel-empty"><p>{state.current ? "No movies remain after the Current Programme." : "No movies are available. Add movies in the Approved Library."}</p></div>}
            {remaining.length > ROTATION_PREVIEW_SIZE && <Button type="button" className="button-secondary disclosure-button" aria-expanded={rotationExpanded} aria-controls="remaining-rotation-list" onClick={() => setRotationExpanded(value => !value)}>{rotationExpanded ? "Show fewer movies" : `Show all ${remaining.length} movies`}</Button>}
          </section>

          <section className="channel-section" aria-labelledby="history-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Playback</p><h2 id="history-heading">Recent playback</h2></div>
            </div>
            {history.length ? (
              <ol id="movie-playback-list" className="history-list" aria-labelledby="history-heading">
                {visibleHistory.map((item, index) => <li key={`${item.playedAt}-${item.programmeId}-${index}`}><div><strong>{item.title}</strong></div><time dateTime={item.playedAt}>{new Date(item.playedAt).toLocaleDateString()}</time></li>)}
              </ol>
            ) : <p className="muted-copy">No recent playback.</p>}
            {history.length > HISTORY_PREVIEW_SIZE && <Button type="button" className="button-secondary disclosure-button" aria-expanded={historyExpanded} aria-controls="movie-playback-list" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? "Show fewer" : `Show all ${history.length}`}</Button>}
          </section>

          <section className="card regeneration movie-reset" aria-labelledby="reset-heading">
            <div><h2 id="reset-heading">Reset movie rotation</h2><p>Return every approved movie to the remaining rotation without interrupting the Current Programme.</p></div>
            <Button type="button" className="button-secondary" disabled={resetting || !state.current} onClick={() => setConfirmingReset(true)}>Reset rotation</Button>
          </section>

          <p className={mutationFailed ? "inline-error" : "action-status"} role={mutationFailed ? "alert" : "status"} aria-live="polite">{mutationStatus}</p>
        </>
      )}

      <ResetConfirmationDialog open={confirmingReset} pending={resetting} error={mutationFailed ? mutationStatus : ""} onOpenChange={setConfirmingReset} onConfirm={resetRotation} />
    </section>
  );
}

function ChannelSkeleton() {
  return <div className="channel-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Loading Movie Channel"><Skeleton className="skeleton-block skeleton-current" /><Skeleton className="skeleton-block skeleton-list" /><span className="sr-only">Loading Movie Channel…</span></div>;
}

function ResetConfirmationDialog({ open, pending, error, onOpenChange, onConfirm }: { open: boolean; pending: boolean; error: string; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  return <Dialog modal={false} open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent className="data-closed:hidden" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Reset movie rotation?</DialogTitle>
        <DialogDescription>Every approved movie will return to the remaining rotation. The Current Programme will not be interrupted.</DialogDescription>
      </DialogHeader>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <DialogFooter>
        <Button type="button" className="button-secondary" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={pending} onClick={() => { void onConfirm().then(() => onOpenChange(false)).catch(() => undefined); }}>{pending ? "Resetting…" : "Reset rotation"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
