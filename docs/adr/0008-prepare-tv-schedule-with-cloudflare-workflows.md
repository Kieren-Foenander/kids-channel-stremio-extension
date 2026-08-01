# Prepare the TV Channel Schedule with Cloudflare Workflows

Kids Channels will let a Parent manually start a time-bounded Preparation Run for up to twenty programmes in the current Channel Schedule. The run snapshots those programmes, uses the Household's existing Real-Debrid credential to add and monitor torrent candidates, and continues in a Cloudflare Workflow after the Parent closes the page. It does not advance the Channel Schedule or Show Progress.

Each five-minute round processes unfinished episodes sequentially in batches of at most five and permits the existing stream selector to inspect at most one new candidate per episode. The small Workflow steps stay below Worker subrequest limits while the complete eight-hour run remains within Workflow step limits. Existing pending selections are checked first. A progressing torrent remains in Real-Debrid; a stalled or terminal torrent follows the existing quarantine and cleanup rules so a later round can try the next ranked source. The run ends early when all items are ready, or marks unfinished items unavailable when its one-, four-, or eight-hour window expires.

The Parent Page is the only place that can start or stop a run. It warns the Parent not to use the same Real-Debrid account from another connection while preparation is active, reports per-programme state, and permits one active run per Household. Stopping prevents further work but deliberately leaves already-added Real-Debrid jobs intact.

Consequences:

- Cloudflare initiates torrent operations; the Household does not seed torrent data in this version.
- Workflow state contains Household and run identifiers, never the decrypted Real-Debrid credential.
- D1 is the source of truth for run progress, so status survives page closure and Workflow sleeps.
- Work is rate-shaped across rounds instead of multiplying every scheduled programme by every candidate in one request.
- A run prepares the schedule snapshot that existed when it started; later schedule changes do not silently change its scope.
- Successfully prepared stream selections use the existing 24-hour lifetime and can be consumed by normal Stremio playback.
