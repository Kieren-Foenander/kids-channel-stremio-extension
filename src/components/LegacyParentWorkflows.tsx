import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { parentKeys } from "../lib/parent-api";
import { Button } from "./Button";

type Episode = { id: string; season: number; episode: number; title: string };
type Programme = {
  id: string;
  imdbId?: string;
  type: "show" | "movie";
  title: string;
  poster?: string;
  releaseInfo?: string;
  genres?: string[];
  imdbRating?: string;
  description?: string;
  episodes?: Episode[];
  showProgress?: Episode | null;
  pausedAt?: string | null;
};

type CompatibilitySurface = "search" | "show-management";

const episodeLabel = (episode: Episode) => `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} — ${episode.title}`;

async function resultOf(response: Response) {
  const result = await response.json() as Record<string, any>;
  if (response.status === 401 && result.error === "Parent authentication is required.") {
    window.dispatchEvent(new Event("parent-session-expired"));
  }
  return result;
}

/**
 * Temporary compatibility surface for workflows whose focused route replacements have not
 * shipped yet. Remove each surface only when its owning ticket supplies the replacement.
 */
export function LegacyParentWorkflows({ secret, surface }: { secret: string; surface: CompatibilitySurface }) {
  const base = `/api/households/${secret}`;
  const queryClient = useQueryClient();
  const [library, setLibrary] = useState<Programme[]>([]);
  const [searchResults, setSearchResults] = useState<Programme[]>([]);
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchStatus, setSearchStatus] = useState("");
  const [libraryStatus, setLibraryStatus] = useState("");

  const loadLibrary = useCallback(async () => {
    const response = await fetch(`${base}/library`, { cache: "no-store" });
    const result = await resultOf(response);
    if (response.ok) setLibrary(result.programmes as Programme[]);
  }, [base]);

  useEffect(() => {
    if (surface === "show-management") void loadLibrary();
  }, [loadLibrary, surface]);

  async function refreshParentState() {
    await loadLibrary();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.tv(secret) }),
    ]);
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchStatus("Searching Cinemeta…");
    const query = new FormData(event.currentTarget).get("query");
    const response = await fetch(`${base}/cinemeta/search?q=${encodeURIComponent(String(query))}`);
    const result = await resultOf(response);
    if (!response.ok) {
      setSearchStatus(String(result.error));
      return;
    }
    setSearchResults(result.results as Programme[]);
    setSearchVersion((version) => version + 1);
    setSearchStatus(result.results.length ? `${result.results.length} results` : "No matching shows or movies.");
  }

  async function approve(programme: Programme, startingEpisodeId?: string) {
    const response = await fetch(`${base}/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: programme.type, imdbId: programme.id, startingEpisodeId }),
    });
    const result = await resultOf(response);
    if (response.ok) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: parentKeys.library(secret) }),
        queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
      ]);
      window.dispatchEvent(new Event("stremio-restart-required"));
    }
    return { ok: response.ok, message: response.ok ? "Approved" : String(result.error) };
  }

  async function libraryAction(path: string, method: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await resultOf(response);
    setLibraryStatus(response.ok ? String(result.message) : String(result.error));
    if (response.ok) {
      await refreshParentState();
      window.dispatchEvent(new Event("stremio-restart-required"));
    }
  }

  if (surface === "search") {
    return <section className="legacy-workflows" aria-labelledby="legacy-search-heading">
      <h2 id="legacy-search-heading">Search Cinemeta</h2>
      <form className="legacy-search" onSubmit={search}>
        <label htmlFor="legacy-search">Search Cinemeta for shows and movies</label>
        <input id="legacy-search" name="query" type="search" minLength={2} maxLength={100} required />
        <Button type="submit">Search</Button>
      </form>
      <p id="search-status" role="status">{searchStatus}</p>
      <div id="search-results" className="programme-grid">
        {searchResults.map((programme) => <SearchProgramme key={`${searchVersion}-${programme.type}-${programme.id}`} programme={programme} base={base} approve={approve} />)}
      </div>
    </section>;
  }

  const shows = library.filter((programme) => programme.type === "show");
  return <div className="legacy-workflows">
    {shows.length > 0 && <section aria-labelledby="existing-show-controls-heading">
      <h2 id="existing-show-controls-heading">Show controls</h2>
      <p>Pause, resume, correct Show Progress, restart, or remove an approved show.</p>
      <p id="library-status" role="status">{libraryStatus}</p>
      <div className="programme-grid">
        {shows.map((programme) => <LibraryShow key={programme.id} programme={programme} base={base} act={libraryAction} />)}
      </div>
    </section>}
  </div>;
}

function ProgrammeCard({ programme, children }: { programme: Programme; children: ReactNode }) {
  const metadata = [programme.releaseInfo, programme.genres?.join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean).join(" · ");
  return <article className="programme">
    {programme.poster ? <img src={programme.poster} alt="" /> : <div className="library-poster" aria-label="Poster unavailable"><span aria-hidden="true">{programme.type === "show" ? "Show" : "Movie"}</span></div>}
    <div><p className="eyebrow">{programme.type === "show" ? "Show" : "Movie"}</p><h3>{programme.title}</h3><p>{metadata}</p>{programme.description && <p>{programme.description}</p>}{children}</div>
  </article>;
}

function SearchProgramme({ programme, base, approve }: { programme: Programme; base: string; approve: (programme: Programme, episode?: string) => Promise<{ ok: boolean; message: string }> }) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function begin() {
    if (programme.type === "movie") return finish();
    setPending(true);
    const response = await fetch(`${base}/cinemeta/title/show/${encodeURIComponent(programme.id)}`);
    const result = await resultOf(response);
    setPending(false);
    if (!response.ok) {
      setMessage(String(result.error));
      return;
    }
    const loaded = result.title.episodes as Episode[];
    setEpisodes(loaded);
    setSelected(loaded[0]?.id || "");
  }

  async function finish() {
    setPending(true);
    const result = await approve(programme, selected || undefined);
    setPending(false);
    setMessage(result.message);
  }

  return <ProgrammeCard programme={programme}>
    {episodes && <select aria-label={`Starting episode for ${programme.title}`} value={selected} onChange={(event) => setSelected(event.target.value)}>{episodes.map((episode) => <option key={episode.id} value={episode.id}>{episodeLabel(episode)}</option>)}</select>}
    <Button type="button" disabled={pending || message === "Approved"} onClick={() => void (episodes || programme.type === "movie" ? finish() : begin())}>{message || (pending ? "Loading episodes…" : episodes ? "Approve show" : programme.type === "show" ? "Choose starting episode" : "Approve movie")}</Button>
  </ProgrammeCard>;
}

function LibraryShow({ programme, base, act }: { programme: Programme; base: string; act: (path: string, method: string, body?: unknown) => Promise<void> }) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [episode, setEpisode] = useState(programme.showProgress?.id || "");
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [detailError, setDetailError] = useState("");

  async function showProgressControls() {
    if (episodes) return;
    setLoadingEpisodes(true);
    setDetailError("");
    const response = await fetch(`${base}/cinemeta/title/show/${encodeURIComponent(programme.imdbId ?? programme.id)}`, { cache: "no-store" });
    const result = await resultOf(response);
    setLoadingEpisodes(false);
    if (!response.ok) {
      setDetailError(String(result.error));
      return;
    }
    const loaded = result.title.episodes as Episode[];
    setEpisodes(loaded);
    setEpisode((current) => current || programme.showProgress?.id || loaded[0]?.id || "");
  }

  return <section className="programme" aria-label={`${programme.title} show controls`}>
    {programme.poster ? <img src={programme.poster} alt="" /> : <div className="library-poster" aria-label="Poster unavailable"><span aria-hidden="true">Show</span></div>}
    <div>
      <p className="eyebrow">Show</p>
      <h3>{programme.title}</h3>
      <p>{programme.showProgress ? `Show Progress: ${episodeLabel(programme.showProgress)}` : "Finished"}</p>
      {!episodes && <Button type="button" className="button-secondary" disabled={loadingEpisodes} onClick={() => void showProgressControls()}>{loadingEpisodes ? "Loading episodes…" : programme.showProgress ? "Correct Show Progress" : "Restart show"}</Button>}
      {detailError && <p className="field-error" role="alert">{detailError}</p>}
      {episodes && <>
        <select aria-label={`Next episode for ${programme.title}`} value={episode} onChange={(event) => setEpisode(event.target.value)}>{episodes.map((item) => <option key={item.id} value={item.id}>{episodeLabel(item)}</option>)}</select>
        <Button type="button" disabled={!episode} onClick={() => void act(`/library/${programme.id}/progress`, "PATCH", { videoId: episode })}>{programme.showProgress ? "Set Show Progress" : "Restart show"}</Button>
      </>}
      <Button type="button" onClick={() => void act(`/library/${programme.id}`, "PATCH", { paused: !programme.pausedAt })}>{programme.pausedAt ? "Resume show" : "Pause show"}</Button>
      <Button type="button" className="button-secondary" onClick={() => void act(`/library/${programme.id}`, "DELETE")}>Remove show</Button>
    </div>
  </section>;
}
