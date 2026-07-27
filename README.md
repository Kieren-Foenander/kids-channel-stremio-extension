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

Keep `.dev.vars` private; `CONFIG_SECRET` signs one-hour Parent sessions. Open `http://localhost:8787`, choose a six-digit Parent PIN, and create a Household. The page returns the opaque manifest URL and a `stremio://` installation action. Open the Parent Page, unlock it, then search Cinemeta to approve shows and movies. Shows default to S01E01; choose another regular released episode before approval when needed. Approved shows can be paused without losing Show Progress, programmes can be removed from future Channel selections, and upcoming TV selections can be regenerated without changing the Current Programme.

Stremio retains loaded addon metadata in memory even when responses use `Cache-Control: no-store`. After a Parent changes the Approved Library or regenerates selections, fully close and reopen Stremio to load the updated Channel. The Worker state changes immediately and does not interrupt media already playing.

Local D1 data is stored by Wrangler under `.wrangler/`. There is no forgotten-PIN or account recovery. Five incorrect PIN attempts from one request origin within 15 minutes lock PIN access from that origin for 15 minutes for that Household only. A Parent can rotate the PIN by supplying the current PIN; rotation invalidates older Parent sessions. Permanent deletion requires the current PIN plus the exact confirmation `DELETE`, removes all Household data, and invalidates every synced addon route.

## Test

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium # once per machine
pnpm test:browser
# Or run both suites with: pnpm test:all
```

The integration and protocol suite runs Household creation, isolated PIN rate limiting, PIN rotation and session invalidation, complete deletion, Cinemeta search, approval, deterministic rolling scheduling, shuffled movie rotation, concurrent advancement, sign-off delivery, and canonical programme metadata inside the Cloudflare Worker runtime against an isolated test D1 database. Cinemeta is stubbed only at outbound `fetch`. The Playwright suite starts a local Worker, local D1 database, and network-boundary Cinemeta stub to exercise the Parent Page in Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary instead of downloading one.

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
- `POST /api/households/:secret/unlock` — authenticate a Parent for one hour (rate-limited by Household and request origin)
- `PUT /api/households/:secret/pin` — change the PIN after supplying the current PIN and invalidate older Parent sessions
- `DELETE /api/households/:secret` — permanently delete the Household after current-PIN and exact `DELETE` confirmation
- `GET /api/households/:secret/cinemeta/search?q=…` — search Cinemeta shows and movies (Parent bearer token required)
- `GET /api/households/:secret/cinemeta/title/:type/:imdbId` — retrieve canonical title and released episode metadata (Parent bearer token required)
- `GET|POST /api/households/:secret/library` — view or add to the Approved Library (Parent bearer token required)
- `PATCH|DELETE /api/households/:secret/library/:programmeId` — pause/resume a show or remove a programme and reconcile its active Channel (Parent bearer token required)
- `POST /api/households/:secret/tv-schedule/regenerate` — regenerate future TV selections without advancing Show Progress (Parent bearer token required)
- `GET /addons/:secret/manifest.json` — Household Stremio manifest
- `GET /addons/:secret/catalog/series/kids-tv-channel.json` — one TV Channel tile
- `GET /addons/:secret/catalog/movie/kids-movie-channel.json` — one Movie Channel tile
- `GET /addons/:secret/meta/series/kids-channels:tv.json` — Current Programme plus the rolling Channel Schedule with canonical episode IDs
- `GET /addons/:secret/stream/series/:episodeId.json` — observe Current/later programme requests, atomically advance when needed, and delegate playable streams to installed client addons
- `GET /addons/:secret/meta/movie/kids-channels:movie.json` — the canonical Current Programme followed only by its final sign-off
- `GET /addons/:secret/stream/movie/:videoId.json` — delegate canonical movies to installed addons, with a compatibility fallback for sign-off requests
- `GET|HEAD /addons/:secret/media/movie-sign-off/:cycle/:position.mp4` — atomically consume the movie and directly serve its inline five-second sign-off without another source picker
- `GET|HEAD /assets/movie-sign-off.mp4` — branded H.264 Constrained Baseline still with a five-second silent AAC-LC track and Android-compatible byte-range support
