# First-party provider feasibility evidence

## Run

- Date: 2026-07-30 UTC
- Issue: #62
- Deployment: `https://kids-channels-development.kfoenander98.workers.dev`
- Worker version: `ca1247c5-ef12-410b-a1ea-7c4f2df35e43`
- Environment: isolated development Worker and D1 database

No Household secret, Real-Debrid credential, provider response body, signed media URL, or observed network address was retained in this evidence.

The Real-Debrid credential was supplied through Parent Page Settings and stored encrypted for the test Household. It was not supplied as a Worker environment variable.

## Real-Debrid API egress

**Passed.** The deployed development Worker completed the cache-check sequence for a known cached Ubuntu live-server torrent:

1. `addMagnet`
2. poll `torrents/info` until files were available
3. `selectFiles`
4. poll until the torrent was downloaded with a restricted link
5. `unrestrict/link`
6. delete the temporary torrent

One successful run measured:

| Operation | Duration |
| --- | ---: |
| Add magnet | 921 ms |
| Files available | 896 ms |
| Cache check after selection | 712 ms |
| Unrestrict link | 319 ms |
| Total, including cleanup | 3,155 ms |

The probe returns only status and timing data. It does not return the credential, provider response bodies, restricted link, or signed direct link.

## Discovery egress

**Passed with endpoint replacement and fallback.**

- Knaben accepted Worker egress with HTTP 200 in 329 ms.
- The Zilean endpoint named in #62, `zilean.elfhosted.com`, returned HTTP 404 and is no longer usable.
- The development Worker was configured with another Zilean instance. It accepted an IMDb search for a known title with HTTP 200 in 298 ms.
- Discovery providers are independent: one reachable provider is sufficient for the feasibility probe, while both unavailable providers fail it. Per-provider status and timing remain visible without retaining response bodies.

A Zilean result is not proof that its torrent remains cached in Real-Debrid. A sampled result was no longer instantly available. The stream-selection slice must therefore merge and deduplicate candidates, then verify each candidate through Real-Debrid rather than trusting discovery metadata.

## Redirect playback

**Passed.** The temporary authenticated probe route resolved the cached torrent and returned an HTTP 302 without proxying media bytes or exposing the signed URL in its response body.

Following the redirect from an external range client returned:

- HTTP 206 Partial Content
- `Content-Range: bytes 0-1023/3405469696`
- 1,024 bytes received

This proves that a Worker-originated Real-Debrid unrestrict operation can hand playback to the client without the Comet `Wrong IP` failure observed in the earlier architecture.

## Gate result

**Passed.** Cloudflare Worker egress can:

- query independent discovery services;
- perform a Real-Debrid cached-torrent resolution in low seconds;
- clean up the temporary Real-Debrid torrent; and
- redirect a client that can retrieve media bytes directly from Real-Debrid.

The self-hosted Comet fallback is not required by this feasibility gate.

This probe deliberately accepts a known magnet independently of the discovery response. Candidate parsing, normalization, deduplication, Real-Debrid cache verification, and deterministic best-stream selection remain work for the stream-selection slice under #61.
