# First-playback feasibility evidence

## Run

- Date: 2026-07-24/25 UTC
- Issue: #6
- Deployment: `https://kids-channels.kfoenander98.workers.dev`
- Worker version initially deployed: `5e499577-c4c4-44b5-8d64-ac3caab8b9b7`
- Recommended provider: Household-configured hosted Comet/Real-Debrid endpoint
- Target client: desktop Stremio account synced to a non-4K Fire TV

No Household secret, provider URL, Real-Debrid credential, provider response body, or signed media URL was retained in this evidence.

## Reproduction

1. Deploy the first-playback slice to Cloudflare Workers with its production D1 binding and `CONFIG_SECRET`.
2. Create and unlock a Household on the deployed Parent Page.
3. Enter the Household's configured HTTPS provider manifest URL.
4. Observe provider validation from the deployed Worker.
5. Outside Cloudflare, run the credential-safe probe documented in `docs/provider-contract-probe.md` with the identical URL.

## Observations

- The production Worker, D1 database, migrations, encrypted provider storage, and Parent Page deployed successfully.
- The Parent Page initially threw `TypeError: Cannot read properties of null (reading 'reset')` after provider submission. The provider request had completed, but the browser clears `event.currentTarget` after event dispatch. Retaining the form reference before the asynchronous request fixed this; a Playwright regression test covers the behavior.
- A configured Torrentio endpoint succeeded outside Cloudflare with 12 cached direct results and 8 acceptable 1080p results, but its manifest returned HTTP 403 to the deployed Worker. Matching the successful Node probe's `User-Agent` did not change the failure.
- A configured Comet endpoint returned a valid manifest and standard Stremio stream response both outside Cloudflare and from the deployed Worker.
- Comet marks cached Real-Debrid streams as `[RD⚡]` and uncached streams as `[RD⬇️]`; adding that distinction allowed production validation to select an acceptable cached 1080p stream.
- Diagnostics logged only stage, status, and generic response-header classifications. Temporary diagnostics were removed after the run.

## Provider gate result

**Passed with Comet.** Cloudflare can reach the configured Comet endpoint and identify an acceptable cached 1080p Real-Debrid result. No relay or direct Real-Debrid implementation is required.

ADR 0002 records Comet as the recommended MVP provider behind the generic stream-provider boundary. Torrentio response recognition remains supported, but hosted Torrentio is not usable from the current Cloudflare deployment.

## Client gate status

Desktop installation/sync, automatic Fire TV playback, canonical resume, and subtitle association remain to be observed. Continue the run by approving a show, installing the addon on the desktop Stremio account, and testing the synced non-4K Fire TV before closing #6 or beginning continuous scheduling in #7.
