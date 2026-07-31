# Use Comet as the first stream provider

Status: Superseded by ADR 0007.

Superseded by ADR 0004 after client playback exposed IP-bound provider resolution.

The addon will query each Household's configured Comet endpoint and return exactly its first acceptable cached 1080p Real-Debrid stream, rather than implementing torrent discovery or Real-Debrid resolution itself.

The first deployed feasibility run found that hosted Torrentio returns HTTP 403 to Cloudflare Worker-originated requests while Comet accepts the same egress and identifies cached Real-Debrid streams in its standard Stremio response. Comet therefore replaces Torrentio as the recommended MVP provider.

Comet remains behind a generic Stremio stream-provider boundary because hosted provider availability, configuration formats, and stream markers may change. Torrentio response recognition remains supported for compatibility, but its hosted service is not usable from the current Cloudflare deployment.

Comet must be configured for cached Real-Debrid results and suitable 1080p ordering. Its playback endpoint may redirect Stremio to Real-Debrid, but neither Kids Channels nor Cloudflare will proxy media bytes.
