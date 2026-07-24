# Kids Channels

A Cloudflare Worker Stremio addon that gives each Household one clearly identifiable TV Channel and one Movie Channel. Parents create PIN-protected Households and can securely configure and validate an existing Torrentio/Real-Debrid endpoint.

## Requirements

- Node.js 20+
- pnpm 10+
- A Cloudflare account for deployment

## Run locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Replace CONFIG_SECRET in .dev.vars with: openssl rand -base64 32
pnpm db:migrate:local
pnpm dev
```

Keep `.dev.vars` private; changing `CONFIG_SECRET` makes existing encrypted provider configurations unreadable. Open `http://localhost:8787`, choose a six-digit Parent PIN, and create a Household. The page returns the opaque manifest URL and a `stremio://` installation action. Open the Parent Page, unlock it, then search Cinemeta to approve shows and movies. Shows default to S01E01; choose another regular released episode before approval when needed.

Local D1 data is stored by Wrangler under `.wrangler/`. There is no forgotten-PIN recovery.

## Test

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium # once per machine
pnpm test:browser
# Or run both suites with: pnpm test:all
```

The integration and protocol suite runs the complete creation, PIN unlock, provider validation, Cinemeta search, approval, encrypted storage, and catalog-to-current-episode stream flow inside the Cloudflare Worker runtime against an isolated test D1 database. Cinemeta and Torrentio are stubbed only at outbound `fetch`; deterministic tests contain no real credentials or signed media URLs. The Playwright suite starts a local Worker, local D1 database, and network-boundary Cinemeta stub to exercise the Parent Page in Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary instead of downloading one.

A credential-safe real-provider check is documented separately in [`docs/torrentio-contract-probe.md`](docs/torrentio-contract-probe.md). It is optional and never runs in CI.

## Deploy

Create the production D1 database once:

```bash
pnpm exec wrangler d1 create kids-channels
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder. Create a random deployment secret, then migrate and deploy:

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put CONFIG_SECRET
pnpm db:migrate:remote
pnpm deploy
```

The Worker never places the Parent PIN or provider credentials in installation URLs. Household routes use a random 256-bit opaque secret; PINs are salted and hashed with PBKDF2-SHA-256. Torrentio manifest URLs are AES-GCM encrypted with Household-bound authenticated data and the deployment secret, and are never returned after saving.

## Routes

- `GET /` — minimal Household creation Parent Page
- `POST /api/households` — create a Household with a six-digit PIN
- `GET /households/:secret` — PIN unlock Parent Page
- `POST /api/households/:secret/unlock` — authenticate a Parent for one hour
- `PUT /api/households/:secret/provider` — save and validate a Torrentio endpoint (Parent bearer token required)
- `GET /api/households/:secret/cinemeta/search?q=…` — search Cinemeta shows and movies (Parent bearer token required)
- `GET /api/households/:secret/cinemeta/title/:type/:imdbId` — retrieve canonical title and released episode metadata (Parent bearer token required)
- `GET|POST /api/households/:secret/library` — view or add to the Approved Library (Parent bearer token required)
- `GET /addons/:secret/manifest.json` — Household Stremio manifest
- `GET /addons/:secret/catalog/tv/kids-tv-channel.json` — one TV Channel tile
- `GET /addons/:secret/catalog/movie/kids-movie-channel.json` — one Movie Channel tile
- `GET /addons/:secret/meta/tv/kids-channels:tv.json` — the TV Channel's Current Programme metadata
- `GET /addons/:secret/stream/tv/:canonicalEpisodeId.json` — exactly one acceptable cached stream for the Current Programme
