import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { ParentApiError, parentApi, parentKeys } from "../lib/parent-api";
import { Button } from "./Button";

type SessionState = "checking" | "authenticated" | "locked" | "expired";
type Theme = "system" | "light" | "dark";

const destinations = [
  { to: "/households/$secret", label: "Overview", end: true },
  { to: "/households/$secret/add-programmes", label: "Add Programmes" },
  { to: "/households/$secret/approved-library", label: "Approved Library" },
  { to: "/households/$secret/tv-channel", label: "TV Channel" },
  { to: "/households/$secret/movie-channel", label: "Movie Channel" },
  { to: "/households/$secret/settings", label: "Settings" },
] as const;

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && systemIsDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.setProperty("--parent-secondary-foreground", isDark ? "#f1f2ee" : "#20231f");
}

export function ParentShell({ secret }: { secret: string }) {
  const location = useLocation();
  const [session, setSession] = useState<SessionState>("checking");
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [lockError, setLockError] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [expiresIn, setExpiresIn] = useState(60 * 60);
  const [restartNotice, setRestartNotice] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const wasAuthenticated = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("kids-channels-theme");
    const selected = stored === "light" || stored === "dark" ? stored : "system";
    setTheme(selected);
    applyTheme(selected);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, [theme]);

  const sessionQuery = useQuery({
    queryKey: parentKeys.session(secret),
    queryFn: () => parentApi<{ expiresIn?: number }>(`/api/households/${secret}/session`, { notifyOnUnauthorized: false }),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (sessionQuery.error) {
      setSession(wasAuthenticated.current ? "expired" : "locked");
      if (!(sessionQuery.error instanceof ParentApiError) || sessionQuery.error.status !== 401) {
        setError("Parent access could not be checked. Try again.");
      }
    } else if (sessionQuery.data) {
      wasAuthenticated.current = true;
      setExpiresIn(Math.max(1, sessionQuery.data.expiresIn ?? 60 * 60));
      setSession("authenticated");
      setError("");
    }
  }, [sessionQuery.data, sessionQuery.error]);

  useEffect(() => {
    const onFocus = () => void sessionQuery.refetch();
    const onExpired = () => {
      wasAuthenticated.current = true;
      setSession("expired");
      void queryClient.invalidateQueries({ queryKey: parentKeys.session(secret) });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("parent-session-expired", onExpired);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("parent-session-expired", onExpired);
    };
  }, [queryClient, secret, sessionQuery.refetch]);

  useEffect(() => {
    if (session !== "authenticated") return;
    const timer = setTimeout(() => setSession("expired"), expiresIn * 1000);
    return () => clearTimeout(timer);
  }, [expiresIn, session]);

  useEffect(() => {
    const showRestartNotice = () => setRestartNotice(true);
    const showDeletedState = () => setDeleted(true);
    window.addEventListener("stremio-restart-required", showRestartNotice);
    window.addEventListener("household-deleted", showDeletedState);
    return () => {
      window.removeEventListener("stremio-restart-required", showRestartNotice);
      window.removeEventListener("household-deleted", showDeletedState);
    };
  }, []);

  const unlockMutation = useMutation({
    mutationFn: (pin: FormDataEntryValue | null) => parentApi(`/api/households/${secret}/unlock`, {
      method: "POST",
      body: { pin },
      notifyOnUnauthorized: false,
    }),
  });
  const lockMutation = useMutation({
    mutationFn: () => parentApi(`/api/households/${secret}/lock`, { method: "POST" }),
  });

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    try {
      await unlockMutation.mutateAsync(new FormData(form).get("pin"));
      form.reset();
      wasAuthenticated.current = true;
      queryClient.setQueryData(parentKeys.session(secret), { expiresIn: 60 * 60 });
      setExpiresIn(60 * 60);
      setSession("authenticated");
    } catch (unlockError) {
      setError(unlockError instanceof ParentApiError ? unlockError.message : "Parent access is temporarily unavailable. Try again.");
    }
  }

  async function lock() {
    if (lockMutation.isPending) return;
    setLockError("");
    try {
      await lockMutation.mutateAsync();
      wasAuthenticated.current = false;
      queryClient.removeQueries({ queryKey: ["household", secret] });
      setSession("locked");
    } catch {
      setLockError("The Parent Page could not be locked. Try again.");
    }
  }

  function chooseTheme(value: Theme) {
    setTheme(value);
    applyTheme(value);
    if (value === "system") localStorage.removeItem("kids-channels-theme");
    else localStorage.setItem("kids-channels-theme", value);
  }

  if (deleted) {
    return (
      <main id="main" className="page-shell deleted-shell">
        <p className="eyebrow">Kids Channels</p>
        <h1>Household deleted</h1>
        <p>The Household, all Channel state, Parent access, and synced addon access have been permanently removed.</p>
        <a className="button" href="/">Create a new Household</a>
      </main>
    );
  }

  if (session === "checking") {
    return <main id="main" className="page-shell" aria-busy="true"><p className="eyebrow">Parent Page</p><h1>Checking secure access…</h1></main>;
  }

  if (session !== "authenticated") {
    return (
      <main id="main" className="page-shell unlock-shell">
        <header className="hero">
          <p className="eyebrow">Parent Page</p>
          <h1>{session === "expired" ? "Your Parent session expired" : "Unlock your Household"}</h1>
          <p>{session === "expired" ? "For your security, access ends after one hour. Enter your PIN to return to the page you were using." : "Enter your six-digit PIN to manage this Household. There is no forgotten-PIN or account recovery flow."}</p>
        </header>
        <form className="card form" noValidate onSubmit={unlock}>
          <div>
            <label htmlFor="parent-pin">Parent PIN</label>
            <input id="parent-pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="current-password" required aria-describedby="unlock-error" />
            <p id="unlock-error" className="field-error" role="alert">{error}</p>
          </div>
          <Button type="submit" disabled={unlockMutation.isPending}>{unlockMutation.isPending ? "Unlocking…" : "Unlock Household"}</Button>
        </form>
      </main>
    );
  }

  return (
    <div className="parent-layout">
      <aside className="parent-sidebar">
        <p className="brand">Kids Channels</p>
        <Navigation secret={secret} />
        <div className="sidebar-controls">
          <ThemeChoice id="theme-desktop" theme={theme} chooseTheme={chooseTheme} />
          <Button type="button" className="button-secondary" style={theme === "light" ? { color: "#20231f" } : undefined} disabled={lockMutation.isPending} onClick={() => void lock()}>{lockMutation.isPending ? "Locking…" : "Lock Parent Page"}</Button>
        </div>
      </aside>
      <header className="mobile-header">
        <span className="brand">Kids Channels</span>
        <details className="mobile-menu">
          <summary>Menu</summary>
          <div className="mobile-menu-panel">
            <Navigation secret={secret} closeOnNavigate />
            <div className="mobile-controls">
              <ThemeChoice id="theme-mobile" theme={theme} chooseTheme={chooseTheme} />
              <Button type="button" className="button-secondary" style={theme === "light" ? { color: "#20231f" } : undefined} disabled={lockMutation.isPending} onClick={() => void lock()}>{lockMutation.isPending ? "Locking…" : "Lock Parent Page"}</Button>
            </div>
          </div>
        </details>
      </header>
      <main id="main" className="parent-content">
        {lockError && <p className="field-error" role="alert">{lockError}</p>}
        {restartNotice && <aside className="restart-notice" aria-label="Stremio restart notice">
          <div><strong>Restart Stremio to see this change</strong><p>Fully close and reopen Stremio to refresh the Channel. Current playback is not interrupted.</p></div>
          <Button type="button" className="button-secondary compact-button" onClick={() => setRestartNotice(false)}>Dismiss</Button>
        </aside>}
        <div key={location.pathname}><Outlet /></div>
      </main>
    </div>
  );
}

function Navigation({ secret, closeOnNavigate = false }: { secret: string; closeOnNavigate?: boolean }) {
  function closeMenu(event: MouseEvent) {
    if (!closeOnNavigate) return;
    (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
  }
  return (
    <nav aria-label="Parent Page">
      <ul>
        {destinations.map((item) => (
          <li key={item.label}>
            <Link to={item.to} params={{ secret }} activeOptions={{ exact: "end" in item }} activeProps={{ "aria-current": "page" }} onClick={closeMenu}>{item.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ThemeChoice({ id, theme, chooseTheme }: { id: string; theme: Theme; chooseTheme: (theme: Theme) => void }) {
  return (
    <div className="theme-choice">
      <label htmlFor={id}>Theme</label>
      <select id={id} value={theme} onChange={(event) => chooseTheme(event.target.value as Theme)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}
