# Automatically warm the TV Channel Schedule

Kids Channels will automatically keep up to twenty programmes from the current Channel Schedule ready in TorBox. The Parent Page reports warm-up state but does not start, configure, or stop Preparation Runs.

Connecting or replacing TorBox and every TV schedule mutation trigger reconciliation through `ExecutionContext.waitUntil()`, keeping torrent work outside the response path. If the active run already represents the same schedule snapshot, it is reused. If the schedule has rolled forward or changed, the run is cancelled and replaced with a new twenty-programme snapshot. Existing TorBox downloads and valid D1 stream selections remain available to the replacement run.

Each run remains bounded to eight hours and uses the existing five-minute Workflow rounds. A cron trigger runs every fifteen minutes as a safety net. It selects configured Households that have no active run and at least one scheduled episode without a fresh ready selection, then starts another bounded run. Processing at most one hundred eligible Households per invocation prevents an unbounded scheduled event; households with a newly active run leave the eligible set so later invocations can progress through the remainder.

Consequences:

- The first schedule is warmed after TorBox is connected or an approved show creates a schedule.
- When playback advances the Channel, the newly appended twentieth episode is included in a replacement run automatically.
- Show Progress corrections, undo, regeneration, pause, resume, removal, and show approval also reconcile warm-up.
- Disconnecting TorBox stops the active run before clearing the encrypted credential and stream selections.
- A completed run is not permanently final: the cron starts a later run if a 24-hour selection expires or any scheduled episode is still not ready.
- Manual preparation POST and cancellation routes are removed; the authenticated GET status route remains for the Parent Page.

This supersedes the manual trigger, configurable count/window, and Parent cancellation portions of ADR 0008. ADR 0008's bounded Cloudflare Workflow execution model remains in force.
