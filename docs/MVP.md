# Kids Channels MVP

## Goal

Give children a parent-curated Stremio experience resembling traditional television: choose the TV Channel or Movie Channel, then watch without choosing a title or stream.

The household rule—not technical restrictions—keeps children out of Stremio's other content.

## Household experience

- One Household shares Channel state across Stremio devices.
- The addon is configured and installed on desktop, then syncs through the same Stremio account to Fire TV.
- Stremio may show a detail page requiring one Play action if Fire TV cannot start directly from a Channel tile.
- Upcoming TV programmes may be visible and selectable. Selecting a distant programme skips bypassed programmes; the Parent can correct Show Progress.

## Parent Page

A Parent can:

- Create a Household and install its secret addon URL.
- Protect changes with a six-digit PIN.
- enter and validate a configured Torrentio manifest URL.
- Search Cinemeta for shows and movies.
- Manage the Approved Library.
- Choose a show's starting episode, defaulting to S01E01.
- See Current Programmes, recently played items, failures, finished shows, and upcoming schedules.
- Correct Show Progress, undo advancement, restart or pause a show, reset movie rotation, and regenerate upcoming selections.
- Change the PIN after entering the current PIN.
- Permanently delete the Household and its credentials.

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

If an expected episode has no acceptable cached stream, leave it as the show's next episode and try other approved shows once each. If none are playable, preserve Channel state, report an error, and record the failures. Retry the episode when its show is selected later; the MVP has no timed retry scheduler.

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
- The Household's configured Torrentio endpoint is the first and only MVP stream provider.
- Torrentio remains behind an internal stream-provider boundary.
- Request only cached Real-Debrid results and return exactly one stream to Stremio.
- Trust the Parent's Torrentio quality and ordering configuration, choosing its first acceptable result. The initial target is 1080p Fire TV playback.
- Torrentio configuration controls release and language preferences; subtitle preferences remain Stremio's responsibility.
- If Torrentio itself fails, preserve the Current Programme and report the provider failure rather than advancing the schedule.

## Deployment and security

- Target Cloudflare Workers and D1 from the outset.
- Identify each Household with a long opaque random secret.
- Store only opaque Household identity in installation URLs.
- Encrypt the configured Torrentio URL using a Worker secret before storing it in D1.
- Never return or log Torrentio credentials.
- Rate-limit failed Parent PIN attempts.
- Real-Debrid media flows directly to Stremio, not through Cloudflare.

## Feasibility gate

Before polishing the Parent Page, prove on Fire TV that:

1. A Channel tile can start with no interaction beyond a protocol-imposed Play action.
2. A single selected Torrentio/Real-Debrid stream avoids the stream picker.
3. Canonical IDs preserve resume positions.
4. Next moves to a programme from another show.
5. Natural completion autoplays a programme from another show.
6. A stable `bingeGroup` preserves automatic stream selection.
7. Stremio caching does not prevent rolling schedule updates.
8. The movie sign-off marks completion and stops cleanly.
9. Reopening an interrupted programme resumes it.

Any failed criterion requires redesign before the remaining Parent Page is built.

## Deferred

- Viewing allowances and cooldown timers
- Weighted or favourite show selection
- Parent accounts and recovery
- Multiple independent profiles within a Household
- Additional stream providers
- Advanced stream filtering beyond configured Torrentio ordering
- Restricting access to Stremio's ordinary catalogs and addons
