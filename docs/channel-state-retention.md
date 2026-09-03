# Channel state retention

Retention runs once each day at 03:00 UTC, independently from the fifteen-minute automatic TV
preparation reconciliation. It walks the complete Household primary-key range in batches of at most
90 Households. Each SQL statement therefore stays below D1's 100 bound-parameter limit and deletes
at most 500 rows from one table per Household batch. A run-local cursor prevents concurrent or
duplicate cron delivery from making one sweep skip Households. The legacy single-batch function and
persisted cursor remain available for bounded manual use, but the scheduled handler does not use them.

This maintenance is garbage collection, not Channel scheduling. In particular, the Movie rotation
query removes entries from cycles older than each Channel's current cycle; it never removes the
current rotation. The new `(household_id, channel_id, cycle)` index lets D1 seek directly into the
Households being cleaned instead of rereading the complete Movie rotation table. Running that query
daily instead of every fifteen minutes also reduces its idle executions from 96 to one per day.

Retention bounds are stated per Channel where the state itself is per Channel. A Household holding
the maximum five TV and five Movie Channels therefore retains ten times the per-Channel history of a
Household with one of each.

| State | Retention rule | Safety reason |
| --- | --- | --- |
| TV advancement claims | 24 hours; always keep the claim for the latest undoable advancement | Protects in-flight/stale requests and the supported undo action |
| Movie advancement claims | 24 hours | Requests complete in seconds; the grace period protects in-flight work |
| Movie mutation claims | 24 hours | Ownership is needed only by an active mutation batch |
| TV playback/advancement history | Latest 10 per Channel, plus each Channel's latest undoable advancement | The Parent Page displays 10 and undo must remain available independently per Channel |
| Movie playback history | Latest 10 per Channel | The Parent Page displays 10 snapshot titles per Channel |
| Movie rotations | Current cycle per Channel only | Playback history snapshots retain the visible historical information |
| TV Preparation Runs | Latest 10 per Household; never delete queued/running runs | Preserves recent operational context for the Household coordinator Workflow |
| Stream selections | Until `stale_at` | Expired selections cannot be used for playback |
| Stream candidate failures | Until `retry_at` | Expired quarantines must no longer suppress a candidate |
| Unavailable Episodes | Until `retry_at` | Expired deferrals must no longer block scheduling |

Every non-empty sweep logs structured per-table deletion counts. The separate cron routes mean a
retention failure cannot prevent automatic TV preparation, and a preparation failure cannot prevent
the daily cleanup.
