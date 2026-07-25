# Continuous TV Fire TV feasibility evidence

## Run

- Date: 2026-07-25 UTC
- Issue: #8
- Deployment: `https://kids-channels.kfoenander98.workers.dev`
- Target client: desktop Stremio account synced to the household Fire TV
- Kids Channels manifest under test: v0.3.0 or later

No Household secret, provider credential, provider response body, signed media URL, or observed network address is retained in this evidence.

## Result so far

**Blocked on playable-stream `bingeGroup` behavior.**

The rolling cross-show Channel Schedule is visible on Fire TV and selecting a programme from another show reaches Stremio's source screen. Stremio does not automatically choose the installed Comet result.

Kids Channels cannot attach a useful `bingeGroup` to its empty observer response. The Stremio protocol defines `behaviorHints.bingeGroup` on each playable stream object. Stremio aggregates installed-addon responses in the client and does not let Kids Channels inspect or rewrite Comet's stream objects. The previously returned top-level `behaviorHints` object was not part of the stream-response protocol and has been removed.

Current Comet generates `comet|<service>|<info_hash>`. Because the torrent hash normally changes between episodes and shows, the selected stream and the next programme do not share a binge group. Configuring one result per resolution reduces the source list but does not make its group stable.

Server-side stream selection remains rejected by ADR 0004: resolving Comet through the Worker associated the result with Cloudflare's network identity and playback from Fire TV failed with `Wrong IP`.

## Protocol adjustment

A separately installed provider must return a stable group on the playable stream, such as provider + result class + resolution, rather than torrent identity. MediaFusion is a candidate because its current implementation emits a stable value derived from addon name, quality label, and resolution. It must be validated on the real Fire TV before replacing Comet in the MVP guidance.

Dynamic metadata and the observer stream response now explicitly return `Cache-Control: no-store`. This prevents HTTP caches from hiding a replenished schedule or suppressing observer requests. Stremio application-level behavior still requires the Fire TV checks below.

## Fire TV completion run

Before testing, remove and reinstall the Household addon so Stremio loads manifest v0.3.0's `stream` resource. Install only the provider under test, configured for cached 1080p results and one result per resolution.

Record pass/fail for each step without retaining private URLs or credentials:

1. Start the Current Programme, stop after enough playback for Stremio to save Viewing Progress, and reopen TV Channel. It must reopen the same canonical episode at the saved position; the shared Current Programme must not advance.
2. Press **Next**. The next scheduled programme must be from another show and start without a source screen.
3. Let that episode finish naturally. The following cross-show programme must start without a source screen.
4. Continue through at least five programmes. Each playable provider stream must expose the same stable `bingeGroup` class.
5. Reopen TV Channel and confirm the Current Programme moved forward and approximately twenty programmes remain visible. Confirm the Worker observer recorded advancement.
6. Trigger a Parent schedule change once issue #12's controls exist, then reopen TV Channel on Fire TV. The changed schedule must appear without reinstalling the addon.
7. On two household devices, request the same next programme as close together as possible. Reopen TV Channel on both and confirm one shared Current Programme with no duplicate advancement or schedule corruption.
8. Select a visible programme several entries ahead. It must play, become Current Programme, and treat every bypassed programme as skipped.

## Acceptance status

| Criterion | Status | Evidence |
| --- | --- | --- |
| Cross-show Next without source picker | Failed with Comet | Fire TV opened the source screen |
| Natural cross-show autoplay | Blocked | Requires a stable playable-stream group |
| Several automatic programmes | Blocked | Requires a stable playable-stream group |
| Interrupted Current Programme resumes | To revalidate | Canonical resume passed in issue #6; rolling schedule must not regress it |
| Replenishment and cache behavior | Partially proven | Deterministic Worker tests replenish to twenty; dynamic protocol responses are `no-store`; Fire TV and Parent-change checks remain |
| Shared two-device Current Programme | Partially proven | Concurrent Worker requests advance once; real two-device check remains |
| Distant visible programme skip | Partially proven | Worker protocol test passes; Fire TV check remains |
| Protocol adjustments documented | Passed | Playable provider owns `bingeGroup`; fake top-level hint removed; dynamic responses are not cacheable |

The gate must not be marked passed until a provider with a stable playable-stream `bingeGroup` completes the Fire TV run.
