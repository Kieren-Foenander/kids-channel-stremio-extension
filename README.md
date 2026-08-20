# Kids Channels

A Cloudflare Worker Stremio addon that gives each Household up to five named TV Channels and five named Movie Channels. Parents create PIN-protected Households, explicitly assign approved Cinemeta programmes, and connect TorBox. Kids Channels prepares and returns one playable stream without a source picker.

## Requirements

- Node.js 20+
- pnpm 10+
- A Cloudflare account for deployment
- A TorBox account with API access

## Run locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Replace CONFIG_SECRET in .dev.vars with: openssl rand -base64 32
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` creates the production SPA assets and starts the complete Cloudflare Worker at `http://localhost:8787`; rerun it after frontend changes. Use `pnpm build` when only a production asset build is needed. The build prerenders the SSR-disabled TanStack Start shell, extracts generated bootstrap code into hashed external assets, and leaves no inline application scripts or styles.

Keep `.dev.vars` private; `CONFIG_SECRET` signs one-hour Parent sessions. Open `http://localhost:8787`, choose a six-digit Parent PIN, and create a Household. Creation starts a secure Parent session and opens onboarding with the private Parent Page and manifest URLs plus a `stremio://` installation action. Every Household starts with one TV and one Movie Channel; a Parent may deliberately create and name four more of each type. Shows default to S01E01 independently in each assigned TV Channel. Assignments, pause state, Show Progress, schedules, rotations, and history are managed per Channel.

Stremio retains loaded addon metadata in memory even when responses use `Cache-Control: no-store`. After a Parent changes the Approved Library or regenerates selections, fully close and reopen Stremio to load the updated Channel. The Worker state changes immediately and does not interrupt media already playing.

When TorBox is connected, Kids Channels automatically warms the next five episodes in every TV Channel, breadth-first, with at most 25 positions per Household. Every schedule advancement or correction reconciles one Household Preparation Run in the background, and a fifteen-minute scheduled check restarts preparation when a selection expires or an earlier trigger was missed.

Production playback troubleshooting is documented in [Playback diagnostics](docs/playback-diagnostics.md).

Local D1 data is stored by Wrangler under `.wrangler/`. There is no forgotten-PIN or account recovery. Five incorrect PIN attempts from one request origin within 15 minutes lock PIN access from that origin for 15 minutes for that Household only. A Parent can rotate the PIN by supplying the current PIN; rotation invalidates older Parent sessions. Permanent deletion requires the current PIN plus the exact confirmation `DELETE`, removes all Household data, and invalidates every synced addon route.

## Test

```bash
pnpm typecheck
pnpm build
pnpm test # rebuilds before Worker and component tests
pnpm exec playwright install chromium # once per machine
pnpm test:browser
# Or run both suites with: pnpm test:all
```

The integration and protocol suite runs Household creation, isolated PIN rate limiting, PIN rotation and session invalidation, complete deletion, Cinemeta search, approval, deterministic rolling scheduling, shuffled movie rotation, concurrent advancement, sign-off delivery, and canonical programme metadata inside the Cloudflare Worker runtime against an isolated test D1 database. Cinemeta is stubbed only at outbound `fetch`. The Playwright suite starts a local Worker, local D1 database, and network-boundary Cinemeta stub to exercise the Parent Page in Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary instead of downloading one.

Manual protocol-gate results are recorded in [`docs/first-playback-feasibility.md`](docs/first-playback-feasibility.md) and [`docs/continuous-tv-feasibility.md`](docs/continuous-tv-feasibility.md). Use [`docs/mvp-release-certification.md`](docs/mvp-release-certification.md) for the final production and Fire TV acceptance run.

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

The Worker encrypts each Household's TorBox API token with `CONFIG_SECRET`. It checks ranked candidates for an immediately cached match, starts one TorBox download for a series episode when none is cached, and redirects playback to a fresh TorBox download URL; media bytes never pass through Cloudflare. Household routes use a random 256-bit opaque secret; PINs are salted and hashed with PBKDF2-SHA-256. Parent API authentication uses a one-hour `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Browser documents apply a strict Content Security Policy to same-origin hashed scripts, styles, and fonts plus HTTPS programme imagery; framing and MIME sniffing are denied. No analytics, tracking, service worker, or offline mutation queue is included.

## Routes

- `GET /` — minimal Household creation Parent Page
- `POST /api/households` — create a Household with a six-digit PIN
- `GET /households/:secret` — SPA Parent Page Overview (PIN unlock when required)
- `GET /households/:secret/{add-programmes,approved-library,tv-channel,movie-channel,settings}` — focused SPA destinations with refresh-safe deep links
- `GET /addons/:secret/configure` — redirect Stremio configuration to the Household Overview
- `POST /api/households/:secret/unlock` — authenticate a Parent for one hour (rate-limited by Household and request origin)
- `PUT /api/households/:secret/pin` — change the PIN after supplying the current PIN and invalidate older Parent sessions
- `DELETE /api/households/:secret` — permanently delete the Household after current-PIN and exact `DELETE` confirmation
- `GET /api/households/:secret/cinemeta/search?q=…` — search Cinemeta shows and movies (Parent session required)
- `GET /api/households/:secret/cinemeta/title/:type/:imdbId` — retrieve canonical title and released episode metadata (Parent session required)
- `GET|POST /api/households/:secret/library` — view or add to the Approved Library (Parent session required)
- `GET|POST /api/households/:secret/channels` — list or create named Channels (Parent session required)
- `GET|PATCH|DELETE /api/households/:secret/channels/:channelId` — inspect, rename, or delete a Channel (Parent session required)
- `PUT /api/households/:secret/library/:programmeId/assignments` — replace explicit compatible Channel Assignments (Parent session required)
- `PATCH|DELETE /api/households/:secret/library/:programmeId` — pause/resume a show or remove a programme and reconcile its active Channel (Parent session required)
- `POST /api/households/:secret/tv-schedule/regenerate` — regenerate future TV selections without advancing Show Progress (Parent session required)
- `GET /addons/:secret/manifest.json` — Household Stremio manifest
- `GET /addons/:secret/catalog/series/kids-tv-channel.json` — every configured TV Channel tile, including empty Channels
- `GET /addons/:secret/catalog/movie/kids-movie-channel.json` — every configured Movie Channel tile, including empty Channels
- `GET /addons/:secret/meta/series/kids-channels:tv.json` — Current Programme plus the rolling Channel Schedule with canonical episode IDs
- `GET /addons/:secret/stream/series/:episodeId.json` — read-only compatibility lookup for an already-prepared stream; not advertised in current manifests
- `GET /addons/:secret/meta/movie/kids-channels:movie.json` — the canonical Current Programme followed only by its final sign-off
- `GET /addons/:secret/stream/movie/:videoId.json` — read-only compatibility lookup for an already-prepared movie stream or sign-off asset; not advertised in current manifests
- `GET|HEAD /addons/:secret/media/movie-sign-off/:channelId/:cycle/:position.mp4` — atomically consume the movie in one Channel and directly serve its inline five-second sign-off
- `GET|HEAD /addons/:secret/play/:type/:channelId/:videoId` — resolve Channel-scoped inline playback while retaining the canonical video ID
- `GET|HEAD /assets/movie-sign-off.mp4` — branded H.264 Constrained Baseline still with a five-second silent AAC-LC track and Android-compatible byte-range support
- `GET|HEAD /assets/programme-unavailable-v2.mp4` — 40-second inline TV holding bumper used to bridge autoplay to another eligible show
