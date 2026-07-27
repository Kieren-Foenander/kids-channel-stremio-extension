import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";

export const Route = createFileRoute("/households/$secret/onboarding")({ component: OnboardingPage });

type CopyTarget = "manifest" | "parent";

function OnboardingPage() {
  const { secret } = Route.useParams();
  const [status, setStatus] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const origin = window.location.origin;
  const manifestUrl = `${origin}/addons/${secret}/manifest.json`;
  const parentUrl = `${origin}/households/${secret}`;
  const installUrl = `stremio://${manifestUrl.replace(/^https?:\/\//, "")}`;

  useEffect(() => {
    let active = true;
    void fetch(`/api/households/${secret}/session`, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error("session unavailable");
        if (active) setSessionReady(true);
      })
      .catch(() => {
        if (active) setStatus("Your Parent session could not be confirmed. Return to creation and try again.");
      });
    return () => { active = false; };
  }, [secret]);

  async function copy(value: string, target: CopyTarget) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(target === "manifest" ? "Manifest URL copied." : "Private Parent Page URL copied.");
    } catch {
      setStatus("Copy failed. Select and copy the URL shown below.");
    }
  }

  return (
    <main id="main" className="page-shell page-shell-wide">
      <header className="hero">
        <p className="eyebrow">Household created</p>
        <h1>Save your details, then install</h1>
        <p>Your Parent session is ready. You do not need to enter your PIN again.</p>
        <span className="session-state" role="status">{sessionReady ? "Parent session confirmed for one hour." : "Confirming secure Parent session…"}</span>
      </header>

      <section className="warning warning-strong" aria-labelledby="save-heading">
        <h2 id="save-heading">Save both private details now</h2>
        <p>Neither your six-digit PIN nor your private Household URL can be recovered. Store the PIN safely and bookmark the Parent Page URL.</p>
      </section>

      <div className="onboarding-grid">
        <section className="card step" aria-labelledby="install-heading">
          <span className="step-number" aria-hidden="true">1</span>
          <h2 id="install-heading">Install in Stremio</h2>
          <p>On a desktop, sign in to the Stremio account used by your Household devices, then open the installer.</p>
          <p className="mobile-guidance"><strong>Using a phone?</strong> Complete installation on desktop. Mobile browsers may not open Stremio correctly.</p>
          <a className="button" href={installUrl} onClick={() => setStatus("Opening Stremio. Complete installation there; this page cannot verify success.")}>Install in Stremio</a>
          <p className="truthful-note">Opening Stremio does not prove installation succeeded. Confirm the addon inside Stremio.</p>
        </section>

        <section className="card step" aria-labelledby="fallback-heading">
          <span className="step-number" aria-hidden="true">2</span>
          <h2 id="fallback-heading">Keep a fallback</h2>
          <p>If the installer does not open, copy this manifest URL into Stremio on desktop.</p>
          <code className="url-value">{manifestUrl}</code>
          <Button type="button" className="button-secondary" onClick={() => void copy(manifestUrl, "manifest")}>Copy manifest URL</Button>
        </section>

        <section className="card step" aria-labelledby="return-heading">
          <span className="step-number" aria-hidden="true">3</span>
          <h2 id="return-heading">Bookmark the Parent Page</h2>
          <p>This private URL is the only way back to your Household.</p>
          <code className="url-value">{parentUrl}</code>
          <Button type="button" className="button-secondary" onClick={() => void copy(parentUrl, "parent")}>Copy Parent Page URL</Button>
          <a className="text-link" href={parentUrl}>Continue to Parent Page</a>
        </section>
      </div>
      <p className="action-status" role="status" aria-live="polite">{status}</p>
    </main>
  );
}
