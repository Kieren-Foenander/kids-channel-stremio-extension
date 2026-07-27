import { useState } from "react";
import { Button } from "./Button";

type CopyTarget = "manifest" | "parent";

export function InstallationDetails({ secret, numbered = false }: { secret: string; numbered?: boolean }) {
  const [status, setStatus] = useState("");
  const origin = window.location.origin;
  const manifestUrl = `${origin}/addons/${secret}/manifest.json`;
  const parentUrl = `${origin}/households/${secret}`;
  const installUrl = `stremio://${manifestUrl.replace(/^https?:\/\//, "")}`;

  async function copy(value: string, target: CopyTarget) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(target === "manifest" ? "Manifest URL copied." : "Private Parent Page URL copied.");
    } catch {
      setStatus("Copy failed. Select and copy the URL shown below.");
    }
  }

  return (
    <>
      <div className="onboarding-grid installation-grid">
        <section className="card step" aria-labelledby="install-heading">
          {numbered && <span className="step-number" aria-hidden="true">1</span>}
          <h2 id="install-heading">Install in Stremio</h2>
          <p>On a desktop, sign in to the Stremio account used by your Household devices, then open the installer.</p>
          <p className="mobile-guidance"><strong>Using a phone?</strong> Complete installation on desktop. Mobile browsers may not open Stremio correctly.</p>
          <a className="button" href={installUrl} onClick={() => setStatus("Opening Stremio. Complete installation there; this page cannot verify success.")}>Install in Stremio</a>
          <p className="truthful-note">Opening Stremio does not prove installation succeeded. Confirm the addon inside Stremio.</p>
        </section>

        <section className="card step" aria-labelledby="fallback-heading">
          {numbered && <span className="step-number" aria-hidden="true">2</span>}
          <h2 id="fallback-heading">Manifest URL</h2>
          <p>If the installer does not open, copy this manifest URL into Stremio on desktop.</p>
          <code className="url-value">{manifestUrl}</code>
          <Button type="button" className="button-secondary" onClick={() => void copy(manifestUrl, "manifest")}>Copy manifest URL</Button>
        </section>

        <section className="card step" aria-labelledby="return-heading">
          {numbered && <span className="step-number" aria-hidden="true">3</span>}
          <h2 id="return-heading">Private Parent Page URL</h2>
          <p>Bookmark this private URL. It is the only way back to your Household and cannot be recovered.</p>
          <code className="url-value">{parentUrl}</code>
          <Button type="button" className="button-secondary" onClick={() => void copy(parentUrl, "parent")}>Copy Parent Page URL</Button>
          {numbered && <a className="text-link" href={parentUrl}>Continue to Parent Page</a>}
        </section>
      </div>
      <p className="action-status" role="status" aria-live="polite">{status}</p>
    </>
  );
}
