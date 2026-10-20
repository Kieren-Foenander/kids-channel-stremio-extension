# Bound sourcing time on the playback request

A TV play request without a warmed selection previously ran full discovery, up to ten
cached-only inspections, and one download start inline. Each step has its own ten-second
provider timeout, so a slow TorBox or discovery provider could hold Stremio's request open
for minutes. Stremio shows an endless loading screen in that state and the viewer cannot
recover it.

Playback now gives sourcing a fixed budget: six seconds for a TV programme and twenty for
a movie. The selector receives the budget as a deadline. It starts no discovery or candidate
inspection after the deadline and shortens its waits to fit. A metadata wait cut short by
the deadline is not evidence against the candidate, so it is cleaned up without
quarantine. Three seconds after the budget, the Worker answers regardless of any
in-flight provider request. The unfinished work continues through
`ExecutionContext.waitUntil()` so a late selection is still stored, but no download URL is
requested for it.

When the budget expires, a TV programme follows the existing Unavailable Episode path:
holding media, deferral, and Preparation Run reconciliation. A movie returns 503 so a
retry can use the selection stored in the background. Alternate-hash failover on the
`/resolve` route uses the same deadline.

`PLAYBACK_SELECTION_BUDGET_MS` overrides the budget for both Channel Types.

Consequences:

- Playback depends more heavily on Preparation Runs. A TV episode that can only be sourced
  slowly is deferred for one programme instead of making the viewer wait.
- Cached-only movie sourcing that needs more than twenty seconds now requires a retry.
- The `selection_timed_out` playback event and the `deadlineReached` diagnostic distinguish
  budget expiry from a genuine lack of sources.

This refines the in-request selection behaviour of ADRs 0007, 0009, and 0012. Their
discovery, exact file matching, and failover rules are unchanged.
