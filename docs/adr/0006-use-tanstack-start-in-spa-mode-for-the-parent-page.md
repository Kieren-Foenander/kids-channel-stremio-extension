# Use TanStack Start in SPA mode for the Parent Page

All browser-facing UI will use TanStack Start with SPA mode enabled and SSR disabled, while the same Cloudflare Worker continues to serve the Parent APIs and Stremio addon routes. The Parent Page is an authenticated, highly interactive application with no SEO requirement, so client-side rendering keeps its execution model simple while providing structured routing, reusable UI, and responsive navigation; retaining one Worker deployment preserves the existing operational and data boundaries.
