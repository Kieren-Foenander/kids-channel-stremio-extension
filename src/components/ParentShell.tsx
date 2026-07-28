import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { ParentApiError, parentApi, parentKeys } from "../lib/parent-api";
import { Ident } from "./Ident";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

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

const navLinkClasses = "relative block rounded-[3px] px-3 py-2 text-sm font-medium text-muted-foreground transition-colors before:absolute before:top-1/2 before:left-0 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent hover:bg-muted hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=page]:before:bg-signal";

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && systemIsDark);
  document.documentElement.classList.toggle("dark", isDark);
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
      <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16">
        <Ident className="mb-3">Kids Channels</Ident>
        <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">Household deleted</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">The Household, all Channel state, Parent access, and synced addon access have been permanently removed.</p>
        <a className={buttonVariants({ size: "lg", className: "mt-6 w-fit" })} href="/">Create a new Household</a>
      </main>
    );
  }

  if (session === "checking") {
    return (
      <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16" aria-busy="true">
        <Ident className="mb-3">Parent Page</Ident>
        <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">Checking secure access…</h1>
      </main>
    );
  }

  if (session !== "authenticated") {
    return (
      <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16">
        <header className="mb-8">
          <Ident className="mb-3">Parent Page</Ident>
          <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
            {session === "expired" ? "Your Parent session expired" : "Unlock your Household"}
          </h1>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            {session === "expired"
              ? "For your security, access ends after one hour. Enter your PIN to return to the page you were using."
              : "Enter your six-digit PIN to manage this Household. There is no forgotten-PIN or account recovery flow."}
          </p>
        </header>
        <form className="grid gap-5 rounded-[4px] border bg-card p-6" noValidate onSubmit={unlock}>
          <div>
            <label htmlFor="parent-pin" className="text-sm font-semibold">Parent PIN</label>
            <Input id="parent-pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="current-password" required aria-describedby="unlock-error" className="mt-2 h-12 font-mono text-xl tracking-[0.3em]" />
            <p id="unlock-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{error}</p>
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={unlockMutation.isPending}>
            {unlockMutation.isPending ? "Unlocking…" : "Unlock Household"}
          </Button>
        </form>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <aside data-slot="parent-sidebar" className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-background py-6 min-[801px]:flex">
        <Brand className="px-4" />
        <div className="mt-8 flex-1 px-3">
          <Navigation secret={secret} />
        </div>
        <div className="mt-6 grid gap-4 px-4">
          <ThemeChoice id="theme-desktop" theme={theme} chooseTheme={chooseTheme} />
          <Button type="button" variant="outline" className="w-full" disabled={lockMutation.isPending} onClick={() => void lock()}>
            {lockMutation.isPending ? "Locking…" : "Lock Parent Page"}
          </Button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background px-4 min-[801px]:hidden">
        <Brand />
        <details className="relative">
          <summary className="flex h-9 cursor-pointer list-none items-center rounded-[3px] border border-input px-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">Menu</summary>
          <div data-slot="mobile-menu-panel" className="absolute top-11 right-0 grid max-h-[calc(100vh-5rem)] w-64 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto rounded-[4px] border bg-popover p-4 shadow-xl">
            <Navigation secret={secret} closeOnNavigate />
            <div className="grid gap-4 border-t pt-4">
              <ThemeChoice id="theme-mobile" theme={theme} chooseTheme={chooseTheme} />
              <Button type="button" variant="outline" className="w-full" disabled={lockMutation.isPending} onClick={() => void lock()}>
                {lockMutation.isPending ? "Locking…" : "Lock Parent Page"}
              </Button>
            </div>
          </div>
        </details>
      </header>

      <main id="main" className="min-[801px]:pl-60">
        <div className="mx-auto w-full max-w-4xl px-4 py-8 min-[801px]:px-10 min-[801px]:py-12">
          {lockError && <p className="mb-4 text-sm font-medium text-destructive" role="alert">{lockError}</p>}
          {restartNotice && (
            <aside className="mb-8 flex flex-col gap-3 rounded-[4px] border border-warning-border bg-warning-bg p-4 text-warning-text sm:flex-row sm:items-center sm:justify-between" aria-label="Stremio restart notice">
              <div>
                <strong className="text-sm font-semibold">Restart Stremio to see this change</strong>
                <p className="mt-1 text-sm leading-relaxed">Fully close and reopen Stremio to refresh the Channel. Current playback is not interrupted.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setRestartNotice(false)}>Dismiss</Button>
            </aside>
          )}
          <div key={location.pathname}><Outlet /></div>
        </div>
      </main>
    </div>
  );
}

function Brand({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-center gap-2 text-[0.95rem] font-bold tracking-[-0.01em] ${className}`}>
      <span className="size-2.5 rounded-[2px] bg-signal" aria-hidden="true" />
      Kids Channels
    </p>
  );
}

function Navigation({ secret, closeOnNavigate = false }: { secret: string; closeOnNavigate?: boolean }) {
  function closeMenu(event: MouseEvent) {
    if (!closeOnNavigate) return;
    (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
  }
  return (
    <nav aria-label="Parent Page">
      <ul className="grid gap-0.5">
        {destinations.map((item) => (
          <li key={item.label}>
            <Link to={item.to} params={{ secret }} activeOptions={{ exact: "end" in item }} activeProps={{ "aria-current": "page" }} onClick={closeMenu} className={navLinkClasses}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ThemeChoice({ id, theme, chooseTheme }: { id: string; theme: Theme; chooseTheme: (theme: Theme) => void }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-muted-foreground">Theme</label>
      <NativeSelect id={id} value={theme} onChange={(event) => chooseTheme(event.target.value as Theme)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </NativeSelect>
    </div>
  );
}
