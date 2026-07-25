# Continuous TV Fire TV feasibility evidence

## Run

- Date: 2026-07-25 UTC
- Issue: #8
- Deployment: `https://kids-channels.kfoenander98.workers.dev`
- Target client: desktop Stremio account synced to the household Fire TV
- Kids Channels manifest under test: v0.3.0 or later

No Household secret, provider credential, provider response body, signed media URL, or observed network address is retained in this evidence.

## Result

**Accepted with a documented protocol exception.**

The rolling cross-show Channel Schedule is visible on Fire TV and movement to a programme from another show works. At a programme transition, Stremio may open its source screen instead of automatically choosing the installed provider result. The Parent has accepted selecting the configured provider source at these transitions; Kids Channels will not introduce brittle client UI automation.

Kids Channels cannot attach a useful `bingeGroup` to its empty observer response. The Stremio protocol defines `behaviorHints.bingeGroup` on each playable stream object. Stremio aggregates installed-addon responses in the client and does not let Kids Channels inspect or rewrite Comet's stream objects. The previously returned top-level `behaviorHints` object was not part of the stream-response protocol and has been removed.

Current Comet generates `comet|<service>|<info_hash>`. Because the torrent hash normally changes between episodes and shows, the selected stream and the next programme do not share a binge group. Configuring one result per resolution reduces the source list but does not make its group stable.

Server-side stream selection remains rejected by ADR 0004: resolving Comet through the Worker associated the result with Cloudflare's network identity and playback from Fire TV failed with `Wrong IP`.

## Protocol adjustment

Automatic source selection is no longer an MVP requirement. The TV Channel chooses the canonical scheduled programme, while Stremio and separately installed providers own source presentation and selection. A stable provider-owned `bingeGroup` may reduce source prompts but is an optional enhancement rather than a release gate.

A timer that selects the first source cannot be implemented by a Stremio addon: addons return protocol data and cannot inspect another addon's results, delay and control the client UI, or simulate remote input. An Android Accessibility/ADB automation layer would be a separate, brittle client application and is intentionally out of scope.

Dynamic metadata and the observer stream response explicitly return `Cache-Control: no-store`. This prevents HTTP caches from hiding a replenished schedule or suppressing observer requests.

## Fire TV completion run

Before any follow-up testing, remove and reinstall the Household addon so Stremio loads manifest v0.3.1's `stream` resource. Configure the installed provider for cached 1080p results and as few results as practical.

Record pass/fail for each step without retaining private URLs or credentials:

1. Start the Current Programme, stop after enough playback for Stremio to save Viewing Progress, and reopen TV Channel. It must reopen the same canonical episode at the saved position; the shared Current Programme must not advance.
2. Press **Next**. The next scheduled programme must be from another show; select the configured provider source if Stremio opens its source screen.
3. Let that episode finish naturally. The following cross-show programme must be selected, with the same accepted source-selection step if required.
4. Continue through several programmes and confirm each transition selects the scheduled canonical programme.
5. Reopen TV Channel and confirm the Current Programme moved forward and approximately twenty programmes remain visible. Confirm the Worker observer recorded advancement.
6. Trigger a Parent schedule change once issue #12's controls exist, then reopen TV Channel on Fire TV. The changed schedule must appear without reinstalling the addon.
7. On two household devices, request the same next programme as close together as possible. Reopen TV Channel on both and confirm one shared Current Programme with no duplicate advancement or schedule corruption.
8. Select a visible programme several entries ahead. It must play, become Current Programme, and treat every bypassed programme as skipped.

## Acceptance status

| Criterion | Status | Evidence |
| --- | --- | --- |
| Cross-show Next without source picker | Accepted exception | Cross-show movement works; Fire TV may require provider-source selection |
| Natural cross-show autoplay | Accepted exception | Stremio may pause at provider-source selection before playback continues |
| Several automatic programmes | Removed from MVP | Continuous scheduling remains; unattended provider selection is not guaranteed |
| Interrupted Current Programme resumes | Supported | Canonical resume passed on Fire TV in issue #6 and canonical identity is unchanged |
| Replenishment and cache behavior | Supported with follow-up coverage | Worker tests replenish to twenty and dynamic protocol responses are `no-store`; Parent controls receive end-to-end coverage in issue #12 |
| Shared two-device Current Programme | Supported with follow-up coverage | Concurrent Worker requests advance exactly once; final household-device certification remains in issue #16 |
| Distant visible programme skip | Supported | Worker protocol test proves documented skip behavior; schedule remains visible on Fire TV |
| Protocol adjustments documented | Passed | Provider owns playable streams and `bingeGroup`; manual source selection is accepted; fake top-level hint was removed |

The continuous-TV protocol gate is complete. Remaining Parent controls and final end-to-end certification belong to issues #12 and #16 rather than blocking the MVP on unsupported cross-addon source automation.
