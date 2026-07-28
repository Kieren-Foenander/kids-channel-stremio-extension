import { useState, type ReactNode } from "react";
import { Button, buttonVariants } from "./ui/button";

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
      <div className="grid divide-y overflow-hidden rounded-[4px] border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
        <Step number={numbered ? "01" : null} heading="Install in Stremio" headingId="install-heading">
          <p className="text-sm leading-relaxed text-muted-foreground">On a desktop, sign in to the Stremio account used by your Household devices, then open the installer.</p>
          <p className="rounded-[3px] bg-muted p-3 text-sm leading-relaxed"><strong className="font-semibold">Using a phone?</strong> Complete installation on desktop. Mobile browsers may not open Stremio correctly.</p>
          <a className={buttonVariants({ className: "mt-auto w-full" })} href={installUrl} onClick={() => setStatus("Opening Stremio. Complete installation there; this page cannot verify success.")}>Install in Stremio</a>
          <p className="text-xs leading-relaxed text-muted-foreground">Opening Stremio does not prove installation succeeded. Confirm the addon inside Stremio.</p>
        </Step>

        <Step number={numbered ? "02" : null} heading="Manifest URL" headingId="fallback-heading">
          <p className="text-sm leading-relaxed text-muted-foreground">If the installer does not open, copy this manifest URL into Stremio on desktop.</p>
          <code className="block rounded-[3px] bg-muted p-2.5 font-mono text-xs leading-relaxed break-all select-all">{manifestUrl}</code>
          <Button type="button" variant="outline" className="mt-auto w-full" onClick={() => void copy(manifestUrl, "manifest")}>Copy manifest URL</Button>
        </Step>

        <Step number={numbered ? "03" : null} heading="Private Parent Page URL" headingId="return-heading">
          <p className="text-sm leading-relaxed text-muted-foreground">Bookmark this private URL. It is the only way back to your Household and cannot be recovered.</p>
          <code className="block rounded-[3px] bg-muted p-2.5 font-mono text-xs leading-relaxed break-all select-all">{parentUrl}</code>
          <Button type="button" variant="outline" className="mt-auto w-full" onClick={() => void copy(parentUrl, "parent")}>Copy Parent Page URL</Button>
          {numbered && <a className="w-fit font-medium text-accent underline-offset-4 hover:underline" href={parentUrl}>Continue to Parent Page</a>}
        </Step>
      </div>
      <p className="mt-4 min-h-5 text-sm font-medium text-accent" role="status" aria-live="polite">{status}</p>
    </>
  );
}

function Step({ number, heading, headingId, children }: { number: string | null; heading: string; headingId: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 p-5" aria-labelledby={headingId}>
      {number && <span className="font-mono text-sm font-bold text-signal" aria-hidden="true">{number}</span>}
      <h2 id={headingId} className="text-base font-semibold">{heading}</h2>
      {children}
    </section>
  );
}
