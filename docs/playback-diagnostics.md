# Playback diagnostics

Use one Stremio click as the feedback loop. Start a live production tail, click one
Channel programme, and keep the `handoffId` from the resulting structured event:

```sh
pnpm exec wrangler tail kids-channels --format pretty
```

The playback events distinguish the important boundaries:

| Event | Meaning |
| --- | --- |
| `head_probe` | Stremio checked an inline URL without starting playback. The Channel did not advance. |
| `selection_unavailable` | Kids Channels could not obtain a ready exact-match TorBox selection. Inspect `selectionOutcome`. |
| `failed` | Selection or TorBox download-link resolution failed before the Channel advanced. Inspect `torBoxStatus`, `retryAfter`, and `reason`. |
| `cdn_handoff` | TorBox issued a download URL and Kids Channels returned it to Stremio. `cdnHost`, `colo`, and `country` identify the delivery route without logging the signed URL or client IP. |
| `resolve_failed` | A compatibility `/resolve` request failed before reaching the TorBox CDN. |

If `cdn_handoff` is the final event but Stremio reports
`ERROR_CODE_IO_BAD_HTTP_STATUS`, the failure is after the Worker boundary. Check
[TorBox status](https://status.torbox.app/) and test a freshly generated link from
the same TorBox account and playback device. The Worker cannot observe the HTTP
status returned later by TorBox's CDN because Stremio follows that redirect directly.

If the same click produces more than one non-HEAD handoff, capture the request
methods and timestamps from the invocation logs. That indicates Stremio is issuing
GET probes or retries that cannot currently be distinguished from a real playback
start.

## D1 limits

Cloudflare D1 Free currently permits 5 million rows read and 100,000 rows written
per day. Exceeding either limit makes D1 queries fail until the daily reset; it does
not selectively break only TorBox playback.

Check the account-wide total under **Cloudflare Dashboard → Billing → Billable
Usage**. Use per-database insights to find the statements responsible:

```sh
pnpm exec wrangler d1 insights kids-channels \
  --time-period 1d --sort-by reads --sort-direction DESC --limit 100

pnpm exec wrangler d1 insights kids-channels \
  --time-period 1d --sort-by writes --sort-direction DESC --limit 100
```

A direct read confirms whether D1 is accepting queries at the time of the incident:

```sh
pnpm exec wrangler d1 execute kids-channels --remote \
  --command "SELECT datetime('now') AS checked_at;"
```

Do not diagnose an account-wide Free-plan overage solely from database size or
Household count. Billing is based on rows scanned and written by queries.
