# First-playback feasibility evidence

## Run

- Date: 2026-07-24/25 UTC
- Issue: #6
- Deployment: `https://kids-channels.kfoenander98.workers.dev`
- Worker version initially deployed: `5e499577-c4c4-44b5-8d64-ac3caab8b9b7`
- Target provider: Household-configured hosted Torrentio/Real-Debrid endpoint
- Target client: desktop Stremio account synced to a non-4K Fire TV

No Household secret, Torrentio URL, Real-Debrid credential, provider response body, or signed media URL was retained in this evidence.

## Reproduction

1. Deploy the first-playback slice to Cloudflare Workers with its production D1 binding and `CONFIG_SECRET`.
2. Create and unlock a Household on the deployed Parent Page.
3. Enter the Household's configured HTTPS Torrentio manifest URL.
4. Observe provider validation from the deployed Worker.
5. In a local terminal outside Cloudflare, run the credential-safe probe documented in `docs/torrentio-contract-probe.md` with the identical URL.

## Observations

- The production Worker, D1 database, migrations, encrypted provider storage, and Parent Page deployed successfully.
- The Parent Page initially threw `TypeError: Cannot read properties of null (reading 'reset')` after provider submission. The provider request had completed, but the browser clears `event.currentTarget` after event dispatch. Retaining the form reference before the asynchronous request fixed this; a Playwright regression test covers the behavior.
- The external Node probe succeeded for the identical configured endpoint: the manifest was valid, 12 cached direct results were returned, and 8 were acceptable 1080p results for the representative title.
- The deployed Worker's request to the manifest received HTTP 403 with `server: cloudflare`, `content-type: text/html`, and no `cf-mitigated` challenge marker.
- Repeating the Worker request with the same `User-Agent` as the successful Node probe still produced `provider_failure`.
- Diagnostics logged only stage, status, and generic response-header classifications. Temporary diagnostics were removed after the run.

## Gate result

**Blocked before client playback.** Hosted Torrentio rejects Cloudflare Worker-originated requests. Because the Worker cannot retrieve provider JSON, desktop installation/sync, automatic 1080p selection, Fire TV playback, canonical resume, and subtitle association could not yet be evaluated.

This is a deployment/provider feasibility failure, not evidence for or against the Stremio client protocol behavior.

## Required redesign

ADR 0003 routes Torrentio manifest and stream JSON through an authenticated service deployed outside Cloudflare. The Worker and D1 remain authoritative for Household configuration and Channel state, and Real-Debrid media still flows directly to Stremio.

After the relay is deployed, repeat this run from step 3 and complete the outstanding desktop and Fire TV observations before closing #6 or beginning continuous scheduling in #7.
