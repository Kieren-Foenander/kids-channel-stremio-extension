# Automatically warm the TV Channel Schedule

Kids Channels will automatically keep the next five programmes from each TV Channel's current Channel Schedule ready in TorBox. Deployed usage showed that twenty programmes was unnecessary; replenishing the preparation window whenever playback advances keeps five programmes ahead while bounding the multiplied work from multiple TV Channels. The Parent Page reports warm-up state per TV Channel and in aggregate on the TV Channels page, but does not start, configure, or stop Preparation Runs.

Connecting or replacing TorBox and every TV schedule mutation trigger Household preparation reconciliation through `ExecutionContext.waitUntil()`, keeping torrent work outside the response path. One active Preparation Run represents a breadth-first snapshot containing up to five positions from every TV Channel, for at most twenty-five positions per Household. If an active run already represents that combined snapshot, it is reused; if any included schedule rolls forward or changes, the run is cancelled and replaced. Existing TorBox downloads and valid D1 stream selections remain available to the replacement run.

Each run remains bounded to eight hours. Retries are scheduled per item: active downloads stay at five minutes, the first three unsuccessful source searches use five minutes, attempts four through seven use fifteen minutes, and later attempts use thirty minutes. Each Workflow round loads only unfinished items whose `next_attempt_at` is due, and sleeps until the earliest item is eligible. The Preparation snapshot stores the canonical show identity needed by the stream selector, avoiding repeated episode-to-show discovery queries. It also creates only the number of five-item Workflow batches the snapshot needs.

A cron trigger runs every fifteen minutes as a safety net. It selects configured Households that have no active run and at least one scheduled episode without a fresh ready selection, then starts another bounded run. Processing at most one hundred eligible Households per invocation prevents an unbounded scheduled event; households with a newly active run leave the eligible set so later invocations can progress through the remainder.

When several TV Channels need preparation, the Household run proceeds breadth-first across their schedules: the first programme of every Channel is considered before the second programme of any Channel, continuing by schedule position through each five-programme window. Household-wide stream selections remain reusable when Channels schedule the same canonical episode. This favours immediate readiness for every Channel over deeply preparing one Channel while another cannot start, while retaining a single durable and idempotent orchestration boundary per Household.

Consequences:

- The first schedule is warmed after TorBox is connected or an approved show creates a schedule.
- When playback advances a TV Channel, the newly exposed edge of its five-programme preparation window is included in a replacement run automatically.
- Show Progress corrections, undo, regeneration, pause, resume, removal, and show approval also reconcile warm-up.
- Disconnecting TorBox stops the active run before clearing the encrypted credential and stream selections.
- A completed run is not permanently final: the cron starts a later run if a 24-hour selection expires or any scheduled episode is still not ready.
- Manual preparation POST and cancellation routes are removed; the authenticated GET status route remains for the Parent Page.

This supersedes the manual trigger, configurable count/window, twenty-item snapshot size, and Parent cancellation portions of ADR 0008. ADR 0008's bounded Cloudflare Workflow execution model remains in force.
