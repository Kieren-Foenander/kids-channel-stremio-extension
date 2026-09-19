# Broaden TV source discovery while preserving exact playback identity

TV discovery searches Knaben for both the episode and its season, without requiring
that release titles include the show's premiere year. Before admitting a candidate,
leading bracketed release-group tags are ignored, and the normalized title before the
season marker must equal the canonical show title, optionally followed by a four-digit
year. A supplied year must match when the canonical premiere year is known; absent
canonical metadata imposes no year constraint. Explicit conflicting years,
similarly named shows, and other individual episodes are rejected. A season pack is
only a discovery candidate: its actual files must contain the exact requested episode.
Resolution labels such as `1920x1080` do not count as individual episode markers.
Zilean's IMDb-based discovery remains in place. Movie queries and their year checks
remain unchanged.

The selector batch-checks TorBox cache availability for up to 100 ranked, eligible
hashes. Reported cached candidates are inspected first, retaining deterministic quality
ranking within each group. At most ten cached-only creates are attempted. A failed or
stale cache lookup does not prevent the existing bounded inspection path from working;
every selected torrent still goes through create, file matching, and readiness checks.
Only one uncached TV download may be started per selection attempt, and it cannot use
a hash rejected earlier in that attempt. Movies remain cached-only.

An uncached TV torrent whose file metadata is not immediately available remains pending
for up to fifteen minutes from selection, checked by subsequent playback requests or
Preparation Run rounds. It occupies the existing episode selection slot, so retries
reuse it. `download_pending = 1`, `file_id = -1`, and an empty filename explicitly mean
that no file has been matched yet. Neither compatibility lookups nor resolution may
serve this state. Once metadata appears, exact episode matching must succeed before a
real file ID is stored or readiness is promoted. After matching, existing five-minute
no-progress handling applies to active downloads.

On an inspection after the metadata deadline, a torrent still lacking files is removed
locally and cleaned up remotely if unreferenced. Its hash is retried after fifteen
minutes instead of twenty-four hours. Definitive wrong-file and terminal failures keep
the existing twenty-four-hour cooldown. Transient status-request failures preserve
pending state rather than claiming the torrent is bad; the existing selection expiry
still bounds retained local state. Preparation checks metadata every five minutes.

Remote cleanup first checks for other selections referencing the same Household torrent,
including pending selections, so rejection or expiry of one episode does not delete a
season pack used by another. This is a best-effort reference check, not a transaction
with TorBox; a concurrent new remote allocation can still race cleanup.

Playback selection diagnostics report failed discovery searches, cache-lookup status,
cached candidate count, actual cache inspections, and rejection counts without including
credentials, magnet links, or download URLs. The Parent Page message distinguishes waiting for
files from downloading and describes exact-file rejections. The persisted preparation
item status and aggregate badge/count retain `downloading` for both states, preserving
the existing database status constraint and API contract; neither state counts as ready.

This refines ADRs 0007 and 0009's discovery, candidate inspection, and retry decisions.
ADR 0010's five-programme window, eight-hour run limit, and schedule/progress semantics
remain unchanged. No schema migration is required. Before rolling back to code that
predates the unmatched-file state, remove `stream_selections` rows with `file_id = -1`
so older code cannot interpret those rows as matched selections.
