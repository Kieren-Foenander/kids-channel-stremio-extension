# Kids Channels

A parent-curated viewing experience that recreates the limited choice and continuous playback of a traditional television channel inside Stremio.

## Language

**Channel**:
A persistent household playback experience that chooses from approved content and continues without requiring a child to make further viewing choices.
_Avoid_: Extension, mode, playlist

**TV Channel**:
A Channel that randomly selects an approved show other than the show just played while preserving each show's episode order.
_Avoid_: Show mode, TV mode

**Movie Channel**:
A Channel that chooses from approved movies without repeating one until every approved movie has been chosen.
_Avoid_: Movie mode

**Approved Library**:
The parent-selected set of shows and movies from which the Channels may choose.
_Avoid_: Whitelist, collection, list

**Show Progress**:
The next regular released episode of an approved show that the TV Channel will schedule. It advances when the Channel moves to a later scheduled programme and can be corrected or reset by a Parent.
_Avoid_: Viewing Progress, watch history

**Viewing Progress**:
The playback position Stremio associates with a movie or episode, allowing an interrupted programme to resume from where it stopped.
_Avoid_: Show Progress

**Current Programme**:
The movie or episode that a Channel resumes until Stremio requests the next scheduled programme.
_Avoid_: Now playing, queue position

**Channel Schedule**:
The Current Programme followed by the upcoming programmes selected for continuous playback.
_Avoid_: Queue, playlist

**Preparation Run**:
A Parent-triggered, time-bounded background attempt to make programmes in the current Channel Schedule ready in Real-Debrid. It does not advance the Channel Schedule or Show Progress.
_Avoid_: Seeder, download queue, preload

**Unavailable Episode**:
An expected episode for which the configured stream provider cannot supply an acceptable cached stream. It remains the show's next episode while the TV Channel temporarily chooses another show.
_Avoid_: Skipped episode, missing episode

**Household**:
An isolated Channel configuration shared by the Parent's Stremio devices through one addon installation.
_Avoid_: Account, profile, tenant

**Parent Page**:
The PIN-protected website where a Parent configures the Household, manages the Approved Library, and corrects Channel state.
_Avoid_: Admin interface, configuration page

**Parent**:
The person who manages the Approved Library and corrects Channel state.
_Avoid_: Admin, user
