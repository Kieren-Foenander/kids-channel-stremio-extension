# Use Torrentio as the first stream provider

The addon will query each Household's configured Torrentio endpoint and return exactly one acceptable cached Real-Debrid stream, rather than implementing torrent discovery or Real-Debrid resolution itself. Torrentio will sit behind an internal stream-provider boundary because its hosted, undocumented interface may change and should not become coupled to Channel scheduling.
