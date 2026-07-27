# Kids Channels MVP

## Goal

Give children a parent-curated Stremio experience resembling traditional television: choose the TV Channel or Movie Channel, then receive the scheduled title without browsing the wider catalog. Stremio may require selecting the configured provider source when a programme changes.

The household rule—not technical restrictions—keeps children out of Stremio's other content.

## Household experience

- One Household shares Channel state across Stremio devices.
- The addon is configured and installed on desktop, then syncs through the same Stremio account to Fire TV.
- Stremio may show a detail page requiring one Play action if Fire TV cannot start directly from a Channel tile.
- Stremio may show its source screen at programme transitions; selecting the configured provider source is an accepted protocol-imposed action.
- Upcoming TV programmes may be visible and selectable. Selecting a distant programme skips bypassed programmes; the Parent can correct Show Progress.

## Parent Page

A Parent can:

- Create a Household and install its secret addon URL.
- Protect changes with a six-digit PIN.
- See guidance to install and configure a separate stream addon such as Comet in Stremio.
- Search Cinemeta for shows and movies.
- Manage the Approved Library.
- Choose a show's starting episode, defaulting to S01E01.
- See Current Programmes, recently played items, finished shows, and upcoming schedules.
- Correct Show Progress, undo advancement, restart or pause a show, reset movie rotation, and regenerate upcoming selections.
- Change the PIN after entering the current PIN.
- Permanently delete the Household and its state.

There is no account, discovery, recovery, or forgotten-PIN workflow.

## TV Channel

- Maintain a rolling Channel Schedule of approximately 20 programmes.
- Randomly choose an approved show other than the show just played.
- If only one show is approved, play its episodes consecutively.
- Play regular released episodes in order, excluding specials.
- Resume an interrupted Current Programme using Stremio's Viewing Progress.
- Advance Show Progress when Stremio requests the next scheduled programme, whether through autoplay or the Next action—not when playback starts.
- Continue indefinitely until stopped.
- Mark an exhausted show Finished and pause it until the Parent restarts, repositions, or removes it.
- Removing approved content immediately removes upcoming entries. A removed Current Programme may finish playing but cannot be launched again.

If installed stream addons return no results for the current episode, preserve Channel and Show Progress state. Provider availability and retries remain Stremio client concerns.

## Movie Channel

- Choose from a shuffled rotation so every approved movie is selected before one repeats.
- Insert newly approved movies randomly among the unplayed movies in the current rotation.
- Resume an interrupted Current Programme using Stremio's Viewing Progress.
- Do not automatically begin another movie.
- After a completed movie, play a short branded sign-off as the final scheduled item. Requesting the sign-off marks the movie consumed before playback stops.
- The Next action immediately selects another unplayed movie.

## Metadata and streaming

- Cinemeta supplies title search, canonical IMDb IDs, posters, seasons, and episodes.
- Canonical video IDs are preserved so Stremio can associate Viewing Progress and subtitle results.
- Expose Channels through standard Stremio `series` and `movie` types.
- Set the canonical Current Programme video ID as `behaviorHints.defaultVideoId`.
- Let Stremio request streams from separately installed addons on the playback device.
- Recommend configuring Comet for cached-only 1080p results, preferred release/language ordering, and as few results as practical.
- Kids Channels does not inspect, filter, rank, resolve, or proxy provider streams, and cannot select another addon's result or control Stremio's source screen.
- Subtitle preferences and stream-provider failures remain Stremio client concerns.

## Deployment and security

- Target Cloudflare Workers and D1 from the outset.
- Identify each Household with a long opaque random secret.
- Store only opaque Household identity in installation URLs.
- Never collect, return, or log stream-provider credentials.
- Rate-limit failed Parent PIN attempts.
- Real-Debrid media flows directly to Stremio, not through Cloudflare.

## Feasibility gate

Before polishing the Parent Page, prove on Fire TV that:

1. A Channel tile can start with no interaction beyond a protocol-imposed Play action.
2. A separately installed Comet addon limited to one cached 1080p result minimizes the source choice; a source prompt at programme transitions is accepted.
3. Canonical IDs preserve resume positions.
4. Next moves to a programme from another show, after source selection when required.
5. Natural completion selects the next programme from another show, though Stremio may wait for source selection.
6. Provider-owned `bingeGroup` behavior is an optional optimization, not an MVP gate.
7. Stremio caching does not prevent rolling schedule updates.
8. The movie sign-off marks completion and stops cleanly.
9. Reopening an interrupted programme resumes it.

The completed Fire TV gates and accepted protocol exceptions are documented in `first-playback-feasibility.md` and `continuous-tv-feasibility.md` before the remaining Parent Page is built.

## Deferred

- Viewing allowances and cooldown timers
- Weighted or favourite show selection
- Parent accounts and recovery
- Multiple independent profiles within a Household
- Provider-specific stream filtering or ordering
- Restricting access to Stremio's ordinary catalogs and addons
