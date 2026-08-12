import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ChannelCollectionControl } from "../components/ChannelCollectionControl";
import { Ident } from "../components/Ident";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { useMovieChannel } from "../lib/channel-queries";
import { useChannels } from "../lib/channels";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/movie-channel")({
  validateSearch: (search: Record<string, unknown>) => ({
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
  component: MovieChannelPage,
});

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
  const { channel } = Route.useSearch();
  const navigate = Route.useNavigate();
  const chooseChannel = useCallback((channelId: string) => {
    void navigate({ search: { channel: channelId }, replace: true });
  }, [navigate]);
  const base = `/api/households/${secret}`;
  const queryClient = useQueryClient();
  const channelsQuery = useChannels(secret, "movie");
  const channels = channelsQuery.data ?? [];
  const activeChannelId = channels.find((candidate) => candidate.id === channel)?.id ?? channels[0]?.id;
  const channelQuery = useMovieChannel<MovieState>(secret, activeChannelId);
  const state = channelQuery.data;
  const [rotationExpanded, setRotationExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [mutationStatus, setMutationStatus] = useState("");
  const [mutationFailed, setMutationFailed] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetMutation = useMutation({
    mutationFn: () => parentApi<{ message?: string }>(
      `${base}/channels/${activeChannelId}/movie-rotation/reset`, { method: "POST" }),
  });

  async function resetRotation() {
    if (resetMutation.isPending) return;
    setMutationStatus("");
    setMutationFailed(false);
    try {
      const result = await resetMutation.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: parentKeys.movie(secret, activeChannelId) });
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
    <section className="grid gap-10" aria-labelledby="page-heading">
      <PageHeader ident="Channels" title="Movie Channels" description="Create named Movie Channels, then inspect the current movie and remaining rotation for each one." />
      <ChannelCollectionControl secret={secret} type="movie" selectedId={channel} onSelect={chooseChannel} />

      {!channelsQuery.isPending && channels.length === 0 ? (
        <section className="rounded-[4px] border bg-card p-5">
          <h2 className="text-lg font-semibold">No Movie Channels</h2>
          <p className="mt-1 text-sm text-muted-foreground">Create a Movie Channel above to start rotating approved movies.</p>
        </section>
      ) : !state ? (
        channelQuery.isError ? (
          <section className="rounded-[4px] border bg-card p-5" role="alert">
            <h2 className="text-lg font-semibold">Movie Channel unavailable</h2>
            <p className="mt-1 text-sm text-muted-foreground">{apiErrorMessage(channelQuery.error, "Movie Channel data could not be loaded. Check your connection and try again.")}</p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => void channelQuery.refetch()}>Try again</Button>
          </section>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {channelQuery.isError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">Movie Channel data may be out of date.</p>}
          <p className="sr-only" role="status" aria-live="polite">{channelQuery.isFetching ? "Refreshing Movie Channel data…" : ""}</p>

          <section className="relative flex min-h-48 items-center gap-6 rounded-[4px] border bg-card p-6 before:absolute before:inset-y-4 before:left-0 before:w-0.5 before:rounded-full before:bg-signal" aria-labelledby="current-programme-heading">
            <div className="min-w-0 flex-1">
              <h2 id="current-programme-heading" className="sr-only">Current Programme</h2>
              <Ident className="mb-3">On now</Ident>
              <h3 className="text-[clamp(1.4rem,4vw,2rem)] leading-tight font-semibold tracking-[-0.02em] break-words">{state.current?.title || "Nothing selected"}</h3>
              {state.current
                ? <p className="mt-2 font-mono text-sm text-muted-foreground">{state.current.releaseInfo || "Ready to resume in Stremio"}</p>
                : <p className="mt-2 text-sm text-muted-foreground">Add an approved movie to start the Movie Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.title}`} className="h-36 w-24 shrink-0 rounded-[3px] object-cover max-sm:h-27 max-sm:w-18" />}
          </section>

          <section aria-labelledby="rotation-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h2 id="rotation-heading" className="text-xl font-semibold tracking-[-0.01em]">Remaining rotation</h2>
              <span className="font-mono text-xs font-medium text-muted-foreground">{remaining.length} movie{remaining.length === 1 ? "" : "s"}</span>
            </div>
            {remaining.length ? (
              <ol id="remaining-rotation-list" className="divide-y border-y" aria-labelledby="rotation-heading">
                {visibleRotation.map((movie, index) => (
                  <li key={`${movie.position}-${movie.programmeId}`} className="flex min-w-0 items-center gap-3 px-2 py-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-[3px] border font-mono text-xs font-semibold text-muted-foreground" aria-hidden="true">{index + 1}</span>
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm font-medium">{movie.title}</strong>
                      {movie.releaseInfo && <span className="truncate font-mono text-xs text-muted-foreground">{movie.releaseInfo}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">{state.current ? "No movies remain after the Current Programme." : "No movies are available. Add movies in the Approved Library."}</p>}
            {remaining.length > ROTATION_PREVIEW_SIZE && <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={rotationExpanded} aria-controls="remaining-rotation-list" onClick={() => setRotationExpanded(value => !value)}>{rotationExpanded ? "Show fewer movies" : `Show all ${remaining.length} movies`}</Button>}
          </section>

          <section aria-labelledby="history-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h2 id="history-heading" className="text-xl font-semibold tracking-[-0.01em]">Recent playback</h2>
            </div>
            {history.length ? (
              <ol id="movie-playback-list" className="divide-y border-y" aria-labelledby="history-heading">
                {visibleHistory.map((item, index) => (
                  <li key={`${item.playedAt}-${item.programmeId}-${index}`} className="flex min-w-0 items-center gap-3 px-2 py-3">
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm font-medium">{item.title}</strong>
                    </div>
                    <time dateTime={item.playedAt} className="ml-auto shrink-0 font-mono text-xs text-muted-foreground max-sm:hidden">{new Date(item.playedAt).toLocaleDateString()}</time>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">No recent playback.</p>}
            {history.length > HISTORY_PREVIEW_SIZE && <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={historyExpanded} aria-controls="movie-playback-list" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? "Show fewer" : `Show all ${history.length}`}</Button>}
          </section>

          <section className="flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="reset-heading">
            <div>
              <h2 id="reset-heading" className="text-base font-semibold">Reset movie rotation</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Return every approved movie to the remaining rotation without interrupting the Current Programme.</p>
            </div>
            <Button type="button" variant="outline" className="shrink-0 max-sm:w-full" disabled={resetting || !state.current} onClick={() => setConfirmingReset(true)}>Reset rotation</Button>
          </section>

          <p className={mutationFailed ? "rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" : "min-h-5 text-sm font-medium text-accent"} role={mutationFailed ? "alert" : "status"} aria-live="polite">{mutationStatus}</p>
        </>
      )}

      <ResetConfirmationDialog open={confirmingReset} pending={resetting} error={mutationFailed ? mutationStatus : ""} onOpenChange={setConfirmingReset} onConfirm={resetRotation} />
    </section>
  );
}

function ChannelSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-live="polite" aria-busy="true" aria-label="Loading Movie Channel">
      <Skeleton className="h-48" />
      <Skeleton className="h-96" />
      <span className="sr-only">Loading Movie Channel…</span>
    </div>
  );
}

function ResetConfirmationDialog({ open, pending, error, onOpenChange, onConfirm }: { open: boolean; pending: boolean; error: string; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  return (
    <Dialog modal={false} open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="data-closed:hidden" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Reset movie rotation?</DialogTitle>
          <DialogDescription>Every approved movie will return to the remaining rotation. The Current Programme will not be interrupted.</DialogDescription>
        </DialogHeader>
        {error && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => { void onConfirm().then(() => onOpenChange(false)).catch(() => undefined); }}>{pending ? "Resetting…" : "Reset rotation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
