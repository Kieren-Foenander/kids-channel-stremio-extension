---
name: Kids Channels
description: A parent-curated TV and Movie Channel for Stremio, presented as the household's own programme guide.
colors:
  signal: "#d40c1a"
  accent-dark: "#f75d59"
  paper: "#fbfaf8"
  ink: "#1a2026"
  ink-muted: "#555c63"
  rule: "#d6d9dd"
  night: "#101418"
  night-raised: "#181c21"
  night-text: "#e9e8e4"
  input-light: "#8a9199"
  input-dark: "#666e78"
rounded:
  sm: "3px"
  md: "6px"
spacing:
  sm: "8px"
  md: "16px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  ident:
    backgroundColor: "{colors.signal}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: Kids Channels

## Overview

**Creative North Star: "The Household Programme Guide"**

The Parent Page is the printed TV listing magazine rebuilt as a working tool: hairline rules, numbered schedules, channel idents, and episode codes set in mono. It refuses the SaaS dashboard — no icon-plus-heading card grids, no metric heroes, no purple-anything. The parent's world is broadcast television, so the interface speaks listings: what is **on now**, what is **next**, and where to correct the running order.

Density is guide-like: compact rows, generous section separation, more space above a heading than below it. Personality lives in the signal-red ident and the tabular schedule, not in decoration.

**Key Characteristics:**
- Lists and tables are the dominant structure; cards are rare and never nested.
- One accent — signal red — reserved for broadcast meaning: current programme, channel idents, primary actions.
- Mono type is for data only: episode codes (S01E02), schedule positions, URLs.
- Channel idents (small red blocks with condensed white caps) label TV Channel and Movie Channel like on-screen bugs.

## Colors

The palette is newsprint-and-ink with a single broadcast red, in both a light "paper" theme and a dark "night transmission" theme.

### Primary
- **Signal Red** (#d40c1a): The ON AIR red, identical in both themes so the ident keeps its white text. Used for idents, the current-programme marker, tab underlines, and links. Never used for large fills or backgrounds. In dark theme, text-level accents (links, statuses) brighten to **Accent Red** (#f75d59) for contrast.

### Neutral
- **Listing Paper** (#fbfaf8): Light-theme page ground, a near-white with the faintest warm tint.
- **Printer's Ink** (#1a2026): Light-theme foreground, a cool-tinted near-black. Never pure black.
- **Column Grey** (#555c63): Secondary text on light — tinted from the ink, never a flat gray.
- **Hairline Rule** (#d6d9dd): 1px dividers that structure the guide.
- **Night Transmission** (#101418): Dark-theme ground, a deep blue-ink, like a TV in a dark room.
- **Night Raised** (#181c21): Dark-theme lifted surfaces.
- **Night Print** (#e9e8e4): Dark-theme foreground.
- **Input Rule** (#8a9199 light / #666e78 dark): Form-field and outline-button borders. Darker than the hairline rule so interactive controls meet WCAG 3:1 non-text contrast against both page ground and raised surfaces.

### Named Rules
**The One Voice Rule.** Signal red appears on well under 10% of any screen. It means something — current, live, primary — and its rarity is the point.

**The Tinted Ink Rule.** Every neutral is tinted (cool ink in light, warm paper in dark). Pure black, pure white text on red, and flat grays are banned.

## Typography

**Display/UI Font:** Archivo (variable), with system sans fallback
**Data/Mono Font:** JetBrains Mono (variable), for episode codes, schedule positions, and URLs only

**Character:** Archivo is a workhorse grotesque with an expanded width that gives channel idents their broadcast-badge voice; JetBrains Mono sets the guide's tabular data the way listing magazines set times.

### Hierarchy
- **Page title** (weight 650, clamp(1.75rem, 4vw, 2.5rem), line-height 1.1, tracking -0.02em): One per page, under a hairline or beside an ident.
- **Section title** (weight 650, 1.25rem, line-height 1.25): Names a block of the guide.
- **Ident** (Archivo expanded, weight 800, 0.7rem, tracking 0.08em, uppercase): White on signal red; labels channels and programme types.
- **Body** (weight 450, 1rem, line-height 1.6, max 68ch): Descriptions and guidance.
- **Data** (JetBrains Mono, weight 500, 0.85em): Episode codes, positions, URLs, counts.

### Named Rules
**The No-Eyebrow Rule.** Tracked uppercase eyebrows over every section are banned. A page may carry one ident; sections get plain strong titles.

## Layout

A single reading column per page, like a guide spread: page header, then stacked sections separated by whitespace, not boxes. The parent app uses a fixed left index (the channel guide's spine) on desktop and a top bar with a menu on mobile (≤800px). Content maxes at ~62rem in the app and ~38rem on standalone pages. Schedules and libraries render as ruled lists; poster grids only where posters are the content (search results, library).

## Elevation & Depth

The system is flat by default: depth comes from hairline rules and tonal layering, not shadows. One shadow exists — a soft offset drop under floating surfaces only (dialogs, the mobile menu panel).

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows belong to overlays, never to cards or buttons.

## Shapes

Nearly square corners (3–6px radius), echoing set-top boxes and printed grids. Hairline 1px rules in place of heavy borders. Badges are small rectangles, not pills, except the rounded "current" marker which reads as an on-air light.

## Components

### Buttons
- **Shape:** nearly square (3px radius), compact (10px 16px padding)
- **Primary:** printer's ink fill, paper text; hover deepens slightly
- **Outline:** hairline ink border, transparent ground, ink text
- **Destructive:** signal-red tinted ground, red text
- **Focus:** 2px offset outline in signal red — the one place red frames an element

### Cards / Containers
- Rare. When a surface is needed it is a flat, ruled panel (1px hairline, paper or night-raised ground), never nested, never shadowed.

### Inputs / Fields
- Hairline ink border, square-ish corners, paper ground; focus shifts the border to signal red with a faint red ring. PIN fields keep their wide letter-spacing as a data cue.

### Navigation
- The desktop sidebar is the guide's index: brand wordmark with a red bug, plain text links, the active destination marked by a short red rule and medium weight — not a filled pill. Mobile collapses to a top bar with a details-menu panel.

### Idents & badges
- **Ident:** signal-red block, white expanded caps — the channel bug. States (Current / Paused / Finished / Already approved) are small hairline-outline rectangles with mono or caps labels; "Current" alone may fill signal red.

### Schedules
- Ruled, numbered lists. Position numbers in mono. The current row carries a red left tick (≤2px) and a "Current" badge, not a colored background wash.

## Do's and Don'ts

### Do:
- **Do** structure every page as a guide: header, then ruled sections of lists and tables.
- **Do** set episode codes, positions, counts, and URLs in JetBrains Mono.
- **Do** keep signal red rare and meaningful (One Voice Rule).
- **Do** keep both themes fully designed: light is listing paper, dark is night transmission.

### Don't:
- **Don't** build card grids of icon-plus-heading-plus-text, and never nest cards.
- **Don't** use tracked-uppercase eyebrows as section grammar (No-Eyebrow Rule).
- **Don't** use gradients, glass, glows, bounce easing, or colored border-left accents above 2px.
- **Don't** use mono as a "technical" costume for prose; mono is for data.
