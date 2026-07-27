import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";

export const Route = createFileRoute("/households/$secret/tv-channel")({ component: TvChannelPage });

type Episode = {
  id: string;
  season: number;
  episode: number;
  title: string;
  released?: string;
};

type ScheduledProgramme = {
  position: number;
  programmeId: string;
  showTitle: string;
  poster?: string;
  episode: Episode;
};

type PlaybackItem = {
  showTitle: string;
  episode: Episode;
  playedAt: string;
};

type TvState = {
  current?: ScheduledProgramme;
  schedule: ScheduledProgramme[];
  recentPlayback: PlaybackItem[];
  canUndo: boolean;
};

type LoadReason = "initial" | "refresh";

const HISTORY_PREVIEW_SIZE = 5;
const POLL_INTERVAL_MS = 30_000;

function episodeLabel(episode: Episode) {
  return `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} — ${episode.title}`;
}

async function responseBody(response: Response): Promise<{ error?: string; message?: string } & Partial<TvState>> {
  try {
    return await response.json() as { error?: string; message?: string } & Partial<TvState>;
  } catch {
    return {};
  }
}

function expireParentSession(response: Response, error?: string) {
  if (response.status === 401 && error === "Parent authentication is required.") {
    window.dispatchEvent(new Event("parent-session-expired"));
  }
}

function TvChannelPage() {
  const { secret } = Route.useParams();
  const base = `/api/households/${secret}`;
  const [state, setState] = useState<TvState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [mutation, setMutation] = useState<"undo" | "regenerate" | null>(null);
  const [mutationStatus, setMutationStatus] = useState("");
  const [mutationFailed, setMutationFailed] = useState(false);
  const [confirmingRegeneration, setConfirmingRegeneration] = useState(false);
  const mounted = useRef(true);
  const loading = useRef(false);
  const lastVisibilityRefresh = useRef(0);

  const loadState = useCallback(async (reason: LoadReason = "refresh") => {
    if (loading.current) return;
    loading.current = true;
    if (reason === "refresh") setRefreshStatus("Refreshing Channel data…");
    try {
      const response = await fetch(`${base}/tv-state`, { cache: "no-store", credentials: "same-origin" });
      const result = await responseBody(response);
      expireParentSession(response, result.error);
      if (!mounted.current) return;
      if (!response.ok || !Array.isArray(result.schedule) || !Array.isArray(result.recentPlayback)) {
        setLoadError(result.error || "TV Channel data could not be loaded. Try again.");
        setRefreshStatus("Channel data may be out of date.");
        return;
      }
      setState(result as TvState);
      setLoadError("");
      if (reason === "refresh") setRefreshStatus("Channel data updated.");
    } catch {
      if (!mounted.current) return;
      setLoadError("TV Channel data could not be loaded. Check your connection and try again.");
      setRefreshStatus("Channel data may be out of date.");
    } finally {
      loading.current = false;
    }
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

  async function performAction(kind: "undo" | "regenerate") {
    if (mutation) return;
    setMutation(kind);
    setMutationStatus("");
    setMutationFailed(false);
    try {
      const path = kind === "undo" ? "/tv-schedule/undo" : "/tv-schedule/regenerate";
      const response = await fetch(`${base}${path}`, { method: "POST", credentials: "same-origin" });
      const result = await responseBody(response);
      expireParentSession(response, result.error);
      if (!response.ok) {
        setMutationFailed(true);
        setMutationStatus(result.error || `The ${kind === "undo" ? "advancement" : "schedule"} could not be changed. Try again.`);
        return;
      }
      await loadState();
      setMutationStatus(result.message || (kind === "undo" ? "Most recent advancement undone." : "Upcoming TV selections regenerated."));
      window.dispatchEvent(new Event("stremio-restart-required"));
    } catch {
      setMutationFailed(true);
      setMutationStatus("The TV Channel could not be changed. Check your connection and try again.");
    } finally {
      if (mounted.current) setMutation(null);
    }
  }

  const history = state?.recentPlayback ?? [];
  const visibleHistory = historyExpanded ? history : history.slice(0, HISTORY_PREVIEW_SIZE);

  return (
    <section className="destination tv-channel-page" aria-labelledby="page-heading">
      <header className="destination-header">
        <p className="eyebrow">Channel</p>
        <h1 id="page-heading">TV Channel</h1>
        <p>Inspect what will resume, review upcoming selections, and correct the latest advancement.</p>
      </header>

      {!state ? (
        loadError ? (
          <div className="card channel-load-error">
            <h2>TV Channel unavailable</h2>
            <p role="alert">{loadError}</p>
            <Button type="button" className="button-secondary" onClick={() => void loadState("initial")}>Try again</Button>
          </div>
        ) : <ChannelSkeleton />
      ) : (
        <>
          {loadError && <p className="inline-error" role="alert">{loadError}</p>}
          <p className="sr-status" role="status" aria-live="polite">{refreshStatus}</p>

          <section className="card current-programme" aria-labelledby="current-programme-heading">
            <div>
              <h2 id="current-programme-heading" className="eyebrow">Current Programme</h2>
              <h3>{state.current?.showTitle || "Nothing scheduled"}</h3>
              {state.current ? <p className="current-episode">{episodeLabel(state.current.episode)}</p> : <p>Add or resume an approved show to start the TV Channel.</p>}
            </div>
            {state.current?.poster && <img src={state.current.poster} alt={`Poster for ${state.current.showTitle}`} />}
          </section>

          <section className="channel-section" aria-labelledby="schedule-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Full schedule</p><h2 id="schedule-heading">Channel Schedule</h2></div>
              <span className="item-count">{state.schedule.length} programme{state.schedule.length === 1 ? "" : "s"}</span>
            </div>
            {state.schedule.length ? (
              <ol className="schedule-list" aria-labelledby="schedule-heading">
                {state.schedule.map((programme, index) => (
                  <li key={`${programme.position}-${programme.episode.id}`} aria-current={index === 0 ? "true" : undefined}>
                    <span className="schedule-marker" aria-hidden="true">{index + 1}</span>
                    <div><strong>{programme.showTitle}</strong><span>{episodeLabel(programme.episode)}</span></div>
                    {index === 0 && <span className="current-badge">Current</span>}
                  </li>
                ))}
              </ol>
            ) : <div className="card channel-empty"><p>No programmes are scheduled. Add or resume shows in the Approved Library.</p></div>}
          </section>

          <section className="channel-section" aria-labelledby="history-heading">
            <div className="section-heading-row">
              <div><p className="eyebrow">Playback</p><h2 id="history-heading">Recent playback</h2></div>
              {state.canUndo && <Button type="button" className="button-secondary compact-button" disabled={mutation !== null} onClick={() => void performAction("undo")}>{mutation === "undo" ? "Undoing…" : "Undo latest advancement"}</Button>}
            </div>
            {history.length ? (
              <ol id="recent-playback-list" className="history-list" aria-labelledby="history-heading">
                {visibleHistory.map((item, index) => <li key={`${item.playedAt}-${item.episode.id}-${index}`}><div><strong>{item.showTitle}</strong><span>{episodeLabel(item.episode)}</span></div><time dateTime={item.playedAt}>{new Date(item.playedAt).toLocaleDateString()}</time></li>)}
              </ol>
            ) : <p className="muted-copy">No recent playback.</p>}
            {history.length > HISTORY_PREVIEW_SIZE && <Button type="button" className="button-secondary disclosure-button" aria-expanded={historyExpanded} aria-controls="recent-playback-list" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? "Show fewer" : `Show all ${history.length}`}</Button>}
          </section>

          <section className="card regeneration" aria-labelledby="regeneration-heading">
            <div><h2 id="regeneration-heading">Regenerate upcoming selections</h2><p>Choose a new order for future programmes without interrupting the Current Programme.</p></div>
            <Button type="button" className="button-secondary" disabled={mutation !== null || state.schedule.length === 0} onClick={() => setConfirmingRegeneration(true)}>Regenerate schedule</Button>
          </section>

          <p className={mutationFailed ? "inline-error" : "action-status"} role={mutationFailed ? "alert" : "status"} aria-live="polite">{mutationStatus}</p>
        </>
      )}

      {confirmingRegeneration && <ConfirmationDialog pending={mutation === "regenerate"} onCancel={() => setConfirmingRegeneration(false)} onConfirm={async () => { await performAction("regenerate"); if (mounted.current) setConfirmingRegeneration(false); }} />}
    </section>
  );
}

function ChannelSkeleton() {
  return <div className="channel-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Loading TV Channel"><div className="card skeleton-block skeleton-current" /><div className="skeleton-block skeleton-list" /><span className="sr-only">Loading TV Channel…</span></div>;
}

function ConfirmationDialog({ pending, onCancel, onConfirm }: { pending: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  return <dialog ref={dialogRef} className="confirmation-dialog card" aria-labelledby="regenerate-dialog-title" aria-describedby="regenerate-dialog-description" onCancel={(event) => { if (pending) event.preventDefault(); else onCancel(); }}>
    <h2 id="regenerate-dialog-title">Regenerate upcoming selections?</h2>
    <p id="regenerate-dialog-description">This changes only upcoming TV selections. The Current Programme and Show Progress remain unchanged.</p>
    <div className="dialog-actions">
      <Button type="button" className="button-secondary" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button type="button" disabled={pending} autoFocus onClick={() => void onConfirm()}>{pending ? "Regenerating…" : "Regenerate selections"}</Button>
    </div>
  </dialog>;
}
