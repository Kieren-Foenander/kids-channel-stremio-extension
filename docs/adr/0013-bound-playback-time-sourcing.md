# Bound sourcing time on the playback request

A TV play request without a warmed selection previously ran full discovery, up to ten
cached-only inspections, and one download start inline. Each step has its own ten-second
provider timeout, so a slow TorBox or discovery provider could hold Stremio's request open
for minutes. Stremio shows an endless loading screen in that state and the viewer cannot
recover it.

Playback now gives sourcing a fixed budget: six seconds for a TV programme and twenty for
a movie. The selector receives the budget as a deadline. It starts no discovery or candidate
inspection after the deadline. Discovery, cache lookup, and torrent status requests are
shortened to end by the deadline; polling stops there and leaves the torrent pending. A
metadata wait cut short by the deadline is not evidence against the candidate, so it is
cleaned up without quarantine. Torrent creation and cleanup are never shortened, because
an aborted create may still allocate a torrent that nothing would then clean up.

Three seconds after the budget, the Worker answers regardless of any in-flight request.
The unfinished work continues through `ExecutionContext.waitUntil()`, which Cloudflare
allows thirty seconds after the response. After the deadline that work is at most one
create and one cleanup request, so it finishes within that allowance. No download URL is
requested for a selection that completes after the response.

When the budget expires, the selector reports `deadline_reached` and a TV programme
follows the existing Unavailable Episode path: holding media, deferral, and Preparation
Run reconciliation. A movie returns 503 whenever selection ends after the deadline without
a stream, because an interrupted search or an unconfirmed cached file is not definitive;
a retry can use the selection stored in the background. The selector reports
`deadline_reached` unless every search completed with no results. Transient resolution retries and alternate-hash failover stop at the
deadline. The `/resolve` route uses the same budget and response limit, returning 503
without invalidating the selection.

`PLAYBACK_SELECTION_BUDGET_MS` overrides the budget for both Channel Types.

Consequences:

- Playback depends more heavily on Preparation Runs. A TV episode that can only be sourced
  slowly is deferred for one programme instead of making the viewer wait.
- Cached-only movie sourcing that needs more than twenty seconds now requires a retry.
- The `selection_timed_out` and `resolve_timed_out` playback events and the
  `deadline_reached` outcome distinguish budget expiry from a genuine lack of sources.

This refines the in-request selection behaviour of ADRs 0007, 0009, and 0012. Their
discovery, exact file matching, and failover rules are unchanged.
