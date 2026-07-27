import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type KeyboardEvent } from "react";
import { DestinationPage } from "../components/DestinationPage";
import { LegacyParentWorkflows } from "../components/LegacyParentWorkflows";
import { Button } from "../components/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/approved-library")({ component: ApprovedLibraryPage });

type ProgrammeType = "show" | "movie";
type LibraryState = "all" | "current" | "paused" | "finished";
type EpisodeSummary = { id: string; season: number; episode: number; title: string; released: string };
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
  pausedAt?: string;
  current: boolean;
  finished: boolean;
  showProgress?: EpisodeSummary;
};
type LibraryResponse = { programmes: ProgrammeSummary[] };

function ApprovedLibraryPage() {
  const { secret } = Route.useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ProgrammeType>("show");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<LibraryState>("all");
  const [removeTarget, setRemoveTarget] = useState<ProgrammeSummary | null>(null);
  const [status, setStatus] = useState("");

  const library = useQuery({
    queryKey: parentKeys.library(secret),
    queryFn: () => parentApi<LibraryResponse>(`/api/households/${secret}/library`),
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
        || (state === "paused" && Boolean(programme.pausedAt))
        || (state === "finished" && programme.finished)));
  }, [programmes, search, state, tab]);

  const removal = useMutation({
    mutationFn: (programme: ProgrammeSummary) => parentApi<{ message: string }>(
      `/api/households/${secret}/library/${encodeURIComponent(programme.id)}`,
      { method: "DELETE" },
    ),
    onSuccess: async (result) => {
      setRemoveTarget(null);
      setStatus(result.message);
      window.dispatchEvent(new Event("stremio-restart-required"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.movie(secret) }),
      ]);
    },
  });

  function selectTab(next: ProgrammeType) {
    setTab(next);
    setState("all");
  }

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: ProgrammeType) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: ProgrammeType[] = ["show", "movie"];
    const currentIndex = tabs.indexOf(current);
    const next = event.key === "Home"
      ? tabs[0]
      : event.key === "End"
        ? tabs[tabs.length - 1]
        : tabs[(currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    selectTab(next);
    document.getElementById(`library-tab-${next}`)?.focus();
  }

  return <div className="approved-library-page">
    <DestinationPage eyebrow="Household" title="Approved Library" description="Browse the shows and movies available to your Channels." />

    {library.isPending ? <LibrarySkeleton /> : library.isError ? <section className="card library-error" role="alert">
      <h2>Approved Library unavailable</h2>
      <p>{apiErrorMessage(library.error, "The Approved Library could not be loaded. Try again.")}</p>
      <Button type="button" className="button-secondary" onClick={() => void library.refetch()}>Try again</Button>
    </section> : <>
      <div className="library-tabs" role="tablist" aria-label="Programme type">
        <button id="library-tab-show" type="button" role="tab" tabIndex={tab === "show" ? 0 : -1} aria-selected={tab === "show"} aria-controls="library-results" onKeyDown={(event) => tabKeyDown(event, "show")} onClick={() => selectTab("show")}>Shows <span>{counts.show}</span></button>
        <button id="library-tab-movie" type="button" role="tab" tabIndex={tab === "movie" ? 0 : -1} aria-selected={tab === "movie"} aria-controls="library-results" onKeyDown={(event) => tabKeyDown(event, "movie")} onClick={() => selectTab("movie")}>Movies <span>{counts.movie}</span></button>
      </div>

      <section className="library-filters" aria-label={`${tab === "show" ? "Show" : "Movie"} filters`}>
        <div><label htmlFor="library-search">Search {tab === "show" ? "shows" : "movies"}</label>
          <input id="library-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" /></div>
        <div><label htmlFor="library-state">State</label>
          <select id="library-state" value={state} onChange={(event) => setState(event.target.value as LibraryState)}>
            <option value="all">All states</option>
            <option value="current">Current</option>
            {tab === "show" && <option value="paused">Paused</option>}
            {tab === "show" && <option value="finished">Finished</option>}
          </select></div>
      </section>

      <p className="library-result-count" role="status">{visible.length} {visible.length === 1 ? "programme" : "programmes"} shown</p>
      <p className="sr-status" role="status">{status}</p>
      <div id="library-results" role="tabpanel" aria-labelledby={`library-tab-${tab}`} className="library-card-grid" aria-busy={removal.isPending || undefined}>
        {visible.map((programme) => <ProgrammeCard key={programme.id} programme={programme} onRemove={setRemoveTarget} />)}
      </div>
      {!visible.length && <LibraryEmpty hasProgrammes={counts[tab] > 0} secret={secret} />}
    </>}

    <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open && !removal.isPending) setRemoveTarget(null); }}>
      <DialogContent showCloseButton={!removal.isPending}>
        <DialogHeader>
          <DialogTitle>Remove {removeTarget?.title}?</DialogTitle>
          <DialogDescription>This removes “{removeTarget?.title}” from the Approved Library and future Movie Channel selections. Current playback is not interrupted.</DialogDescription>
        </DialogHeader>
        {removal.isError && <p className="inline-error" role="alert">{apiErrorMessage(removal.error, "The movie could not be removed. Try again.")}</p>}
        <DialogFooter>
          <DialogClose asChild><Button type="button" className="button-secondary" disabled={removal.isPending}>Cancel</Button></DialogClose>
          <Button type="button" disabled={removal.isPending || !removeTarget} onClick={() => removeTarget && removal.mutate(removeTarget)}>
            {removal.isPending ? "Removing…" : "Remove movie"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <LegacyParentWorkflows secret={secret} surface="show-management-and-deletion" />
  </div>;
}

function ProgrammeCard({ programme, onRemove }: { programme: ProgrammeSummary; onRemove: (programme: ProgrammeSummary) => void }) {
  const metadata = [programme.releaseInfo, programme.genres.slice(0, 2).join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean);
  return <article className="library-programme-card">
    <div className="library-poster">
      <span aria-hidden="true">{programme.type === "show" ? "Show" : "Movie"}</span>
      {programme.poster && <img src={programme.poster} alt={`${programme.title} poster`} onError={(event) => { event.currentTarget.hidden = true; }} />}
    </div>
    <div className="library-programme-copy">
      <p className="eyebrow">{programme.type === "show" ? "Show" : "Movie"}</p>
      <h2>{programme.title}</h2>
      {metadata.length > 0 && <p className="library-metadata">{metadata.join(" · ")}</p>}
      <div className="library-badges" aria-label="Programme state">
        {programme.current && <span className="state-badge">Current</span>}
        {programme.pausedAt && <span className="state-badge">Paused</span>}
        {programme.finished && <span className="state-badge">Finished</span>}
      </div>
      {programme.type === "show" && programme.showProgress && <p className="progress-summary">Show Progress: S{String(programme.showProgress.season).padStart(2, "0")}E{String(programme.showProgress.episode).padStart(2, "0")} · {programme.showProgress.title}</p>}
      {programme.type === "movie" && <Button type="button" className="button-secondary compact-button" onClick={() => onRemove(programme)}>Remove movie</Button>}
    </div>
  </article>;
}

function LibraryEmpty({ hasProgrammes, secret }: { hasProgrammes: boolean; secret: string }) {
  return <section className="card library-empty">
    <h2>{hasProgrammes ? "No programmes match these filters" : "No programmes approved yet"}</h2>
    <p>{hasProgrammes ? "Clear or change the filters to see more of your Approved Library." : "Search Cinemeta and approve a programme to begin building this Channel."}</p>
    <Link className="button" to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
  </section>;
}

function LibrarySkeleton() {
  return <div className="library-skeleton" aria-busy="true" aria-label="Loading Approved Library">
    <span className="sr-only">Loading Approved Library…</span>
    <div className="skeleton-block skeleton-tabs" /><div className="skeleton-block skeleton-filters" />
    <div className="library-card-grid"><div className="skeleton-block skeleton-library-card" /><div className="skeleton-block skeleton-library-card" /></div>
  </div>;
}
