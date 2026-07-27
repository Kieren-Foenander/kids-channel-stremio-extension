import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../components/Button";
import { DestinationPage } from "../components/DestinationPage";
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

  const approval = useMutation({
    mutationFn: (programme: SearchProgramme) => parentApi<{ programme: unknown }>(`/api/households/${secret}/library`, {
      method: "POST",
      body: { type: programme.type, imdbId: programme.id },
    }),
    onSuccess: async () => {
      window.dispatchEvent(new Event("stremio-restart-required"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.movie(secret) }),
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

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: ProgrammeType) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: ProgrammeType = event.key === "Home" ? "show" : event.key === "End" ? "movie" : current === "show" ? "movie" : "show";
    selectTab(next);
    document.getElementById(`search-tab-${next}`)?.focus();
  }

  function changePage(next: number) {
    void navigate({ search: { q: query, type: tab, page: next } });
  }

  function openDetails(programme: SearchProgramme) {
    approval.reset();
    setDetail(programme);
  }

  const invalidRestoredQuery = Boolean(query) && (query.length < 2 || query.length > 100);
  return <div className="add-programmes-page">
    <DestinationPage eyebrow="Approved Library" title="Add Programmes" description="Search Cinemeta, review a programme, then approve it for your Channels." />

    <section className="search-panel" aria-labelledby="cinemeta-search-heading">
      <h2 id="cinemeta-search-heading">Search Cinemeta</h2>
      <form className="programme-search-form" onSubmit={submit} noValidate>
        <div>
          <label htmlFor="programme-search">Search Cinemeta for shows and movies</label>
          <input id="programme-search" type="search" minLength={2} maxLength={100} required value={input} aria-invalid={Boolean(inputError)} aria-describedby={inputError ? "programme-search-error" : undefined} onChange={(event) => { setInput(event.target.value); setInputError(""); }} placeholder="Bluey, Paddington…" />
          {inputError && <p id="programme-search-error" className="field-error" role="alert">{inputError}</p>}
        </div>
        <Button type="submit">Search</Button>
      </form>
    </section>

    {invalidRestoredQuery && <p className="inline-error" role="alert">Search must contain between 2 and 100 characters.</p>}
    {results.isFetching && <p className="search-status" role="status">Searching Cinemeta…</p>}
    {results.isError && <section className="card search-error" role="alert"><h2>Search unavailable</h2><p>{apiErrorMessage(results.error, "Cinemeta search is temporarily unavailable. Try again.")}</p><Button type="button" className="button-secondary" onClick={() => void results.refetch()}>Try again</Button></section>}

    {results.isSuccess && <section className="search-results" aria-labelledby="search-results-heading">
      <div className="search-results-heading"><div><p className="eyebrow">Results</p><h2 id="search-results-heading">Results for “{query}”</h2></div><p>{programmes.length} total</p></div>
      <div className="library-tabs" role="tablist" aria-label="Search result type">
        <button id="search-tab-show" type="button" role="tab" tabIndex={tab === "show" ? 0 : -1} aria-selected={tab === "show"} aria-controls="search-result-grid" onKeyDown={(event) => tabKeyDown(event, "show")} onClick={() => selectTab("show")}>Shows <span>{counts.show}</span></button>
        <button id="search-tab-movie" type="button" role="tab" tabIndex={tab === "movie" ? 0 : -1} aria-selected={tab === "movie"} aria-controls="search-result-grid" onKeyDown={(event) => tabKeyDown(event, "movie")} onClick={() => selectTab("movie")}>Movies <span>{counts.movie}</span></button>
      </div>
      {page > pageCount ? <div className="card search-empty"><h3>That result page is unavailable</h3><Button type="button" className="button-secondary" onClick={() => changePage(pageCount)}>Go to page {pageCount}</Button></div> : typedResults.length === 0 ? <div className="card search-empty"><h3>No matching {tab === "show" ? "shows" : "movies"}</h3><p>Try the other result tab or search for another title.</p></div> : <>
        <p className="search-status" role="status">Showing {visible.length} of {typedResults.length} {tab === "show" ? "shows" : "movies"}, page {page} of {pageCount}</p>
        <div id="search-result-grid" role="tabpanel" aria-labelledby={`search-tab-${tab}`} className="search-poster-grid">
          {visible.map((programme) => <SearchCard key={`${programme.type}:${programme.id}`} programme={programme} isApproved={approved.has(`${programme.type}:${programme.id}`)} onDetails={openDetails} />)}
        </div>
        {pageCount > 1 && <nav className="pagination" aria-label="Search result pages">
          <Button type="button" className="button-secondary" disabled={page <= 1} onClick={() => changePage(page - 1)}>Previous</Button>
          <span>Page {page} of {pageCount}</span>
          <Button type="button" className="button-secondary" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>Next</Button>
        </nav>}
      </>}
    </section>}

    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open && !approval.isPending) { setDetail(null); approval.reset(); } }}>
      <DialogContent className="programme-detail-dialog" showCloseButton={!approval.isPending}>
        <DialogHeader>
          <p className="eyebrow">{detail?.type === "show" ? "Show" : "Movie"}</p>
          <DialogTitle>{detail?.title}</DialogTitle>
          <DialogDescription asChild><div>
            {detail && <ProgrammeMetadata programme={detail} />}
            <p className="programme-description">{detail?.description || "No description is available."}</p>
          </div></DialogDescription>
        </DialogHeader>
        {approval.isError && <p className="inline-error" role="alert">{apiErrorMessage(approval.error, "The movie could not be approved. Try again.")}</p>}
        {approval.isSuccess && <p className="approval-success" role="status">Added to the Approved Library.</p>}
        <DialogFooter>
          <DialogClose asChild><Button type="button" className="button-secondary" disabled={approval.isPending}>Close</Button></DialogClose>
          {detail?.type === "movie" && <Button type="button" disabled={approval.isPending || approval.isSuccess || approved.has(`movie:${detail.id}`)} onClick={() => approval.mutate(detail)}>
            {approval.isPending ? "Approving…" : approval.isSuccess || approved.has(`movie:${detail.id}`) ? "Already approved" : "Approve movie"}
          </Button>}
          {detail?.type === "show" && <p className="muted-copy">Show approval is available in the next update.</p>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function SearchCard({ programme, isApproved, onDetails }: { programme: SearchProgramme; isApproved: boolean; onDetails: (programme: SearchProgramme) => void }) {
  return <article className="search-programme-card">
    <div className="search-poster">
      <span aria-hidden="true">{programme.type === "show" ? "Show" : "Movie"}</span>
      {programme.poster && <img src={programme.poster} alt={`${programme.title} poster`} onError={(event) => { event.currentTarget.hidden = true; }} />}
    </div>
    <div className="search-programme-copy">
      <p className="eyebrow">{programme.type === "show" ? "Show" : "Movie"}</p>
      <h3>{programme.title}</h3>
      <ProgrammeMetadata programme={programme} />
      {isApproved && <span className="state-badge">Already approved</span>}
      <Button type="button" className="button-secondary compact-button" onClick={() => onDetails(programme)}>View details<span className="sr-only"> for {programme.title}</span></Button>
    </div>
  </article>;
}

function ProgrammeMetadata({ programme }: { programme: SearchProgramme }) {
  const metadata = [programme.releaseInfo, programme.genres.slice(0, 2).join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean);
  return metadata.length ? <p className="search-metadata">{metadata.join(" · ")}</p> : null;
}
