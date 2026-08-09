# Channel state retention

The fifteen-minute scheduled Worker event sweeps at most 90 Households at a time. This stays below
the D1 limit of 100 bound parameters after timestamp and row-cap parameters are included. A persisted
cursor walks the Household primary key, wraps after the final Household, and caps each table at
500 deleted rows per sweep. Cleanup therefore does not scan every Household during a request and
large backlogs drain over repeated scheduled events.

| State | Retention rule | Safety reason |
| --- | --- | --- |
| TV advancement claims | 24 hours; always keep the claim for the latest undoable advancement | Protects in-flight/stale requests and the supported undo action |
| Movie advancement claims | 24 hours | Requests complete in seconds; the grace period protects in-flight work |
| Movie mutation claims | 24 hours | Ownership is needed only by an active mutation batch |
| TV playback/advancement history | Latest 10 per Household, plus the latest undoable advancement | The Parent Page displays 10 and undo must remain available |
| Movie playback history | Latest 10 per Household | The Parent Page displays 10 snapshot titles |
| Movie rotations | Current cycle only | Playback history snapshots retain the visible historical information |
| TV Preparation Runs | Latest 10 per Household; never delete queued/running runs | Preserves recent operational context and active Workflow state |
| Stream selections | Until `stale_at` | Expired selections cannot be used for playback |
| Stream candidate failures | Until `retry_at` | Expired quarantines must no longer suppress a candidate |
| Unavailable Episodes | Until `retry_at` | Expired deferrals must no longer block scheduling |

Every non-empty sweep logs structured per-table deletion counts. Failures are logged independently
from automatic TV preparation so one scheduled maintenance task cannot prevent the other.
