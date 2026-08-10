import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { EpisodeSelector, type SelectableEpisode } from "../components/EpisodeSelector";
import { Ident } from "../components/Ident";
import { PageHeader } from "../components/PageHeader";
import { StateBadge } from "../components/StateBadge";
import { TypeTabs } from "../components/TypeTabs";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Skeleton } from "../components/ui/skeleton";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";
import { useChannels } from "../lib/channels";

export const Route = createFileRoute("/households/$secret/approved-library")({ component: ApprovedLibraryPage });

type ProgrammeType = "show" | "movie";
type LibraryState = "all" | "current" | "paused" | "finished";
type EpisodeSummary = SelectableEpisode;
type ProgrammeAssignment = {
  channelId: string;
  channelName: string;
  channelType: "tv" | "movie";
  pausedAt?: string;
  current: boolean;
  finished: boolean;
  showProgress?: EpisodeSummary;
};
type ProgrammeSummary = {
  id: string;
  imdbId: string;
  type: ProgrammeType;
  title: string;
  poster?: string;
  releaseInfo?: string;
  genres: string[];
  imdbRating?: string;
  approvedAt: string;
  current: boolean;
  finished: boolean;
  assignments: ProgrammeAssignment[];
};
type LibraryResponse = { programmes: ProgrammeSummary[] };
type ProgrammeDetailResponse = { programme: ProgrammeSummary & { episodes: EpisodeSummary[] } };

function ApprovedLibraryPage() {
  const { secret } = Route.useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ProgrammeType>("show");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<LibraryState>("all");
  const [removeTarget, setRemoveTarget] = useState<ProgrammeSummary | null>(null);
  const [progressTarget, setProgressTarget] = useState<ProgrammeSummary | null>(null);
  const [progressChannelId, setProgressChannelId] = useState<string | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<ProgrammeSummary | null>(null);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const channels = useChannels(secret);

  const library = useQuery({
    queryKey: parentKeys.library(secret),
    queryFn: () => parentApi<LibraryResponse>(`/api/households/${secret}/library`),
  });
  const detail = useQuery({
    queryKey: parentKeys.libraryProgramme(secret, progressTarget?.id),
    queryFn: () => parentApi<ProgrammeDetailResponse>(`/api/households/${secret}/library/${encodeURIComponent(progressTarget!.id)}`),
    enabled: Boolean(progressTarget),
  });
  const programmes = library.data?.programmes ?? [];
  const counts = {
    show: programmes.filter((programme) => programme.type === "show").length,
    movie: programmes.filter((programme) => programme.type === "movie").length,
  };
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return programmes.filter((programme) => programme.type === tab
      && (!query || programme.title.toLocaleLowerCase().includes(query))
      && (state === "all" || (state === "current" && programme.current)
        || (state === "paused" && programme.assignments.some((assignment) => Boolean(assignment.pausedAt)))
        || (state === "finished" && programme.assignments.some((assignment) => assignment.finished))));
  }, [programmes, search, state, tab]);

  async function refreshShowState() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.tvChannels(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.tvPreparations(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.movieChannels(secret) }),
    ]);
  }

  const showEligibility = useMutation({
    mutationFn: ({ programme, assignment }: { programme: ProgrammeSummary; assignment: ProgrammeAssignment }) => parentApi<{ message: string }>(
      `/api/households/${secret}/library/${encodeURIComponent(programme.id)}`,
      { method: "PATCH", body: { paused: !assignment.pausedAt, channelId: assignment.channelId } },
    ),
    onSuccess: async (_, { programme, assignment }) => {
      setStatus(assignment.pausedAt
        ? `${programme.title} resumed on ${assignment.channelName} with Show Progress unchanged.`
        : `${programme.title} paused on ${assignment.channelName} with Show Progress unchanged.`);
      window.dispatchEvent(new Event("stremio-restart-required"));
      await refreshShowState();
    },
  });

  const correction = useMutation({
    mutationFn: ({ programme, videoId, channelId }: { programme: ProgrammeSummary; videoId: string; channelId: string }) => parentApi<{ message: string }>(
      `/api/households/${secret}/library/${encodeURIComponent(programme.id)}/progress`,
      { method: "PATCH", body: { videoId, channelId } },
    ),
    onSuccess: async (_, { programme }) => {
      setStatus(programme.finished
        ? `${programme.title} restarted. Future TV selections repaired.`
        : `${programme.title} Show Progress corrected. Future TV selections repaired.`);
      setProgressTarget(null);
      window.dispatchEvent(new Event("stremio-restart-required"));
      await refreshShowState();
    },
  });

  const removal = useMutation({
    mutationFn: (programme: ProgrammeSummary) => parentApi<{ message: string }>(
      `/api/households/${secret}/library/${encodeURIComponent(programme.id)}`,
      { method: "DELETE" },
    ),
    onSuccess: async (_, programme) => {
      setRemoveTarget(null);
      setStatus(`${programme.title} removed from the Approved Library.`);
      window.dispatchEvent(new Event("stremio-restart-required"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
        queryClient.invalidateQueries({
          queryKey: programme.type === "show" ? parentKeys.tvChannels(secret) : parentKeys.movieChannels(secret),
        }),
      ]);
    },
  });

  const assignments = useMutation({
    mutationFn: ({ programme, channelIds }: { programme: ProgrammeSummary; channelIds: string[] }) => parentApi<{ message: string }>(
      `/api/households/${secret}/library/${encodeURIComponent(programme.id)}/assignments`,
      { method: "PUT", body: { channelIds } },
    ),
    onSuccess: async (_, { programme }) => {
      setAssignmentTarget(null);
      setStatus(`${programme.title} Channel Assignments updated.`);
      window.dispatchEvent(new Event("stremio-restart-required"));
      await refreshShowState();
    },
  });

  function selectTab(next: ProgrammeType) {
    setTab(next);
    setState("all");
  }

  function openProgress(programme: ProgrammeSummary, assignment: ProgrammeAssignment) {
    correction.reset();
    setSelectedEpisodeId(null);
    setProgressChannelId(assignment.channelId);
    setProgressTarget(programme);
  }

  const actionError = showEligibility.isError
    ? apiErrorMessage(showEligibility.error, "The show could not be updated. Try again.")
    : "";
  const progressAssignment = progressTarget?.assignments.find((assignment) => assignment.channelId === progressChannelId);

  return (
    <div className="grid gap-6">
      <PageHeader ident="Household" title="Approved Library" description="Browse the shows and movies available to your Channels." />

      {library.isPending ? <LibrarySkeleton /> : library.isError ? (
        <section className="rounded-[4px] border bg-card p-5" role="alert">
          <h2 className="text-lg font-semibold">Approved Library unavailable</h2>
          <p className="mt-1 text-sm text-muted-foreground">{apiErrorMessage(library.error, "The Approved Library could not be loaded. Try again.")}</p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void library.refetch()}>Try again</Button>
        </section>
      ) : (
        <>
          <TypeTabs idPrefix="library-tab" controls="library-results" ariaLabel="Programme type" tab={tab} counts={counts} onSelect={selectTab} />

          <section className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.35fr)]" aria-label={`${tab === "show" ? "Show" : "Movie"} filters`}>
            <div>
              <label htmlFor="library-search" className="mb-1.5 block text-sm font-semibold">Search {tab === "show" ? "shows" : "movies"}</label>
              <Input id="library-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" />
            </div>
            <div>
              <label htmlFor="library-state" className="mb-1.5 block text-sm font-semibold">State</label>
              <NativeSelect id="library-state" value={state} onChange={(event) => setState(event.target.value as LibraryState)}>
                <option value="all">All states</option>
                <option value="current">Current</option>
                {tab === "show" && <option value="paused">Paused</option>}
                {tab === "show" && <option value="finished">Finished</option>}
              </NativeSelect>
            </div>
          </section>

          <p className="text-sm text-muted-foreground" role="status">{visible.length} {visible.length === 1 ? "programme" : "programmes"} shown</p>
          <p className="min-h-5 text-sm font-medium text-accent" role="status">{status}</p>
          {actionError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">{actionError}</p>}
          <div id="library-results" role="tabpanel" aria-labelledby={`library-tab-${tab}`} className="grid gap-4 lg:grid-cols-2" aria-busy={showEligibility.isPending || removal.isPending || undefined}>
            {visible.map((programme) => <ProgrammeCard
              key={programme.id}
              programme={programme}
              pending={showEligibility.isPending && showEligibility.variables?.programme.id === programme.id}
              onEligibility={(target, assignment) => { showEligibility.reset(); showEligibility.mutate({ programme: target, assignment }); }}
              onProgress={openProgress}
              onAssignments={(target) => {
                assignments.reset();
                setSelectedChannelIds(target.assignments.map((assignment) => assignment.channelId));
                setAssignmentTarget(target);
              }}
              onRemove={(target) => { removal.reset(); setRemoveTarget(target); }}
            />)}
          </div>
          {!visible.length && <LibraryEmpty hasProgrammes={counts[tab] > 0} secret={secret} />}
        </>
      )}

      <Dialog open={Boolean(progressTarget)} onOpenChange={(open) => { if (!open && !correction.isPending) setProgressTarget(null); }}>
        <DialogContent className="sm:max-w-lg" showCloseButton={!correction.isPending}>
          <DialogHeader>
            <Ident>Show Progress</Ident>
            <DialogTitle>{progressAssignment?.finished ? `Restart ${progressTarget?.title}` : `Correct ${progressTarget?.title}`}</DialogTitle>
            <DialogDescription>Choose the next episode the TV Channel should schedule. The Current Programme and active playback are not interrupted.</DialogDescription>
          </DialogHeader>
          {detail.isFetching && <p className="text-sm text-muted-foreground" role="status">Loading released episodes…</p>}
          {detail.isError && (
            <div role="alert">
              <p className="text-sm text-destructive">{apiErrorMessage(detail.error, "Released episodes could not be loaded. Try again.")}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void detail.refetch()}>Try loading episodes again</Button>
            </div>
          )}
          {detail.isSuccess && detail.data.programme.episodes.length > 0 && <EpisodeSelector
            key={`${progressTarget?.id}:${progressChannelId}:${detail.data.programme.assignments.find((assignment) => assignment.channelId === progressChannelId)?.showProgress?.id ?? "restart"}`}
            episodes={detail.data.programme.episodes}
            programmeTitle={detail.data.programme.title}
            initialEpisodeId={detail.data.programme.assignments.find((assignment) => assignment.channelId === progressChannelId)?.showProgress?.id}
            legend={progressAssignment?.finished ? "Choose restart Show Progress" : "Choose corrected Show Progress"}
            helpText={progressAssignment?.finished
              ? `Restart ${detail.data.programme.title} from S01E01, or choose another released episode.`
              : `The current Show Progress is selected. Choose a season, then a released episode.`}
            disabled={correction.isPending}
            onSelectionChange={setSelectedEpisodeId}
          />}
          {detail.isSuccess && detail.data.programme.episodes.length === 0 && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">No regular released episodes are available.</p>}
          {correction.isError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">{apiErrorMessage(correction.error, "Show Progress could not be corrected. Try again.")}</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={correction.isPending}>Cancel</Button></DialogClose>
            <Button type="button" disabled={correction.isPending || !progressTarget || !progressChannelId || !selectedEpisodeId || !detail.isSuccess} onClick={() => progressTarget && progressChannelId && selectedEpisodeId && correction.mutate({ programme: progressTarget, channelId: progressChannelId, videoId: selectedEpisodeId })}>
              {correction.isPending ? "Saving…" : progressAssignment?.finished ? "Restart show" : "Save Show Progress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open && !removal.isPending) setRemoveTarget(null); }}>
        <DialogContent showCloseButton={!removal.isPending}>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.title}?</DialogTitle>
            <DialogDescription>This removes “{removeTarget?.title}” from the Approved Library and future {removeTarget?.type === "show" ? "TV" : "Movie"} Channel selections. Current playback is not interrupted.</DialogDescription>
          </DialogHeader>
          {removal.isError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">{apiErrorMessage(removal.error, `The ${removeTarget?.type ?? "programme"} could not be removed. Try again.`)}</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={removal.isPending}>Cancel</Button></DialogClose>
            <Button type="button" disabled={removal.isPending || !removeTarget} onClick={() => removeTarget && removal.mutate(removeTarget)}>
              {removal.isPending ? "Removing…" : `Remove ${removeTarget?.type ?? "programme"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(assignmentTarget)} onOpenChange={(open) => { if (!open && !assignments.isPending) setAssignmentTarget(null); }}>
        <DialogContent showCloseButton={!assignments.isPending}>
          <DialogHeader>
            <DialogTitle>Assign {assignmentTarget?.title} to Channels</DialogTitle>
            <DialogDescription>Each assignment keeps its own progress and playback state. Saving with none selected removes the programme from the Approved Library.</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2 rounded-[4px] border p-4">
            <legend className="px-1 text-sm font-semibold">Channels</legend>
            {(channels.data ?? []).filter((channel) => channel.type === (assignmentTarget?.type === "show" ? "tv" : "movie")).map((channel) => (
              <label key={channel.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedChannelIds.includes(channel.id)}
                  disabled={assignments.isPending}
                  onChange={(event) => setSelectedChannelIds(event.target.checked
                    ? [...selectedChannelIds, channel.id]
                    : selectedChannelIds.filter((channelId) => channelId !== channel.id))}
                />
                {channel.name}
              </label>
            ))}
          </fieldset>
          {assignments.isError && <p className="text-sm text-destructive" role="alert">{apiErrorMessage(assignments.error, "Channel Assignments could not be updated.")}</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={assignments.isPending}>Cancel</Button></DialogClose>
            <Button type="button" disabled={!assignmentTarget || assignments.isPending} onClick={() => assignmentTarget && assignments.mutate({ programme: assignmentTarget, channelIds: selectedChannelIds })}>
              {assignments.isPending ? "Saving…" : selectedChannelIds.length === 0 ? "Remove from Library" : "Save Assignments"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProgrammeCard({
  programme,
  pending,
  onEligibility,
  onProgress,
  onAssignments,
  onRemove,
}: {
  programme: ProgrammeSummary;
  pending: boolean;
  onEligibility: (programme: ProgrammeSummary, assignment: ProgrammeAssignment) => void;
  onProgress: (programme: ProgrammeSummary, assignment: ProgrammeAssignment) => void;
  onAssignments: (programme: ProgrammeSummary) => void;
  onRemove: (programme: ProgrammeSummary) => void;
}) {
  const metadata = [programme.releaseInfo, programme.genres.slice(0, 2).join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean);
  return (
    <article className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-4 rounded-[4px] border bg-card p-4 max-[380px]:grid-cols-[4.5rem_minmax(0,1fr)]">
      <div data-slot="library-poster" className="relative grid h-36 w-24 place-items-center overflow-hidden rounded-[3px] bg-muted text-[0.7rem] font-bold text-muted-foreground uppercase max-[380px]:h-27 max-[380px]:w-18">
        <span aria-hidden="true">{programme.type === "show" ? "Show" : "Movie"}</span>
        {programme.poster && <img src={programme.poster} alt={`${programme.title} poster`} className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.hidden = true; }} />}
      </div>
      <div className="min-w-0">
        <h2 className="text-base leading-snug font-semibold break-words">{programme.title}</h2>
        {metadata.length > 0 && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{metadata.join(" · ")}</p>}
        <div className="mt-2 flex min-h-6 flex-wrap gap-1.5" aria-label="Programme state">
          {programme.type === "movie" && programme.current && <StateBadge current>Current</StateBadge>}
        </div>
        {programme.type === "movie" && <p className="mt-1.5 text-sm text-muted-foreground">Channels: {programme.assignments.map((assignment) => assignment.channelName).join(", ")}</p>}
        {programme.type === "show" && <div className="mt-2 grid gap-2">
          {programme.assignments.map((assignment) => (
            <div key={assignment.channelId} className="rounded-[3px] border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="mr-auto">{assignment.channelName}</strong>
                {assignment.current && <StateBadge current>Current</StateBadge>}
                {assignment.pausedAt && <StateBadge>Paused</StateBadge>}
                {assignment.finished && <StateBadge>Finished</StateBadge>}
              </div>
              {assignment.showProgress && <p className="mt-1 text-muted-foreground">Show Progress: <span className="font-mono text-xs">S{String(assignment.showProgress.season).padStart(2, "0")}E{String(assignment.showProgress.episode).padStart(2, "0")}</span> · {assignment.showProgress.title}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onEligibility(programme, assignment)}>{pending ? (assignment.pausedAt ? "Resuming…" : "Pausing…") : assignment.pausedAt ? "Resume show" : "Pause show"}</Button>
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onProgress(programme, assignment)}>{assignment.finished ? "Restart show" : "Correct Show Progress"}</Button>
              </div>
            </div>
          ))}
        </div>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onAssignments(programme)}>Manage Channels</Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onRemove(programme)}>Remove {programme.type}</Button>
        </div>
      </div>
    </article>
  );
}

function LibraryEmpty({ hasProgrammes, secret }: { hasProgrammes: boolean; secret: string }) {
  return (
    <section className="rounded-[4px] border bg-card p-5">
      <h2 className="text-lg font-semibold">{hasProgrammes ? "No programmes match these filters" : "No programmes approved yet"}</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{hasProgrammes ? "Clear or change the filters to see more of your Approved Library." : "Search Cinemeta and approve a programme to begin building this Channel."}</p>
      <Link className={buttonVariants({ className: "mt-4" })} to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
    </section>
  );
}

function LibrarySkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading Approved Library">
      <span className="sr-only">Loading Approved Library…</span>
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-16" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}
