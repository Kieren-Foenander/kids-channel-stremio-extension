# Kids Channels MVP

## Goal

Give children a parent-curated Stremio experience resembling traditional television: choose a named TV Channel or Movie Channel, then receive its scheduled title without browsing the wider catalog or choosing a source.

The household rule—not technical restrictions—keeps children out of Stremio's other content.

## Household experience

- One Household contains up to five TV Channels and five Movie Channels, with persistent state for each Channel.
- Provision every Household with one TV and one Movie Default Channel; additional Channels are deliberately created and named by a Parent.
- Show every configured Channel as a named tile in one stable TV catalog row or one stable Movie catalog row, including Channels with no assigned programmes.
- Use the existing generic artwork for every Channel of a type; custom Channel artwork and colours are deferred.
- Expose every Household Channel through the same addon installation on every synced Stremio device; Channels are choices, not profiles or access controls.
- The addon is configured and installed on desktop, then syncs through the same Stremio account to Fire TV.
- Stremio may show a detail page requiring one Play action if Fire TV cannot start directly from a Channel tile.
- Kids Channels returns exactly one ready source at programme transitions, without exposing source selection.
- Upcoming TV programmes may be visible and selectable. Selecting a distant programme skips bypassed programmes; the Parent can correct Show Progress.
- With TorBox connected, automatically keep the next five scheduled programmes in each TV Channel prepared without a Parent action.

## Parent Page

A Parent can:

- Create a Household and install its secret addon URL.
- Protect changes with a six-digit PIN.
- Add and replace the Household's encrypted TorBox credential.
- Search Cinemeta for shows and movies.
- Approve a programme by assigning it to at least one compatible Channel, automatically using the sole compatible Channel or requiring a choice when several exist.
- Create a required Channel inline when approving a programme and no compatible Channel exists.
- Manage the Approved Library and edit Channel Assignments, removing a programme from the Household when its final assignment is removed.
- Remove a programme from the Household through a confirmed action that deletes all of its Channel Assignments at once.
- Create, rename, and delete Channels using trimmed names of 1–40 visible characters, without requiring unique names or manual ordering; a Channel's TV or Movie type cannot change.
- Preserve Channel creation order, disable creation after five Channels of that type, and explain that an existing Channel must be used or deleted before another can be created.
- Confirm Channel deletion with the affected assignments and programmes that will leave the Household; already-playing media may finish, but the deleted Channel cannot advance or reopen.
- Browse Channels through separate TV Channels and Movie Channels pages, with per-Channel state and controls kept off the main navigation.
- Choose independent starting Show Progress for each TV Channel Assignment, defaulting to S01E01.
- See Current Programmes, recently played items, finished shows, upcoming schedules, and five-programme preparation status independently for each Channel.
- See compact summaries for every configured Channel on the Household Overview, grouped by type and ordered by creation time.
- Correct Show Progress, undo advancement, restart or pause a show, reset movie rotation, and regenerate upcoming selections for one selected Channel at a time.
- Change the PIN after entering the current PIN.
- Permanently delete the Household and its state.

There is no account, discovery, recovery, or forgotten-PIN workflow.

## TV Channel

- Maintain an independent rolling Channel Schedule for each TV Channel beyond its five-programme preparation window.
- Randomly choose an assigned show other than the show just played.
- If only one show is assigned, play its episodes consecutively.
- Play regular released episodes in order, excluding specials.
- Resume an interrupted Current Programme using Stremio's Viewing Progress.
- Advance Show Progress when Stremio requests the next scheduled programme, whether through autoplay or the Next action—not when playback starts.
- Continue indefinitely until stopped.
- Mark an exhausted show Finished and pause it until the Parent restarts, repositions, or removes it.
- Removing approved content immediately removes upcoming entries. A removed Current Programme may finish playing but cannot be launched again.

If no acceptable cached stream exists, keep the best matching torrent downloading in TorBox, preserve the episode as Show Progress, and mark it unavailable for five minutes. Use a 40-second holding bumper that exposes Stremio's in-player Next control and offers a stable autoplay group for another eligible show. Reserve the unavailable episode directly after that intervening programme; play it if the download completed or defer it behind one more programme without starting a duplicate download. The five-minute marker protects unrelated schedule rebuilds during the initial download. Web Stremio may still return to the Channel detail when the bumper ends; Fire TV behavior remains a human gate. If every show is unavailable, stop after the terminal bumper.

## Movie Channel

- Maintain an independent shuffled rotation for each Movie Channel so every assigned movie is selected before one repeats.
- Insert newly assigned movies randomly among the unplayed movies in that Channel's current rotation.
- Resume an interrupted Current Programme using Stremio's Viewing Progress.
- Do not automatically begin another movie.
- After a completed movie, play a short branded sign-off as the final scheduled item. Requesting the sign-off marks the movie consumed before playback stops.
- The Next action immediately selects another unplayed movie.

## Metadata and streaming

- Cinemeta supplies title search, canonical IMDb IDs, posters, seasons, and episodes.
- Canonical video IDs are preserved so Stremio can associate Viewing Progress and subtitle results.
- Expose named Channels as ID-backed tiles through stable Stremio `series` and `movie` catalogs.
- Preserve the existing Default Channel metadata IDs and Parent Page links during migration; renaming keeps those identities, while deleting the migrated Channel retires them.
- Let configured empty Channels open without a playable programme rather than hiding or populating them automatically.
- Set the canonical Current Programme video ID as `behaviorHints.defaultVideoId`.
- Discover and rank candidates, prefer a TorBox-cached exact file match, and prepare one uncached series source when required.
- Redirect Stremio to a fresh TorBox download URL without proxying media through Cloudflare.
- Use one stable TV `bingeGroup` across programmes and unavailable-programme bumpers.
- Preserve canonical identities so subtitle selection and Viewing Progress remain Stremio concerns.

## Deployment and security

- Target Cloudflare Workers and D1 from the outset.
- Identify each Household with a long opaque random secret.
- Store only opaque Household identity in installation URLs.
- Encrypt each Household's TorBox credential at rest and never return or log it.
- Rate-limit failed Parent PIN attempts.
- TorBox media flows directly to Stremio, not through Cloudflare.

Parent changes do not require reinstalling the addon, but the Parent must fully restart Stremio before changed Channel catalogs or metadata are guaranteed to appear.

## Feasibility gate

Before polishing the Parent Page, prove on Fire TV that:

1. A Channel tile can start with no interaction beyond a protocol-imposed Play action.
2. Kids Channels returns exactly one ready source without a source choice.
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
