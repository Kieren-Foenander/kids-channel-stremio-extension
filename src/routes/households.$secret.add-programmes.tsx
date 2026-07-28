import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { EpisodeSelector, type SelectableEpisode } from "../components/EpisodeSelector";
import { Ident } from "../components/Ident";
import { PageHeader } from "../components/PageHeader";
import { StateBadge } from "../components/StateBadge";
import { TypeTabs } from "../components/TypeTabs";
import { Button } from "../components/ui/button";
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
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

type ProgrammeType = "show" | "movie";
type SearchState = { q?: string; type?: ProgrammeType; page?: number };
type SearchProgramme = {
  id: string;
  type: ProgrammeType;
  title: string;
  description?: string;
  poster?: string;
  releaseInfo?: string;
  genres: string[];
  imdbRating?: string;
};
type ProgrammeSummary = { imdbId: string; type: ProgrammeType };
type SearchResponse = { results: SearchProgramme[] };
type LibraryResponse = { programmes: ProgrammeSummary[] };
type ShowDetailResponse = { title: SearchProgramme & { type: "show"; episodes: SelectableEpisode[] } };
type ApprovalInput = { programme: SearchProgramme; startingEpisodeId?: string };

const PAGE_SIZE = 12;

export const Route = createFileRoute("/households/$secret/add-programmes")({
  validateSearch: (search: Record<string, unknown>): SearchState => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    type: search.type === "movie" ? "movie" : search.type === "show" ? "show" : undefined,
    page: positiveInteger(search.page),
  }),
  component: AddProgrammesPage,
});

function positiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function AddProgrammesPage() {
  const { secret } = Route.useParams();
  const searchState = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const query = searchState.q?.trim() ?? "";
  const tab = searchState.type ?? "show";
  const page = searchState.page ?? 1;
  const [input, setInput] = useState(searchState.q ?? "");
  const [inputError, setInputError] = useState("");
  const [detail, setDetail] = useState<SearchProgramme | null>(null);
  const [startingEpisodeId, setStartingEpisodeId] = useState<string | null>(null);

  useEffect(() => setInput(searchState.q ?? ""), [searchState.q]);

  const results = useQuery({
    queryKey: ["household", secret, "cinemeta-search", query],
    queryFn: () => parentApi<SearchResponse>(`/api/households/${secret}/cinemeta/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2 && query.length <= 100,
    retry: false,
  });
  const library = useQuery({
    queryKey: parentKeys.library(secret),
    queryFn: () => parentApi<LibraryResponse>(`/api/households/${secret}/library`),
  });
  const programmes = results.data?.results ?? [];
  const typedResults = programmes.filter((programme) => programme.type === tab);
  const counts = {
    show: programmes.filter((programme) => programme.type === "show").length,
    movie: programmes.filter((programme) => programme.type === "movie").length,
  };
  const pageCount = Math.max(1, Math.ceil(typedResults.length / PAGE_SIZE));
  const visible = typedResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const approved = useMemo(() => new Set((library.data?.programmes ?? []).map((programme) => `${programme.type}:${programme.imdbId}`)), [library.data]);
  const showDetail = useQuery({
    queryKey: ["household", secret, "cinemeta-title", "show", detail?.type === "show" ? detail.id : ""],
    queryFn: () => parentApi<ShowDetailResponse>(`/api/households/${secret}/cinemeta/title/show/${detail!.id}`),
    enabled: detail?.type === "show" && !approved.has(`show:${detail.id}`),
    retry: false,
  });

  const approval = useMutation({
    mutationFn: ({ programme, startingEpisodeId: selectedEpisode }: ApprovalInput) => parentApi<{ programme: unknown }>(`/api/households/${secret}/library`, {
      method: "POST",
      body: { type: programme.type, imdbId: programme.id, ...(selectedEpisode ? { startingEpisodeId: selectedEpisode } : {}) },
    }),
    onSuccess: async () => {
      window.dispatchEvent(new Event("stremio-restart-required"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.movie(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.tv(secret) }),
      ]);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = input.trim();
    if (submitted.length < 2 || submitted.length > 100) {
      setInputError("Search must contain between 2 and 100 characters.");
      return;
    }
    setInputError("");
    approval.reset();
    void navigate({ search: { q: submitted, type: tab, page: 1 } });
  }

  function selectTab(next: ProgrammeType) {
    approval.reset();
    void navigate({ search: query ? { q: query, type: next, page: 1 } : { type: next, page: 1 } });
  }

  function changePage(next: number) {
    void navigate({ search: { q: query, type: tab, page: next } });
  }

  function openDetails(programme: SearchProgramme) {
    approval.reset();
    setStartingEpisodeId(null);
    setDetail(programme);
  }

  const selectStartingEpisode = useCallback((episodeId: string | null) => {
    setStartingEpisodeId(episodeId);
  }, []);

  const invalidRestoredQuery = Boolean(query) && (query.length < 2 || query.length > 100);
  return (
    <div className="grid gap-8">
      <PageHeader ident="Approved Library" title="Add Programmes" description="Search Cinemeta, review a programme, then approve it for your Channels." />

      <section aria-labelledby="cinemeta-search-heading">
        <h2 id="cinemeta-search-heading" className="text-xl font-semibold tracking-[-0.01em]">Search Cinemeta</h2>
        <form className="mt-4 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submit} noValidate>
          <div>
            <label htmlFor="programme-search" className="text-sm font-semibold">Search Cinemeta for shows and movies</label>
            <Input id="programme-search" type="search" minLength={2} maxLength={100} required value={input} aria-invalid={Boolean(inputError)} aria-describedby={inputError ? "programme-search-error" : undefined} onChange={(event) => { setInput(event.target.value); setInputError(""); }} placeholder="Bluey, Paddington…" className="mt-2 h-11" />
            {inputError && <p id="programme-search-error" className="mt-1.5 text-sm font-medium text-destructive" role="alert">{inputError}</p>}
          </div>
          <Button type="submit" className="h-11 max-sm:w-full">Search</Button>
        </form>
      </section>

      {invalidRestoredQuery && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">Search must contain between 2 and 100 characters.</p>}
      {results.isFetching && <p className="text-sm text-muted-foreground" role="status">Searching Cinemeta…</p>}
      {results.isError && (
        <section className="rounded-[4px] border bg-card p-5" role="alert">
          <h2 className="text-lg font-semibold">Search unavailable</h2>
          <p className="mt-1 text-sm text-muted-foreground">{apiErrorMessage(results.error, "Cinemeta search is temporarily unavailable. Try again.")}</p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void results.refetch()}>Try again</Button>
        </section>
      )}

      {results.isSuccess && (
        <section className="grid gap-5" aria-labelledby="search-results-heading">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="search-results-heading" className="text-xl font-semibold tracking-[-0.01em]">Results for “{query}”</h2>
            <p className="font-mono text-xs font-medium text-muted-foreground">{programmes.length} total</p>
          </div>
          <TypeTabs idPrefix="search-tab" controls="search-result-grid" ariaLabel="Search result type" tab={tab} counts={counts} onSelect={selectTab} />
          {page > pageCount ? (
            <div className="rounded-[4px] border bg-card p-5">
              <h3 className="text-base font-semibold">That result page is unavailable</h3>
              <Button type="button" variant="outline" className="mt-4" onClick={() => changePage(pageCount)}>Go to page {pageCount}</Button>
            </div>
          ) : typedResults.length === 0 ? (
            <div className="rounded-[4px] border bg-card p-5">
              <h3 className="text-base font-semibold">No matching {tab === "show" ? "shows" : "movies"}</h3>
              <p className="mt-1 text-sm text-muted-foreground">Try the other result tab or search for another title.</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground" role="status">Showing {visible.length} of {typedResults.length} {tab === "show" ? "shows" : "movies"}, page {page} of {pageCount}</p>
              <div id="search-result-grid" role="tabpanel" aria-labelledby={`search-tab-${tab}`} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((programme) => <SearchCard key={`${programme.type}:${programme.id}`} programme={programme} isApproved={approved.has(`${programme.type}:${programme.id}`)} onDetails={openDetails} />)}
              </div>
              {pageCount > 1 && (
                <nav className="flex items-center justify-center gap-4 max-sm:justify-between" aria-label="Search result pages">
                  <Button type="button" variant="outline" disabled={page <= 1} onClick={() => changePage(page - 1)}>Previous</Button>
                  <span className="font-mono text-xs font-medium">Page {page} of {pageCount}</span>
                  <Button type="button" variant="outline" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>Next</Button>
                </nav>
              )}
            </>
          )}
        </section>
      )}

      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open && !approval.isPending) { setDetail(null); approval.reset(); } }}>
        <DialogContent className="sm:max-w-lg" showCloseButton={!approval.isPending}>
          <DialogHeader>
            <Ident>{detail?.type === "show" ? "Show" : "Movie"}</Ident>
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription asChild><div>
              {detail && <ProgrammeMetadata programme={detail} />}
              <p className="mt-2 max-h-[min(40vh,18rem)] overflow-y-auto leading-relaxed text-popover-foreground">{detail?.description || "No description is available."}</p>
            </div></DialogDescription>
          </DialogHeader>
          {detail?.type === "show" && !approved.has(`show:${detail.id}`) && <ShowEpisodeChoice
            key={detail.id}
            query={showDetail}
            programmeTitle={detail.title}
            disabled={approval.isPending || approval.isSuccess}
            onSelectionChange={selectStartingEpisode}
          />}
          {detail?.type === "show" && approved.has(`show:${detail.id}`) && !approval.isSuccess && <p className="text-sm font-medium text-accent" role="status">This show is already in the Approved Library.</p>}
          {approval.isError && <p className="rounded-[4px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">{apiErrorMessage(approval.error, "The programme could not be approved. Try again.")}</p>}
          {approval.isSuccess && <p className="text-sm font-medium text-accent" role="status">Added to the Approved Library.</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={approval.isPending}>Close</Button></DialogClose>
            {detail?.type === "movie" && <Button type="button" disabled={approval.isPending || approval.isSuccess || approved.has(`movie:${detail.id}`)} onClick={() => approval.mutate({ programme: detail })}>
              {approval.isPending ? "Approving…" : approval.isSuccess || approved.has(`movie:${detail.id}`) ? "Already approved" : "Approve movie"}
            </Button>}
            {detail?.type === "show" && <Button
              type="button"
              disabled={approval.isPending || approval.isSuccess || approved.has(`show:${detail.id}`) || !startingEpisodeId || !showDetail.isSuccess}
              onClick={() => approval.mutate({ programme: detail, startingEpisodeId: startingEpisodeId ?? undefined })}
            >
              {approval.isPending ? "Approving…" : approval.isSuccess || approved.has(`show:${detail.id}`) ? "Already approved" : "Approve show"}
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ShowEpisodeChoice({
  query,
  programmeTitle,
  disabled,
  onSelectionChange,
}: {
  query: {
    data?: ShowDetailResponse;
    error: unknown;
    isFetching: boolean;
    isError: boolean;
    isSuccess: boolean;
    refetch: () => Promise<unknown>;
  };
  programmeTitle: string;
  disabled: boolean;
  onSelectionChange: (episodeId: string | null) => void;
}) {
  if (query.isFetching) return <p className="text-sm text-muted-foreground" role="status">Loading released episodes…</p>;
  if (query.isError) return (
    <div role="alert">
      <p className="text-sm text-destructive">{apiErrorMessage(query.error, "Released episodes are temporarily unavailable. Try again.")}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>Try loading episodes again</Button>
    </div>
  );
  if (!query.isSuccess) return null;
  const episodes = query.data?.title.episodes ?? [];
  if (episodes.length === 0) return <p className="text-sm text-destructive" role="alert">This show has no regular released episodes available to approve.</p>;
  return <EpisodeSelector episodes={episodes} programmeTitle={programmeTitle} disabled={disabled} onSelectionChange={onSelectionChange} />;
}

function SearchCard({ programme, isApproved, onDetails }: { programme: SearchProgramme; isApproved: boolean; onDetails: (programme: SearchProgramme) => void }) {
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-[4px] border bg-card">
      <div className="relative grid aspect-[2/3] w-full place-items-center overflow-hidden bg-muted text-xs font-bold text-muted-foreground uppercase">
        <span aria-hidden="true">{programme.type === "show" ? "Show" : "Movie"}</span>
        {programme.poster && <img src={programme.poster} alt={`${programme.title} poster`} className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.hidden = true; }} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 p-3">
        <h3 className="text-sm leading-snug font-semibold break-words">{programme.title}</h3>
        <ProgrammeMetadata programme={programme} />
        {isApproved && <StateBadge>Already approved</StateBadge>}
        <Button type="button" variant="outline" size="sm" className="mt-auto w-full" onClick={() => onDetails(programme)}>View details<span className="sr-only"> for {programme.title}</span></Button>
      </div>
    </article>
  );
}

function ProgrammeMetadata({ programme }: { programme: SearchProgramme }) {
  const metadata = [programme.releaseInfo, programme.genres.slice(0, 2).join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean);
  return metadata.length ? <p className="text-xs leading-relaxed text-muted-foreground">{metadata.join(" · ")}</p> : null;
}
