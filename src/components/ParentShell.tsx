import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
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
  document.documentElement.dataset.theme = theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
}

export function ParentShell({ secret }: { secret: string }) {
  const location = useLocation();
  const [session, setSession] = useState<SessionState>("checking");
  const [error, setError] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [expiresIn, setExpiresIn] = useState(60 * 60);
  const wasAuthenticated = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("kids-channels-theme");
    const selected = stored === "light" || stored === "dark" ? stored : "system";
    setTheme(selected);
    applyTheme(selected);
  }, []);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      try {
        const response = await fetch(`/api/households/${secret}/session`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!active) return;
        if (response.ok) {
          const result = await response.json() as { expiresIn?: number };
          wasAuthenticated.current = true;
          setExpiresIn(Math.max(1, result.expiresIn ?? 60 * 60));
          setSession("authenticated");
        } else {
          setSession(wasAuthenticated.current ? "expired" : "locked");
        }
      } catch {
        if (active) {
          setSession(wasAuthenticated.current ? "expired" : "locked");
          setError("Parent access could not be checked. Try again.");
        }
      }
    }

    void checkSession();
    const onFocus = () => void checkSession();
    const onExpired = () => setSession("expired");
    window.addEventListener("focus", onFocus);
    window.addEventListener("parent-session-expired", onExpired);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("parent-session-expired", onExpired);
    };
  }, [secret]);

  useEffect(() => {
    if (session !== "authenticated") return;
    const timer = setTimeout(() => setSession("expired"), expiresIn * 1000);
    return () => clearTimeout(timer);
  }, [expiresIn, session]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsUnlocking(true);
    const form = event.currentTarget;
    const pin = new FormData(form).get("pin");
    try {
      const response = await fetch(`/api/households/${secret}/unlock`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setError(result.error || "The Parent Page could not be unlocked.");
        return;
      }
      form.reset();
      wasAuthenticated.current = true;
      setExpiresIn(60 * 60);
      setSession("authenticated");
    } catch {
      setError("Parent access is temporarily unavailable. Try again.");
    } finally {
      setIsUnlocking(false);
    }
  }

  async function lock() {
    await fetch(`/api/households/${secret}/lock`, { method: "POST", credentials: "same-origin" });
    wasAuthenticated.current = false;
    setSession("locked");
  }

  function chooseTheme(value: Theme) {
    setTheme(value);
    applyTheme(value);
    if (value === "system") localStorage.removeItem("kids-channels-theme");
    else localStorage.setItem("kids-channels-theme", value);
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
          <Button type="submit" disabled={isUnlocking}>{isUnlocking ? "Unlocking…" : "Unlock Household"}</Button>
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
          <Button type="button" className="button-secondary" onClick={() => void lock()}>Lock Parent Page</Button>
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
              <Button type="button" className="button-secondary" onClick={() => void lock()}>Lock Parent Page</Button>
            </div>
          </div>
        </details>
      </header>
      <main id="main" className="parent-content" key={location.pathname}><Outlet /></main>
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
