# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small webapp that scrapes the public WAVL/WAVJL volleyball schedule (hosted on
exposureevents.com) and surfaces only the matches involving "Reds" teams (Perth
Reds club). It serves both a match-results view and duty/bag roster views.

## Commands

```bash
npm install          # install deps (express, cheerio)
npm start            # run locally at http://localhost:3000 (node server.js)
```

There is no build step, no linter, and no test suite. The frontend is plain HTML
files served statically; refreshing the browser is the dev loop.

## Architecture

Single Express app in `server.js`, used two ways:

- **Local dev**: `server.js` calls `app.listen` (guarded by `if (!process.env.VERCEL)`).
- **Vercel**: `api/index.js` re-exports the same `app` as a serverless handler.
  `vercel.json` rewrites all routes to `/api` and bundles `public/**` into the
  function. When changing routing or static-file behavior, both paths must keep
  working — don't add logic that assumes a persistent process.

### Data flow

1. `GET /api/matches?league=<wavl|wavjl>` fetches the upstream HTML from the URL in
   the `SOURCES` map, parses it with cheerio (`parseSchedule`), and returns JSON
   `{ count, league, source, teams, matches }`.
2. Results are held in a 5-minute in-memory cache keyed by league (`cache`,
   `CACHE_MS`) to avoid hammering the source. Note: on Vercel this cache is
   per-cold-start, not shared.
3. Frontend HTML pages in `public/` fetch `/api/matches` and render client-side.

### Adding a league

Add an entry to the `SOURCES` map (key = league slug, value = upstream schedule
URL with `?layout=datetime`). Then add a `public/<league>-schedule.html` page and
a pretty route in `server.js` (mirroring the `/wavl-schedule` and
`/wavjl-schedule` handlers). Roster pages select a league via the query string,
e.g. `fetch("/api/matches?league=wavjl")`.

### Pages

- `public/index.html` — full Reds match list with filters, scores/results, CSV
  export, and shareable URL state. Hardcoded to WAVL (`fetch("/api/matches")`).
- `public/wavl-schedule.html`, `public/wavjl-schedule.html` — duty & bag roster
  views grouped by date, one row per Reds team that is playing, annotated with
  that team's "work" (duty) assignment. Served at `/wavl-schedule` and
  `/wavjl-schedule`.

## Parsing assumptions (the fragile part)

`parseSchedule` is tightly coupled to the upstream HTML structure. If scraping
breaks, these are the assumptions to recheck:

- Each date is its own `table.division-schedule`; the date is in `thead h3`.
- Game rows are `tr.game`; columns are positional `<td>`s in order:
  time, venue, court, division, home, away, work, score.
- Venue full names come from a legend of `[id^="venue-"]` elements at the bottom;
  the abbreviation prefix (`"Aquin - Aquinas College"`) is stripped to the name.
- The winning team's `<td>` carries `class="winner"`.

### Reds-specific derived fields

- A match is kept if a Reds team is home, away, **or** the work (duty) team
  (`isReds` = `/\breds\b/i`).
- `result` is from the Reds perspective: `W`/`L` if a Reds team played, `N/A` if
  Reds only had work duty, `""` if not yet played.
- `setScore` (e.g. `"3-1"`) is flipped to the Reds perspective when Reds are away.
- `teamSortKey` orders teams by division (State League `SL` first, then `D1`,
  `D2`, …) and within a division by grade M, W, RM, RW (`R` = reserves).
