import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";

type Episode = { id: string; season: number; episode: number; title: string };
type Programme = {
  id: string; type: "show" | "movie"; title: string; poster?: string; releaseInfo?: string;
  genres?: string[]; imdbRating?: string; description?: string; episodes?: Episode[];
  showProgress?: Episode | null; pausedAt?: string | null;
};
type TvState = { current: null | { showTitle: string; episode: Episode }; schedule: Array<{ showTitle: string; episode: Episode }>; recentPlayback: Array<{ showTitle: string; episode: Episode }>; canUndo: boolean };
type MovieState = { current: null | { title: string }; remaining: Array<{ title: string }>; recentPlayback: Array<{ title: string }> };

const emptyTv: TvState = { current: null, schedule: [], recentPlayback: [], canUndo: false };
const emptyMovies: MovieState = { current: null, remaining: [], recentPlayback: [] };
const episodeLabel = (episode: Episode) => `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} — ${episode.title}`;

async function resultOf(response: Response) {
  const result = await response.json() as Record<string, any>;
  if (response.status === 401 && result.error === "Parent authentication is required.") window.dispatchEvent(new Event("parent-session-expired"));
  return result;
}

/** Temporary compatibility surface: keeps the shipped Parent workflows available while
 * their focused route replacements are delivered by later tickets in the rewrite. */
export function LegacyParentWorkflows({ secret }: { secret: string }) {
  const base = `/api/households/${secret}`;
  const [library, setLibrary] = useState<Programme[]>([]);
  const [searchResults, setSearchResults] = useState<Programme[]>([]);
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchStatus, setSearchStatus] = useState("");
  const [libraryStatus, setLibraryStatus] = useState("");
  const [tvStatus, setTvStatus] = useState("");
  const [movieStatus, setMovieStatus] = useState("");
  const [pinStatus, setPinStatus] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [tv, setTv] = useState<TvState>(emptyTv);
  const [movies, setMovies] = useState<MovieState>(emptyMovies);
  const [deleted, setDeleted] = useState(false);

  const loadLibrary = useCallback(async () => {
    const response = await fetch(`${base}/library`, { cache: "no-store" });
    const result = await resultOf(response);
    if (response.ok) setLibrary(result.programmes);
  }, [base]);
  const loadTvState = useCallback(async () => {
    const response = await fetch(`${base}/tv-state`, { cache: "no-store" });
    const result = await resultOf(response);
    if (response.ok) setTv(result as TvState);
  }, [base]);
  const loadMovieState = useCallback(async () => {
    const response = await fetch(`${base}/movie-state`, { cache: "no-store" });
    const result = await resultOf(response);
    if (response.ok) setMovies(result as MovieState);
  }, [base]);
  const reload = useCallback(async () => Promise.all([loadLibrary(), loadTvState(), loadMovieState()]), [loadLibrary, loadMovieState, loadTvState]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const exposed = window as typeof window & { loadTvState?: () => Promise<void>; loadMovieState?: () => Promise<void> };
    exposed.loadTvState = loadTvState;
    exposed.loadMovieState = loadMovieState;
    return () => { delete exposed.loadTvState; delete exposed.loadMovieState; };
  }, [loadMovieState, loadTvState]);

  if (deleted) return <section><h2>Household deleted</h2><p>All Household data and synced addon access have been permanently removed.</p></section>;

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchStatus("Searching Cinemeta…");
    const query = new FormData(event.currentTarget).get("query");
    const response = await fetch(`${base}/cinemeta/search?q=${encodeURIComponent(String(query))}`);
    const result = await resultOf(response);
    if (!response.ok) { setSearchStatus(result.error); return; }
    setSearchResults(result.results);
    setSearchVersion(version => version + 1);
    setSearchStatus(result.results.length ? `${result.results.length} results` : "No matching shows or movies.");
  }

  async function approve(programme: Programme, startingEpisodeId?: string) {
    const response = await fetch(`${base}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: programme.type, imdbId: programme.id, startingEpisodeId }) });
    const result = await resultOf(response);
    if (response.ok) await reload();
    return { ok: response.ok, message: response.ok ? "Approved" : result.error as string };
  }

  async function libraryAction(path: string, method: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const result = await resultOf(response);
    setLibraryStatus(response.ok ? result.message : result.error);
    if (response.ok) await reload();
  }

  async function channelAction(path: string, target: "tv" | "movie" | "library") {
    const response = await fetch(`${base}${path}`, { method: "POST" });
    const result = await resultOf(response);
    const setStatus = target === "tv" ? setTvStatus : target === "movie" ? setMovieStatus : setLibraryStatus;
    setStatus(response.ok ? result.message : result.error);
    if (response.ok) await reload();
  }

  async function changePin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch(`${base}/pin`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPin: data.get("currentPin"), newPin: data.get("newPin") }) });
    const result = await response.json() as { message?: string; error?: string };
    setPinStatus(response.ok ? result.message! : result.error!);
    if (response.ok) form.reset();
  }

  async function deleteHousehold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch(base, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPin: data.get("currentPin"), confirmation: data.get("confirmation") }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setDeleteStatus(result.error || "Deletion failed."); return; }
    setDeleted(true);
  }

  const manifestUrl = `${location.origin}/addons/${secret}/manifest.json`;
  return <div className="legacy-workflows">
    <section aria-labelledby="legacy-library-heading">
      <h2 id="legacy-library-heading">Manage Approved Library</h2>
      <p className="warning">Stremio keeps Channel details in memory. After changing the Approved Library or regenerating selections, fully close and reopen Stremio to load the updated Channel.</p>
      <p>Manifest: <code id="manifest">{manifestUrl}</code></p>
      <form className="legacy-search" onSubmit={search}>
        <label htmlFor="legacy-search">Search Cinemeta for shows and movies</label>
        <input id="legacy-search" name="query" type="search" minLength={2} maxLength={100} required />
        <Button type="submit">Search</Button>
      </form>
      <p id="search-status" role="status">{searchStatus}</p>
      <div id="search-results" className="programme-grid">{searchResults.map(programme => <SearchProgramme key={`${searchVersion}-${programme.type}-${programme.id}`} programme={programme} base={base} approve={approve} />)}</div>
      <p id="library-status" role="status">{libraryStatus}</p>
      <div id="library" className="programme-grid">{library.length ? library.map(programme => <LibraryProgramme key={programme.id} programme={programme} act={libraryAction} />) : <p>No programmes approved yet.</p>}</div>
    </section>

    <section><h2>TV Channel</h2>
      <p id="tv-current">{tv.current ? `${tv.current.showTitle} — ${episodeLabel(tv.current.episode)}` : "No Current Programme."}</p>
      <Button type="button" className="button-secondary" hidden={!tv.canUndo} onClick={() => void channelAction("/tv-schedule/undo", "tv")}>Undo most recent advancement</Button>
      <h3>Channel Schedule</h3><ol id="tv-schedule">{tv.schedule.length ? tv.schedule.map((item, index) => <li key={index}>{item.showTitle} — {episodeLabel(item.episode)}</li>) : <li>No programmes scheduled.</li>}</ol>
      <h3>Recently played</h3><ol id="tv-history">{tv.recentPlayback.length ? tv.recentPlayback.map((item, index) => <li key={index}>{item.showTitle} — {episodeLabel(item.episode)}</li>) : <li>No recent playback.</li>}</ol>
      <Button type="button" className="button-secondary" onClick={() => void channelAction("/tv-schedule/regenerate", "library")}>Regenerate upcoming TV selections</Button>
      <p id="tv-status" role="status">{tvStatus}</p>
    </section>

    <section><h2>Movie Channel</h2>
      <p id="movie-current">{movies.current?.title || "No Current Programme."}</p>
      <h3>Remaining rotation</h3><ol id="movie-rotation">{movies.remaining.length ? movies.remaining.map((item, index) => <li key={index}>{item.title}</li>) : <li>No movies remaining.</li>}</ol>
      <h3>Recently played</h3><ol id="movie-history">{movies.recentPlayback.length ? movies.recentPlayback.map((item, index) => <li key={index}>{item.title}</li>) : <li>No recent playback.</li>}</ol>
      <Button type="button" className="button-secondary" onClick={() => void channelAction("/movie-rotation/reset", "movie")}>Reset movie rotation</Button>
      <p id="movie-status" role="status">{movieStatus}</p>
    </section>

    <section><h2>Parent access</h2><p>There is no forgotten-PIN or account recovery flow. Store the PIN somewhere safe.</p>
      <form className="form" onSubmit={changePin}><label>Current PIN<input name="currentPin" type="password" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>New six-digit PIN<input name="newPin" type="password" inputMode="numeric" pattern="[0-9]{6}" required /></label><Button type="submit">Change Parent PIN</Button><p id="pin-status" role="status">{pinStatus}</p></form>
    </section>
    <section><h2>Delete Household</h2><p className="warning">Permanent deletion removes the Approved Library, Channel state, history, PIN, and synced addon access. This cannot be undone.</p>
      <form className="form" onSubmit={deleteHousehold}><label>Current PIN<input name="currentPin" type="password" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>Type DELETE to confirm<input name="confirmation" pattern="DELETE" autoComplete="off" required /></label><Button type="submit">Permanently delete Household</Button><p id="delete-status" className="field-error" role="alert">{deleteStatus}</p></form>
    </section>
  </div>;
}

function ProgrammeCard({ programme, children }: { programme: Programme; children: ReactNode }) {
  const metadata = [programme.releaseInfo, programme.genres?.join(", "), programme.imdbRating ? `IMDb ${programme.imdbRating}` : ""].filter(Boolean).join(" · ");
  return <article className="programme"><img src={programme.poster} alt="" /><div><p className="eyebrow">{programme.type === "show" ? "Show" : "Movie"}</p><h3>{programme.title}</h3><p>{metadata}</p><p>{programme.description || "No description available."}</p>{children}</div></article>;
}

function SearchProgramme({ programme, base, approve }: { programme: Programme; base: string; approve: (programme: Programme, episode?: string) => Promise<{ ok: boolean; message: string }> }) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  async function begin() {
    if (programme.type === "movie") return finish();
    setPending(true);
    const response = await fetch(`${base}/cinemeta/title/show/${programme.id}`);
    const result = await resultOf(response);
    setPending(false);
    if (!response.ok) { setMessage(result.error); return; }
    const loaded = result.title.episodes as Episode[];
    setEpisodes(loaded); setSelected(loaded[0]?.id || "");
  }
  async function finish() { setPending(true); const result = await approve(programme, selected || undefined); setPending(false); setMessage(result.message); }
  return <ProgrammeCard programme={programme}>{episodes && <select aria-label={`Starting episode for ${programme.title}`} value={selected} onChange={event => setSelected(event.target.value)}>{episodes.map(episode => <option key={episode.id} value={episode.id}>{episodeLabel(episode)}</option>)}</select>}<Button type="button" disabled={pending || message === "Approved"} onClick={() => void (episodes || programme.type === "movie" ? finish() : begin())}>{message || (pending ? "Loading episodes…" : episodes ? "Approve show" : programme.type === "show" ? "Choose starting episode" : "Approve movie")}</Button></ProgrammeCard>;
}

function LibraryProgramme({ programme, act }: { programme: Programme; act: (path: string, method: string, body?: unknown) => Promise<void> }) {
  const [episode, setEpisode] = useState(programme.showProgress?.id || programme.episodes?.[0]?.id || "");
  return <ProgrammeCard programme={programme}>{programme.type === "show" && <><p>{programme.showProgress ? `Show Progress: ${episodeLabel(programme.showProgress)}` : "Finished"}</p><select aria-label={`Next episode for ${programme.title}`} value={episode} onChange={event => setEpisode(event.target.value)}>{programme.episodes?.map(item => <option key={item.id} value={item.id}>{episodeLabel(item)}</option>)}</select><Button type="button" onClick={() => void act(`/library/${programme.id}/progress`, "PATCH", { videoId: episode })}>{programme.showProgress ? "Set Show Progress" : "Restart show"}</Button><Button type="button" onClick={() => void act(`/library/${programme.id}`, "PATCH", { paused: !programme.pausedAt })}>{programme.pausedAt ? "Resume show" : "Pause show"}</Button></>}<Button type="button" className="button-secondary" onClick={() => void act(`/library/${programme.id}`, "DELETE")}>Remove {programme.type === "show" ? "show" : "movie"}</Button></ProgrammeCard>;
}
