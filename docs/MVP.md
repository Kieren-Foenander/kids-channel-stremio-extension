# Kids Channels MVP

## Goal

Give children a parent-curated Stremio experience resembling traditional television: choose the TV Channel or Movie Channel, then receive the scheduled title without browsing the wider catalog or choosing a source.

The household rule—not technical restrictions—keeps children out of Stremio's other content.

## Household experience

- One Household shares Channel state across Stremio devices.
- The addon is configured and installed on desktop, then syncs through the same Stremio account to Fire TV.
- Stremio may show a detail page requiring one Play action if Fire TV cannot start directly from a Channel tile.
- Kids Channels returns exactly one cached source at programme transitions.
- Upcoming TV programmes may be visible and selectable. Selecting a distant programme skips bypassed programmes; the Parent can correct Show Progress.

## Parent Page

A Parent can:

- Create a Household and install its secret addon URL.
- Protect changes with a six-digit PIN.
- Add and replace the Household's encrypted Real-Debrid credential.
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

If no acceptable cached stream exists, preserve the episode as Show Progress, defer it for six hours, and use a 40-second holding bumper that exposes Stremio's in-player Next control and offers a stable autoplay group for another eligible show. Web Stremio may still return to the Channel detail when the bumper ends; Fire TV behavior remains a human gate. If every show is unavailable, stop after the terminal bumper.

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
- Discover candidates, verify Real-Debrid cache availability, and return exactly one deterministically selected stream.
- Redirect Stremio to a fresh Real-Debrid download URL without proxying media through Cloudflare.
- Use one stable TV `bingeGroup` across programmes and unavailable-programme bumpers.
- Preserve canonical identities so subtitle selection and Viewing Progress remain Stremio concerns.

## Deployment and security

- Target Cloudflare Workers and D1 from the outset.
- Identify each Household with a long opaque random secret.
- Store only opaque Household identity in installation URLs.
- Encrypt each Household's Real-Debrid credential at rest and never return or log it.
- Rate-limit failed Parent PIN attempts.
- Real-Debrid media flows directly to Stremio, not through Cloudflare.

## Feasibility gate

Before polishing the Parent Page, prove on Fire TV that:

1. A Channel tile can start with no interaction beyond a protocol-imposed Play action.
2. Kids Channels returns exactly one cached source without a source choice.
3. Canonical IDs preserve resume positions.
4. Next moves to a programme from another show.
5. Natural completion autoplays the next programme from another show.
6. An Unavailable Episode remains Show Progress while a bumper autoplays another show.
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
