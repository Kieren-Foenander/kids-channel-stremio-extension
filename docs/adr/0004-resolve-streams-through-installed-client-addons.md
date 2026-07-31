# Resolve streams through installed client addons

Status: Superseded by ADR 0007.

Kids Channels will select the current canonical Cinemeta title or episode, but it will not query or resolve streams itself. It exposes the TV Channel as a standard Stremio `series` catalog and metadata resource, with the canonical episode ID as `behaviorHints.defaultVideoId`. Stremio can therefore request streams for that ID from independently installed stream addons such as Comet or Torrentio on the playback device.

The deployed Comet feasibility run disproved the server-side provider design. When the Cloudflare Worker requested Comet's stream resource, Comet associated Real-Debrid activity with Cloudflare's cross-zone Worker address. Playback from the user's device then failed with Comet's `Wrong IP` response. Directly installed Comet works because discovery and resolution occur in the client context.

The Stremio addon protocol does not let Kids Channels invoke another installed addon, inspect its results, or choose among them. Parents must configure installed stream addons for cached-only, preferred quality, language, and ordering. Limiting Comet to one 1080p result is the closest available approximation to automatic source selection; Fire TV behavior must be validated in the client.

Consequences:

- Kids Channels no longer stores provider manifests or Real-Debrid credentials.
- Cloudflare makes no provider or media requests.
- Real-Debrid links retain the playback device's network identity.
- Canonical episode identity is preserved for resume and subtitle matching.
- Stream selection and provider availability remain Stremio client concerns.

This supersedes ADR 0002.
