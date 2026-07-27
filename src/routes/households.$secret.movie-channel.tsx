import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";

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

type LoadReason = "initial" | "refresh";

const ROTATION_PREVIEW_SIZE = 6;
const HISTORY_PREVIEW_SIZE = 5;
const POLL_INTERVAL_MS = 30_000;

async function responseBody(response: Response): Promise<{ error?: string; message?: string } & Partial<MovieState>> {
  try {
    return await response.json() as { error?: string; message?: string } & Partial<MovieState>;
  } catch {
    return {};
  }
}

function expireParentSession(response: Response, error?: string) {
  if (response.status === 401 && error === "Parent authentication is required.") {
    window.dispatchEvent(new Event("parent-session-expired"));
  }
}

function MovieChannelPage() {
  const { secret } = Route.useParams();
  const base = `/api/households/${secret}`;
  const [state, setState] = useState<MovieState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState("");
  const [rotationExpanded, setRotationExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [mutationStatus, setMutationStatus] = useState("");
  const [mutationFailed, setMutationFailed] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const mounted = useRef(true);
  const activeLoad = useRef<Promise<void> | null>(null);
  const lastVisibilityRefresh = useRef(0);

  const loadState = useCallback(function loadState(reason: LoadReason = "refresh", afterInFlight = false): Promise<void> {
    const currentLoad = activeLoad.current;
    if (currentLoad) {
      if (!afterInFlight) return currentLoad;
      return currentLoad.then(() => mounted.current ? loadState(reason) : undefined);
    }

    const request = (async () => {
      if (reason === "refresh") setRefreshStatus("Refreshing Movie Channel data…");
      try {
        const response = await fetch(`${base}/movie-state`, { cache: "no-store", credentials: "same-origin" });
        const result = await responseBody(response);
        expireParentSession(response, result.error);
        if (!mounted.current) return;
        if (!response.ok || !Array.isArray(result.remaining) || !Array.isArray(result.recentPlayback)) {
          setLoadError(result.error || "Movie Channel data could not be loaded. Try again.");
          setRefreshStatus("Movie Channel data may be out of date.");
          return;
        }
        setState(result as MovieState);
        setLoadError("");
        if (reason === "refresh") setRefreshStatus("Movie Channel data updated.");
      } catch {
        if (!mounted.current) return;
        setLoadError("Movie Channel data could not be loaded. Check your connection and try again.");
        setRefreshStatus("Movie Channel data may be out of date.");
      } finally {
        activeLoad.current = null;
      }
    })();
    activeLoad.current = request;
    return request;
  }, [base]);

  useEffect(() => {
    mounted.current = true;
    void loadState("initial");
    return () => { mounted.current = false; };
  }, [loadState]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefresh.current < 250) return;
      lastVisibilityRefresh.current = now;
      void loadState();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadState();
    }, POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadState]);

  async function resetRotation(): Promise<boolean> {
    if (resetting) return false;
    setResetting(true);
    setMutationStatus("");
    setMutationFailed(false);
    try {
      const response = await fetch(`${base}/movie-rotation/reset`, { method: "POST", credentials: "same-origin" });
      const result = await responseBody(response);
      expireParentSession(response, result.error);
      if (!response.ok) {
        setMutationFailed(true);
        setMutationStatus(result.error || "The movie rotation could not be reset. Try again.");
        return false;
      }
      await loadState("refresh", true);
      if (!mounted.current) return false;
      setMutationStatus(result.message || "Movie rotation reset without interrupting the Current Programme.");
      window.dispatchEvent(new Event("stremio-restart-required"));
      return true;
    } catch {
      if (mounted.current) {
        setMutationFailed(true);
        setMutationStatus("The Movie Channel could not be changed. Check your connection and try again.");
      }
      return false;
    } finally {
      if (mounted.current) setResetting(false);
    }
  }

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
        loadError ? (
          <div className="card channel-load-error">
            <h2>Movie Channel unavailable</h2>
            <p role="alert">{loadError}</p>
            <Button type="button" className="button-secondary" onClick={() => void loadState("initial")}>Try again</Button>
          </div>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {loadError && <p className="inline-error" role="alert">{loadError}</p>}
          <p className="sr-status" role="status" aria-live="polite">{refreshStatus}</p>

          <section className="card current-programme movie-current-programme" aria-labelledby="current-programme-heading">
            <div>
              <h2 id="current-programme-heading" className="eyebrow">Current Programme</h2>
              <h3>{state.current?.title || "Nothing selected"}</h3>
              {state.current
                ? <p className="current-episode">{state.current.releaseInfo || "Ready to resume in Stremio"}</p>
                : <p>Add an approved movie to start the Movie Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.title}`} />}
          </section>

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

      {confirmingReset && <ResetConfirmationDialog pending={resetting} error={mutationFailed ? mutationStatus : ""} onCancel={() => setConfirmingReset(false)} onConfirm={async () => { if (await resetRotation()) setConfirmingReset(false); }} />}
    </section>
  );
}

function ChannelSkeleton() {
  return <div className="channel-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Loading Movie Channel"><div className="card skeleton-block skeleton-current" /><div className="skeleton-block skeleton-list" /><span className="sr-only">Loading Movie Channel…</span></div>;
}

function ResetConfirmationDialog({ pending, error, onCancel, onConfirm }: { pending: boolean; error: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  return <dialog ref={dialogRef} className="confirmation-dialog card" aria-labelledby="reset-dialog-title" aria-describedby="reset-dialog-description" onCancel={(event) => { if (pending) event.preventDefault(); else onCancel(); }}>
    <h2 id="reset-dialog-title">Reset movie rotation?</h2>
    <p id="reset-dialog-description">Every approved movie will return to the remaining rotation. The Current Programme will not be interrupted.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <Button type="button" className="button-secondary" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button type="button" disabled={pending} autoFocus onClick={() => void onConfirm()}>{pending ? "Resetting…" : "Reset rotation"}</Button>
    </div>
  </dialog>;
}
