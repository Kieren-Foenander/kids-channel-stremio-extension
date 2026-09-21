## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels configured for this repository. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Cursor Cloud specific instructions

Standard setup, run, and test commands live in `README.md` and `package.json` scripts. This is a Cloudflare Worker Stremio addon (TanStack Start SPA + D1) served on `http://localhost:8787` via `pnpm dev`. Notes below are non-obvious caveats for this environment.

- **`.dev.vars` is required and gitignored.** It holds `CONFIG_SECRET` (signs Parent sessions). It already exists in the VM snapshot. If missing, recreate it: `cp .dev.vars.example .dev.vars` then set `CONFIG_SECRET` to `openssl rand -base64 32`. `pnpm dev` and both test suites fail without it.
- **Local D1 needs migrations applied.** Run `pnpm db:migrate:local` after pulling new files under `migrations/`. Migrations are already applied in the snapshot; local D1 data lives under `.wrangler/` (gitignored, persists in the snapshot). This is deliberately not in the startup update script.
- **`pnpm dev` has no asset hot-reload.** It runs `pnpm build` (Vite + `scripts/harden-spa-shell.mjs`) once, then `wrangler dev`. Rerun `pnpm dev` after any frontend change to rebuild the SPA shell.
- **State-changing Parent API calls require a same-origin `Origin` header** (CSRF protection in `src/index.ts`). When testing `POST/PUT/PATCH/DELETE /api/households*` with curl, add `-H "Origin: http://localhost:8787"`, otherwise you get `403 "This request must come from the Parent Page."`.
- **Lint = `pnpm typecheck`** (`tsc`). There is no separate ESLint script.
- **Browser tests are self-contained.** `pnpm test:browser` (Playwright) launches its own worker on port 8790 plus a Cinemeta `fetch` stub on 8791 via `scripts/start-browser-test-server.mjs`, against a separate local D1 database `kids-channels-browser` (`wrangler.browser.jsonc`). Chromium is installed via `pnpm exec playwright install chromium`.
