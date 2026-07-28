# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A **Parent** managing what their children watch through Stremio. They configure the Household on the **Parent Page** — a PIN-protected website — usually in short, task-focused visits: approve a programme, correct Show Progress, check what is currently playing. Children never use this surface; they only experience the resulting Channels inside Stremio.

## Product Purpose

Kids Channels recreates the limited choice and continuous playback of a traditional television channel inside Stremio. Parents curate an Approved Library of shows and movies; the product runs two persistent Channels (a TV Channel that rotates shows while preserving episode order, and a Movie Channel that rotates movies without repeats) so children can watch continuously without making further viewing choices. Success means a parent trusts the schedule enough to leave it running.

## Positioning

Unlike Stremio's open catalogue or algorithmic kids' profiles, a Channel here is finite and closed: it plays only what the Parent approved, in an order the Parent can inspect and correct, with no discovery surface, no autoplay roulette, and no account system — one private URL and one six-digit PIN guard everything.

## Operating Context

- The Parent Page is reached via a private, unrecoverable Household URL; sessions expire after one hour and can be locked.
- Installation happens once per Household: a Stremio addon (manifest URL) installed on the Stremio account shared by the Household's devices, completed on desktop.
- Streams come from a separately configured stream addon (e.g. Comet); Kids Channels schedules programmes but never provides or inspects streams.
- Changes to Channel state require a Stremio restart to take effect.

## Capabilities and Constraints

- Domain language is fixed in CONTEXT.md: Channel, TV Channel, Movie Channel, Approved Library, Show Progress, Viewing Progress, Current Programme, Channel Schedule, Unavailable Episode, Household, Parent Page, Parent. Use these terms; never the listed avoid-words (admin, account, playlist, queue, watch history, etc.).
- PIN is six digits, cannot be recovered; no forgotten-PIN flow. Household deletion is permanent and confirmed by typing DELETE.
- Episode metadata comes from Cinemeta; Unavailable Episodes stay next while the TV Channel temporarily chooses another show.
- Cloudflare Workers + D1 backend; TanStack Start SPA; shadcn/ui + Tailwind CSS v4 frontend. Theme support (system / light / dark) is a kept commitment.

## Brand Commitments

- Name: **Kids Channels**.
- Voice: plain, honest, parent-facing. The product never overclaims (e.g. opening Stremio does not prove installation succeeded).
- Visual direction (chosen 2026-07-28): **broadcast guide** world — the household's own programme guide, with a signal-red accent. Theme picker (system/light/dark) remains.

## Evidence on Hand

Real programme metadata (titles, posters, episode lists, release info, IMDb ratings) comes from Cinemeta at runtime. No testimonials, customers, benchmarks, or marketing claims exist; future work must not fabricate them.

## Product Principles

1. **Closed by default.** Nothing plays that the Parent did not approve; every state is inspectable and correctable.
2. **No recovery theatre.** Private URL and PIN are unrecoverable; the UI says so plainly instead of implying safety nets.
3. **Never interrupt playback.** Corrections change future selections, not the Current Programme or active playback.
4. **Honest states.** Loading, empty, error, and unverifiable states are stated truthfully rather than hidden or smoothed over.
5. **A guide, not a dashboard.** The parent reads and edits a schedule; the interface behaves like a programme guide, not an admin console.

## Accessibility & Inclusion

WCAG AA contrast, full keyboard operability (tablists, dialogs, disclosure controls), screen-reader status announcements for all async state, and reduced-motion support are required. The Parent Page is used one-handed on phones as often as on desktop.
