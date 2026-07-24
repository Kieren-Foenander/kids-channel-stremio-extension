# Kids Channels

A Cloudflare Worker Stremio addon that gives each Household one clearly identifiable TV Channel and one Movie Channel. This first vertical slice creates PIN-protected Households and installs an empty, Household-specific addon backed by D1.

## Requirements

- Node.js 20+
- pnpm 10+
- A Cloudflare account for deployment

## Run locally

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

Open `http://localhost:8787`, choose a six-digit Parent PIN, and create a Household. The page returns the opaque manifest URL and a `stremio://` installation action.

Local D1 data is stored by Wrangler under `.wrangler/`. There is no forgotten-PIN recovery.

## Test

```bash
pnpm typecheck
pnpm test
```

The integration and protocol suite runs the complete creation, PIN unlock, manifest, and catalog flow inside the Cloudflare Worker runtime against an isolated test D1 database.

## Deploy

Create the production D1 database once:

```bash
pnpm exec wrangler d1 create kids-channels
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder. Then migrate and deploy:

```bash
pnpm db:migrate:remote
pnpm deploy
```

The Worker never places the Parent PIN or provider credentials in installation URLs. Household routes use a random 256-bit opaque secret; PINs are salted and hashed with PBKDF2-SHA-256 before storage.

## Routes

- `GET /` — minimal Household creation Parent Page
- `POST /api/households` — create a Household with a six-digit PIN
- `GET /households/:secret` — PIN unlock Parent Page
- `GET /addons/:secret/manifest.json` — Household Stremio manifest
- `GET /addons/:secret/catalog/tv/kids-tv-channel.json` — one TV Channel tile
- `GET /addons/:secret/catalog/movie/kids-movie-channel.json` — one Movie Channel tile
