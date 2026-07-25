# First-playback feasibility evidence

## Run

- Date: 2026-07-24/25 UTC
- Issue: #6
- Deployment: `https://kids-channels.kfoenander98.workers.dev`
- Target client: desktop Stremio account synced to a non-4K Fire TV

No Household secret, provider URL, Real-Debrid credential, provider response body, signed media URL, or observed network address was retained in this evidence.

## Observations

- The production Worker, D1 database, migrations, Household installation, Cinemeta approval, and canonical episode metadata deployed successfully.
- The Parent Page initially threw `TypeError: Cannot read properties of null (reading 'reset')` after provider submission. Retaining the form reference before its asynchronous request fixed that obsolete server-provider flow.
- Hosted Torrentio rejected Cloudflare Worker-originated requests with HTTP 403 while the identical configured endpoint worked outside Cloudflare.
- Hosted Comet accepted Cloudflare egress and returned a cached 1080p Real-Debrid stream after Kids Channels recognized its `[RD⚡]` marker.
- Client playback then produced Comet's `Wrong IP` response: provider discovery had occurred under Cloudflare's cross-zone Worker network identity while playback came from the user's device.
- The same configured Comet service works when installed directly in Stremio. The failure is therefore caused by interposing the Worker, not by Comet or Real-Debrid configuration.

## Server-side provider gate result

**Failed.** A Cloudflare Worker cannot safely resolve IP-sensitive provider results on behalf of a Stremio playback client. Reachable provider JSON alone was an insufficient feasibility check.

A provider relay would retain the same identity mismatch, while proxying media through Comet would weaken the direct-media architecture. Provider configuration, encrypted storage, and Worker stream selection have therefore been removed.

## Client-side resolution redesign

ADR 0004 exposes TV Channel as a standard Stremio `series` catalog and metadata resource. Its sole video uses the canonical Cinemeta episode ID and is identified by `behaviorHints.defaultVideoId`. Kids Channels does not declare a `stream` resource. Stremio must ask separately installed addons such as Comet for that canonical ID from the playback device.

This preserves canonical resume and subtitle identity and keeps provider credentials and media outside Cloudflare. The protocol does not let Kids Channels inspect or select another addon's responses, so Comet should be configured for cached-only 1080p output with one result per resolution.

## Client gate result

**Passed with a documented protocol exception.** After removing the old addon, restarting Stremio, and installing manifest v0.2.0, the Channel appeared through the shared Stremio account and played successfully on the household Fire Stick. Stremio requested the canonical episode from the separately installed stream provider without the prior IP mismatch.

Initial playback required selecting the provider stream once. Reopening interrupted playback went directly into the episode and resumed at the saved position. Subtitle discovery matched the canonical episode. This proves that canonical identity supports client-side provider aggregation, Viewing Progress, and subtitles.

Kids Channels cannot satisfy the original requirement to choose another addon's stream automatically because the Stremio addon protocol does not expose installed-addon responses to other addons. The accepted redesign delegates that first stream choice to Stremio and removes server-side provider selection. Configuring Comet for a single cached 1080p result minimizes the choice without proxying provider or media traffic through Cloudflare.

The detail experience necessarily exposes the canonical current show and episode. With only Bluey approved in this slice, it therefore appears that Bluey itself was selected. Continuous rotation across approved shows and stronger Channel continuity belong to issue #7; Channel presentation must not replace the canonical video identity needed for providers, resume, and subtitles.
