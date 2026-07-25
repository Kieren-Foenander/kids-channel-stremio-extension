# Kids Channels

A Cloudflare Worker Stremio addon that gives each Household one clearly identifiable TV Channel and one Movie Channel. Parents create PIN-protected Households and approve programmes from Cinemeta. Separately installed Stremio addons such as Comet resolve streams on the playback device.

## Requirements

- Node.js 20+
- pnpm 10+
- A Cloudflare account for deployment
- A separately installed and configured Stremio stream addon for playback

## Run locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Replace CONFIG_SECRET in .dev.vars with: openssl rand -base64 32
pnpm db:migrate:local
pnpm dev
```

Keep `.dev.vars` private; `CONFIG_SECRET` signs one-hour Parent sessions. Open `http://localhost:8787`, choose a six-digit Parent PIN, and create a Household. The page returns the opaque manifest URL and a `stremio://` installation action. Open the Parent Page, unlock it, then search Cinemeta to approve shows and movies. Shows default to S01E01; choose another regular released episode before approval when needed.

Local D1 data is stored by Wrangler under `.wrangler/`. There is no forgotten-PIN recovery.

## Test

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium # once per machine
pnpm test:browser
# Or run both suites with: pnpm test:all
```

The integration and protocol suite runs Household creation, PIN unlock, Cinemeta search, approval, deterministic rolling scheduling, concurrent advancement, and catalog-to-canonical-episode metadata inside the Cloudflare Worker runtime against an isolated test D1 database. Cinemeta is stubbed only at outbound `fetch`. The Playwright suite starts a local Worker, local D1 database, and network-boundary Cinemeta stub to exercise the Parent Page in Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary instead of downloading one.

Manual protocol-gate results are recorded in [`docs/first-playback-feasibility.md`](docs/first-playback-feasibility.md) and [`docs/continuous-tv-feasibility.md`](docs/continuous-tv-feasibility.md).

## Deploy

Create the production D1 database once:

```bash
pnpm exec wrangler d1 create kids-channels
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder. Create a random deployment secret, then migrate and deploy:

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put CONFIG_SECRET
pnpm db:migrate:remote
pnpm run deploy
```

The Worker never receives stream-provider or Real-Debrid credentials. Household routes use a random 256-bit opaque secret; PINs are salted and hashed with PBKDF2-SHA-256. Installed stream addons resolve canonical programme IDs directly in Stremio's client context.

## Routes

- `GET /` — minimal Household creation Parent Page
- `POST /api/households` — create a Household with a six-digit PIN
- `GET /households/:secret` — PIN unlock Parent Page
- `POST /api/households/:secret/unlock` — authenticate a Parent for one hour
- `GET /api/households/:secret/cinemeta/search?q=…` — search Cinemeta shows and movies (Parent bearer token required)
- `GET /api/households/:secret/cinemeta/title/:type/:imdbId` — retrieve canonical title and released episode metadata (Parent bearer token required)
- `GET|POST /api/households/:secret/library` — view or add to the Approved Library (Parent bearer token required)
- `GET /addons/:secret/manifest.json` — Household Stremio manifest
- `GET /addons/:secret/catalog/series/kids-tv-channel.json` — one TV Channel tile
- `GET /addons/:secret/catalog/movie/kids-movie-channel.json` — one Movie Channel tile
- `GET /addons/:secret/meta/series/kids-channels:tv.json` — Current Programme plus the rolling Channel Schedule with canonical episode IDs
- `GET /addons/:secret/stream/series/:episodeId.json` — observe Current/later programme requests, atomically advance when needed, and delegate playable streams to installed client addons
