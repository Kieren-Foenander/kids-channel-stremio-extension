import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HouseholdOverview as OverviewData, OverviewTvProgramme } from "../overview";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";
import { Button } from "./Button";
import { Card } from "./ui/card";
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
      <Card className="overview-error" role="alert">
        <h2>Household summary unavailable</h2>
        <p>{apiErrorMessage(overviewQuery.error, OVERVIEW_LOAD_ERROR)}</p>
        <Button type="button" className="button-secondary" onClick={() => void overviewQuery.refetch()}>Try again</Button>
      </Card>
    );
  }

  const noProgrammes = overview.approved.shows === 0 && overview.approved.movies === 0;
  return (
    <div className="overview" aria-live="polite">
      {noProgrammes && (
        <section className="setup-callout" aria-labelledby="empty-household-heading">
          <div>
            <h2 id="empty-household-heading">Build your Approved Library</h2>
            <p>Approve at least one show or movie before a Channel can choose its Current Programme.</p>
          </div>
          <Link className="button" to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
        </section>
      )}

      <section aria-labelledby="channels-heading">
        <div className="overview-section-heading">
          <div><p className="eyebrow">At a glance</p><h2 id="channels-heading">Current Programmes</h2></div>
        </div>
        <div className="current-grid">
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

      <section className="overview-panel" aria-labelledby="next-tv-heading">
        <div className="overview-section-heading">
          <div><p className="eyebrow">TV Channel</p><h2 id="next-tv-heading">Coming up next</h2></div>
          <Link className="text-link" to="/households/$secret/tv-channel" params={{ secret }}>View TV Channel</Link>
        </div>
        {overview.tv.next.length ? (
          <ol className="next-programmes">
            {overview.tv.next.map((programme) => (
              <li key={`${programme.programmeId}-${programme.episode.id}`}>
                <span className="schedule-position" aria-hidden="true">{String(overview.tv.next.indexOf(programme) + 1).padStart(2, "0")}</span>
                <span><strong>{programme.title}</strong><small>{episodeLabel(programme)}</small></span>
              </li>
            ))}
          </ol>
        ) : <p className="overview-empty">{overview.approved.shows ? "No upcoming TV programmes are scheduled." : "Approve a show to create the TV Channel Schedule."}</p>}
      </section>

      <section className="library-summary card" aria-labelledby="library-summary-heading">
        <div><p className="eyebrow">Approved Library</p><h2 id="library-summary-heading">Your programmes</h2></div>
        <dl><div><dt>Shows</dt><dd>{overview.approved.shows}</dd></div><div><dt>Movies</dt><dd>{overview.approved.movies}</dd></div></dl>
      </section>

      <nav className="quick-actions" aria-label="Overview quick actions">
        <h2>Next actions</h2>
        <div>
          <Link className="button" to="/households/$secret/add-programmes" params={{ secret }}>Add Programmes</Link>
          <Link className="button button-secondary" to="/households/$secret/approved-library" params={{ secret }}>Approved Library</Link>
          <Link className="button button-secondary" to="/households/$secret/settings" hash="installation" params={{ secret }}>Install in Stremio</Link>
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
    <article className={`current-programme ${kind === "TV Channel" ? "current-tv" : "current-movie"}`}>
      <div className="current-copy">
        <p className="channel-label">{kind}</p>
        {programme ? <><h3>{programme.title}</h3>{programme.detail && <p>{programme.detail}</p>}</> : <><h3>No Current Programme</h3><p>{empty}</p></>}
        {!programme && <Link className="text-link" to={`/households/$secret/${linkTo}`} params={{ secret }}>{linkTo === "add-programmes" ? "Add Programmes" : "Review Approved Library"}</Link>}
      </div>
      {programme?.poster && <img src={programme.poster} alt={`${programme.title} poster`} />}
    </article>
  );
}

function OverviewSkeleton() {
  return (
    <div className="overview overview-skeleton" aria-busy="true" aria-label="Loading Household overview">
      <span className="sr-only">Loading Household overview…</span>
      <section><Skeleton className="skeleton-line skeleton-heading" /><div className="current-grid"><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" /></div></section>
      <section className="overview-panel"><Skeleton className="skeleton-line skeleton-heading" /><Skeleton className="skeleton-row" /><Skeleton className="skeleton-row" /></section>
      <Card className="library-summary"><Skeleton className="skeleton-line skeleton-heading" /><Skeleton className="skeleton-row" /></Card>
    </div>
  );
}
