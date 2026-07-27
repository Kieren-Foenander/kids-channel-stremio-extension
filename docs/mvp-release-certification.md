# Kids Channels MVP release certification

## Release candidate

- Issue: #16
- Commit: `b1132ae` (PR #32 merged)
- Production Worker: `https://kids-channels.kfoenander98.workers.dev`
- Cloudflare version uploaded: `77da9169-53d7-49a8-88d1-d501edf47d8b`
- Certification started: 2026-07-27 UTC

Do not record Household installation secrets, Parent PINs, provider credentials, provider response bodies, signed media URLs, or observed network addresses in this document.

## Automated and deployed-service checks

| Check | Status | Evidence |
| --- | --- | --- |
| TypeScript | Passed | `pnpm typecheck` |
| Worker integration, protocol, domain, concurrency, and security suite | Passed | `pnpm test`: 32 tests |
| Parent Page browser suite | Passed | `pnpm test:browser`: 3 tests |
| Production bundle validation | Passed | `pnpm exec wrangler deploy --dry-run` |
| Production D1 migrations | Passed | Migrations 0009–0012 applied; no migrations remain pending |
| Real Cinemeta probe | Passed | Production Parent API found canonical Bluey series `tt7678620` without retaining response data |
| Production Household lifecycle smoke test | Passed | Created an isolated Household, unlocked it, rotated its PIN, observed old-session invalidation, permanently deleted it, and confirmed Parent and addon routes returned 404 |

The Wrangler deployment uploaded version `77da9169-53d7-49a8-88d1-d501edf47d8b`, and the production lifecycle smoke test proved that version's unique Parent Page and lifecycle behavior are receiving traffic. Wrangler then exited non-zero while querying the account's Workers subdomain because that API request returned authentication error 10001. Resolve the local Wrangler OAuth permission before relying on a successful deploy command exit status for a future release; the release candidate itself is live.

## Previously completed Fire TV gates

- First playback, canonical Viewing Progress resume, subtitle identity, and client-side provider resolution: [`first-playback-feasibility.md`](first-playback-feasibility.md).
- Rolling TV Channel Schedule and accepted provider-source-selection/cache limitations: [`continuous-tv-feasibility.md`](continuous-tv-feasibility.md).
- Movie rotation and Android-compatible sign-off playback passed in issue #11 and PR #28.

## Final household acceptance run

Use a newly created disposable Household and a separately installed provider configured for cached 1080p results and as few results as practical. Install Kids Channels from desktop into the Stremio account synced to Fire TV. Never copy private installation or provider values into this document.

### Setup and Parent Page

- [ ] Create and unlock the Household on the production Parent Page.
- [ ] Search real Cinemeta and approve at least two released shows and at least two movies.
- [ ] Choose a non-default starting episode for one show.
- [ ] Install the secret addon URL from desktop and confirm both Channels sync to Fire TV.
- [ ] Confirm the Parent Page shows Current Programmes, recent playback, upcoming TV programmes, Finished shows, and movie rotation state.

### TV Channel

- [ ] Launch the Current Programme after any protocol-imposed Play and provider-source-selection actions.
- [ ] Stop midway, reopen the TV Channel, and confirm canonical Viewing Progress resumes.
- [ ] Press Next and confirm movement to another approved show.
- [ ] Let an episode finish and confirm movement to the next scheduled show after accepted source selection.
- [ ] Confirm approximately twenty programmes remain in the rolling Channel Schedule.
- [ ] Correct Show Progress, undo advancement, pause/restart a show, and regenerate upcoming selections from the Parent Page.
- [ ] Fully close and reopen Stremio and confirm Parent changes appear without reinstalling the addon.
- [ ] Select a distant visible programme and confirm bypassed programmes are treated as skipped.

### Movie Channel

- [ ] Launch and interrupt a movie, then confirm canonical Viewing Progress resumes.
- [ ] Press Next and confirm another unplayed movie is staged through the sign-off transition.
- [ ] Let a movie complete and confirm the five-second sign-off plays directly and stops cleanly.
- [ ] Reopen the Movie Channel and confirm the next unplayed movie is staged.
- [ ] Reset the movie rotation from the Parent Page and confirm all approved movies become eligible.

### Shared state and security

- [ ] Request the same next TV programme from two household devices as close together as possible; confirm one shared Current Programme with no duplicate advancement or schedule corruption.
- [ ] Trigger five incorrect PIN attempts and confirm only that Household/request origin is locked for 15 minutes.
- [ ] Rotate the PIN on production and confirm an older Parent session is rejected.
- [ ] Permanently delete the disposable Household and confirm its Parent Page and synced Stremio endpoints are unusable.

## Accepted MVP limitations

- Stremio may require one protocol-imposed Play action to launch a Channel.
- Stremio may require selection of the separately installed provider source when a programme changes.
- Kids Channels cannot inspect or select another installed addon's stream results.
- Parent changes update Worker state immediately, but Stremio may retain loaded metadata in memory; fully close and reopen Stremio after Approved Library, Show Progress, or schedule changes.
- The Household rule, rather than a technical restriction, keeps children in the two Channels.

## Release completion

After every unchecked acceptance item passes:

1. Record only non-sensitive observations and any newly accepted limitation here.
2. Confirm the deployment and setup instructions in [`../README.md`](../README.md) reproduce the accepted journey.
3. Tag the certified commit and publish the GitHub release.
4. Close issue #16, then close the umbrella PRD #1.
