# Use first-party cached stream resolution

Kids Channels will discover torrent candidates itself, verify them against the Household's Real-Debrid account, deterministically select one acceptable cached file, and return exactly one Stremio stream. The Worker stores the Household's Real-Debrid token encrypted and stores only short-lived torrent/file selections. Media bytes never pass through Cloudflare: the playback URL resolves through the Worker and redirects Stremio to a fresh Real-Debrid download URL.

The earlier installed-addon design preserved canonical identity but could not remove Stremio's source picker or let Kids Channels react when a provider had no result. A deployed first-party feasibility probe demonstrated that Worker-originated Real-Debrid operations can hand playback to the client without Comet's cross-zone `Wrong IP` behavior.

If no acceptable cached file exists, the episode becomes an Unavailable Episode for six hours. Its Show Progress remains unchanged. The TV Channel atomically chooses another eligible show's next episode and returns a 40-second inline holding bumper in the stable `kids-channels-tv` binge group. The holding screen gives the viewer time to use Stremio's in-player Next control and gives clients that support the transition a stable autoplay group. Web Stremio may still return to the Channel detail when the bumper ends; Fire TV remains an explicit human gate. If every show is unavailable, the bumper is terminal and does not request autoplay.

Consequences:

- Each Household supplies a Real-Debrid token through the authenticated Parent Page.
- The Worker owns discovery, cached-file verification, deterministic selection, and redirect resolution.
- Stremio receives exactly one source while canonical movie and episode IDs continue to preserve Viewing Progress and subtitle matching.
- Real-Debrid media flows directly to Stremio and signed download URLs are neither persisted nor logged.
- Provider failure is explicit Channel state rather than an empty stream list that strands playback.
- Initial selection checks up to ten ranked cached candidates, preserving provider relevance when quality and seed availability tie. If a chosen torrent or restricted link later disappears (including HTTP 451 removals), resolution discards it and tries up to two different hashes inside the same Stremio request. Rate limits and other transient Real-Debrid failures do not invalidate a known-good selection.

This supersedes ADRs 0002 and 0004.
