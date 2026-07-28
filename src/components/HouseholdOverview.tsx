import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HouseholdOverview as OverviewData, OverviewTvProgramme } from "../overview";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";
import { Ident } from "./Ident";
import { Button, buttonVariants } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

const OVERVIEW_LOAD_ERROR = "The Household summary could not be loaded.";

const episodeLabel = (programme: OverviewTvProgramme) =>
  `S${String(programme.episode.season).padStart(2, "0")}E${String(programme.episode.episode).padStart(2, "0")} — ${programme.episode.title}`;

export function HouseholdOverview({ secret }: { secret: string }) {
  const overviewQuery = useQuery({
    queryKey: parentKeys.overview(secret),
    queryFn: () => parentApi<OverviewData>(`/api/households/${secret}/overview`),
  });
  const overview = overviewQuery.data;

  if (overviewQuery.isPending) return <OverviewSkeleton />;

  if (!overview) {
    return (
      <section className="rounded-[4px] border bg-card p-5" role="alert">
        <h2 className="text-lg font-semibold">Household summary unavailable</h2>
        <p className="mt-1 text-sm text-destructive">{apiErrorMessage(overviewQuery.error, OVERVIEW_LOAD_ERROR)}</p>
        <Button type="button" variant="outline" className="mt-4" onClick={() => void overviewQuery.refetch()}>Try again</Button>
      </section>
    );
  }

  const noProgrammes = overview.approved.shows === 0 && overview.approved.movies === 0;
  return (
    <div className="grid gap-10" aria-live="polite">
      {noProgrammes && (
        <section className="flex flex-col gap-4 rounded-[4px] border bg-card p-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="empty-household-heading">
          <div>
            <h2 id="empty-household-heading" className="text-lg font-semibold">Build your Approved Library</h2>
            <p className="mt-1 max-w-[40rem] text-sm leading-relaxed text-muted-foreground">Approve at least one show or movie before a Channel can choose its Current Programme.</p>
          </div>
          <Link className={buttonVariants({ className: "shrink-0" })} to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
        </section>
      )}

      <section aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="mb-4 text-xl font-semibold tracking-[-0.01em]">On now</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChannelCurrent
            kind="TV Channel"
            programme={overview.tv.current && {
              title: overview.tv.current.title,
              detail: episodeLabel(overview.tv.current),
              poster: overview.tv.current.poster,
            }}
            empty={overview.approved.shows === 0
              ? "Approve a show to start the TV Channel."
              : "No eligible show is available. Review paused or finished shows."}
            linkTo={overview.approved.shows === 0 ? "add-programmes" : "approved-library"}
            secret={secret}
          />
          <ChannelCurrent
            kind="Movie Channel"
            programme={overview.movie.current && {
              title: overview.movie.current.title,
              detail: overview.movie.current.releaseInfo,
              poster: overview.movie.current.poster,
            }}
            empty={overview.approved.movies === 0
              ? "Approve a movie to start the Movie Channel."
              : "No movie is currently available. Review the Approved Library."}
            linkTo={overview.approved.movies === 0 ? "add-programmes" : "approved-library"}
            secret={secret}
          />
        </div>
      </section>

      <section aria-labelledby="next-tv-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 id="next-tv-heading" className="text-xl font-semibold tracking-[-0.01em]">Coming up on the TV Channel</h2>
          <Link className="shrink-0 text-sm font-medium text-accent underline-offset-4 hover:underline" to="/households/$secret/tv-channel" params={{ secret }}>View TV Channel</Link>
        </div>
        {overview.tv.next.length ? (
          <ol className="divide-y border-y">
            {overview.tv.next.map((programme, index) => (
              <li key={`${programme.programmeId}-${programme.episode.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="w-6 shrink-0 font-mono text-xs font-semibold text-muted-foreground" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{programme.title}</strong>
                  <small className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{episodeLabel(programme)}</small>
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm leading-relaxed text-muted-foreground">{overview.approved.shows ? "No upcoming TV programmes are scheduled." : "Approve a show to create the TV Channel Schedule."}</p>}
      </section>

      <section className="flex flex-col gap-4 border-y py-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="library-summary-heading">
        <div>
          <h2 id="library-summary-heading" className="text-lg font-semibold">Approved Library</h2>
          <p className="mt-1 text-sm text-muted-foreground">Programmes your Channels may choose from.</p>
        </div>
        <dl className="flex gap-8">
          <div className="flex flex-col-reverse">
            <dt className="text-xs font-semibold text-muted-foreground">Shows</dt>
            <dd className="font-mono text-2xl font-bold">{overview.approved.shows}</dd>
          </div>
          <div className="flex flex-col-reverse">
            <dt className="text-xs font-semibold text-muted-foreground">Movies</dt>
            <dd className="font-mono text-2xl font-bold">{overview.approved.movies}</dd>
          </div>
        </dl>
      </section>

      <nav aria-label="Overview quick actions">
        <h2 className="mb-3 text-lg font-semibold">Next actions</h2>
        <div className="flex flex-wrap gap-2">
          <Link className={buttonVariants()} to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
          <Link className={buttonVariants({ variant: "outline" })} to="/households/$secret/approved-library" params={{ secret }}>Approved Library</Link>
          <Link className={buttonVariants({ variant: "outline" })} to="/households/$secret/settings" hash="installation" params={{ secret }}>Install in Stremio</Link>
        </div>
      </nav>
    </div>
  );
}

function ChannelCurrent({ kind, programme, empty, linkTo, secret }: {
  kind: "TV Channel" | "Movie Channel";
  programme: { title: string; detail?: string; poster?: string } | null;
  empty: string;
  linkTo: "add-programmes" | "approved-library";
  secret: string;
}) {
  return (
    <article className="flex min-h-40 gap-4 rounded-[4px] border bg-card p-5">
      <div className="min-w-0 flex-1 self-center">
        <Ident className="mb-2">{kind === "TV Channel" ? "TV" : "Movie"}</Ident>
        {programme ? (
          <>
            <h3 className="text-lg leading-snug font-semibold break-words">{programme.title}</h3>
            {programme.detail && <p className="mt-1 font-mono text-xs text-muted-foreground">{programme.detail}</p>}
          </>
        ) : (
          <>
            <h3 className="text-lg leading-snug font-semibold">No Current Programme</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{empty}</p>
          </>
        )}
        {!programme && (
          <Link className="mt-2 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline" to={`/households/$secret/${linkTo}`} params={{ secret }}>
            {linkTo === "add-programmes" ? "Add Programmes" : "Review Approved Library"}
          </Link>
        )}
      </div>
      {programme?.poster && <img src={programme.poster} alt={`${programme.title} poster`} className="h-27 w-18 shrink-0 self-center rounded-[3px] object-cover" />}
    </article>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-10" aria-busy="true" aria-label="Loading Household overview">
      <span className="sr-only">Loading Household overview…</span>
      <section>
        <Skeleton className="mb-4 h-7 w-40" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton data-slot="skeleton-card" className="h-40" />
          <Skeleton data-slot="skeleton-card" className="h-40" />
        </div>
      </section>
      <section>
        <Skeleton className="mb-4 h-7 w-64" />
        <Skeleton className="h-12 rounded-t-[4px]" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12 rounded-b-[4px]" />
      </section>
      <Skeleton className="h-24" />
    </div>
  );
}
