# First-party provider feasibility

Status: **Not yet run from the deployed Worker**

This is the evidence record for issue #62 and the feasibility gate in PRD #61. Run
the probes against a deployed Worker: local Wrangler egress does not establish
that the upstream services accept Cloudflare egress.

Do not retain a Household secret, Real-Debrid credential, provider response body,
signed media URL, or observed network address in this document, shell history,
logs, screenshots, or test output.

## Probe setup

Configure the two temporary secrets interactively:

```sh
pnpm exec wrangler secret put REAL_DEBRID_TOKEN
pnpm exec wrangler secret put PROVIDER_PROBE_SECRET
```

`PROVIDER_PROBE_SECRET` protects the temporary probe routes and must be different
from `CONFIG_SECRET`. Use a known popular, cached torrent that the maintainer is
entitled to access. Send its magnet and a known title query in the JSON request
body. Do not place either secret or the magnet in the URL.

The deployed routes are:

- `POST /_probes/first-party-provider` — Real-Debrid cache round trip plus Zilean
  and Knaben egress. The response contains only statuses and rough timings.
- `POST /_probes/first-party-provider/redirect` — repeats the Real-Debrid round
  trip and returns a 302. Follow it with an external client and request a small
  byte range; do not save or print the redirect URL.

Both routes require `Authorization: Bearer <PROVIDER_PROBE_SECRET>`. The
Real-Debrid torrent is deleted after every successful or failed run.

The provider origins can be overridden with non-secret Worker variables
`REAL_DEBRID_ORIGIN`, `ZILEAN_ORIGIN`, and `KNABEN_ORIGIN`. This matters because
the `https://zilean.elfhosted.com` endpoint named in #62 returned HTTP 404 during
the local preflight on 2026-07-30; that observation is not Worker-egress evidence.

## Results

### Real-Debrid API egress

- Date:
- Deployed Worker version:
- HTTP outcome:
- `addMagnet`:
- files ready:
- cached after `selectFiles`:
- `unrestrict/link`:
- end-to-end:
- torrent cleanup confirmed:

### Discovery egress

| Backend | HTTP status | Rough latency | Notes |
| --- | ---: | ---: | --- |
| Zilean | Pending | Pending | |
| Knaben | Pending | Pending | |

### Redirect playback

- External network client:
- 302 received:
- Range response:
- Media bytes served by Real-Debrid, not Cloudflare:

## Gate

Pending. Pass only when both discovery backends accept Worker egress, the complete
Real-Debrid round trip finishes in low seconds for a cached torrent, and the
external range request succeeds through the 302 redirect.
