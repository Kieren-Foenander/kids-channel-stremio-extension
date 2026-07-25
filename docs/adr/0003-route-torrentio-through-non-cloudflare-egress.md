# Route Torrentio requests through non-Cloudflare egress

The Cloudflare Worker will retain the Parent Page, Stremio addon routes, encrypted Household configuration, and D1 state, but it cannot call the hosted Torrentio endpoint directly. The first deployed feasibility run proved that Torrentio returns HTTP 403 to Cloudflare Worker-originated requests while the identical configured endpoint succeeds from Node outside Cloudflare.

Torrentio manifest and stream JSON requests will therefore pass through a small authenticated relay deployed outside Cloudflare. The relay must:

- accept requests only from Kids Channels using a deployment secret;
- allow only the configured Torrentio HTTPS host and derived manifest/stream paths;
- enforce short timeouts and response-size limits;
- never persist or log request URLs, provider credentials, response bodies, or signed stream URLs; and
- return provider JSON only.

The Worker remains responsible for decrypting Household configuration, selecting exactly one acceptable cached stream, and returning it to Stremio. Real-Debrid media continues to flow directly from Real-Debrid to Stremio; neither Cloudflare nor the relay proxies media bytes.

This preserves the decisions to use Cloudflare Workers with D1 and to isolate Torrentio behind the stream-provider boundary, while replacing the failed assumption that hosted Torrentio accepts Cloudflare Worker egress.
