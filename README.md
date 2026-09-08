# chiapartment

Track rental prices in specific Chicago apartment buildings over time — and see
each unit in 3D: where it sits in its building, rendered among the surrounding
skyline, with an approximate view from the unit's window.

**Dashboard:** https://rooneydude.github.io/chiapartment/

## Tracked buildings

| Building | Address | Floors |
|---|---|---|
| 1225 Old Town | 1225 N Wells St | 16 |
| Old Town Park I–III | 1140/1130 N Wells St, 168 W Oak St | 32/40/41 |
| The Leo | 741 N Wells St | 21 |
| Stead 220 | 220 N Ada St | 29 |

Configured in [`buildings.json`](buildings.json) — add a building by adding an
entry there.

## How it works

```
GitHub Actions "Refresh prices" (manual button)
  └─ scraper (adapter per leasing site)
       └─ data/snapshots/<timestamp>.json   ← committed, append-only history
            └─ build-data → static JSON → Vite dashboard → GitHub Pages
data/skyline.geojson ← OSM footprints+heights via Overpass (rare regeneration)
```

- **No database, no servers.** Price history is a folder of committed JSON
  snapshots; the dashboard is a static site reading compiled versions of them.
- **Refresh.** Runs automatically every morning (Chicago time), or on
  demand via the **Refresh prices** workflow in the Actions tab (or
  `npm run refresh` locally, `-- --commit` to also commit). Each run appends
  one snapshot. Run-over-run deltas (new / removed / price changes) compare
  the last two **successful** scrapes per building; the weekday brief
  compares Chicago calendar days.
- **Weekday brief.** Compiled at build time as
  [`brief.json`](https://rooneydude.github.io/chiapartment/data/brief.json)
  (also `focusDelta` on each `data/buildings/<id>.json`). Studios + 2-beds
  only: new / removed / price drops since the last successful scrape on a
  **prior Chicago calendar day**. Same-day extra refreshes do not reset
  “since yesterday.” The existing Grok bot can keep reading live building
  JSON; `delta` is unchanged in shape (additive `beds` on price changes,
  plus floorplan identity for Stead stacks).
- **Lease-term cap.** `focus.maxLeaseTermMonths` (14) keeps quoted prices
  honest: where a site tags prices with lease terms (1225 Old Town's
  SightMap), a price that requires a longer lease is replaced by the
  cheapest price at a term within the cap, pulled from the unit's leasing
  calendar API — or the unit is omitted when no in-cap price exists.
  Future scrapes record those skips as optional `omitted[]` (unit, term,
  advertised price) so a count-drop is explainable. Applied **at scrape
  time only**; past snapshots are never rewritten.
- **Price alerts.** When a refresh finds a focus-bed price drop or new
  listing (including Stead floorplan/stack identity), the workflow opens a
  GitHub issue. Alerts compare the last two **ok** scrapes per building, so
  a failed Leo run does not look like every unit vanished. Prefer
  `brief.json` for the morning digest — GitHub issues are a phone-push
  fallback. **To get issues as phone notifications:** install the GitHub
  mobile app and Watch this repository (Custom → Issues, or All Activity).
- **3D.** Building footprints come from OpenStreetMap (`npm run skyline`),
  extruded to their tagged heights. A unit's floor is parsed from its unit
  number; its position on the floorplate comes from the per-building
  `unitMapping.stacks` table (stack → facade + position). The
  "view from unit" camera stands at the unit's facade looking outward, so
  neighboring building masses show what would block the view.

## Commands

| Command | What it does |
|---|---|
| `npm run refresh` | Scrape all buildings → write a snapshot (no commit) |
| `npm run refresh -- --commit` | …and commit the snapshot |
| `npm run refresh -- --fixtures` | Offline run against `scraper/fixtures/` |
| `npm run refresh -- --capture` | Live run that saves raw responses as fixtures |
| `npm run skyline` | Regenerate `data/skyline.geojson` from Overpass |
| `npm run dev` | Compile data + start the dashboard dev server |
| `npm run build` | Production build (what Pages deploys) |
| `npm test` / `npm run typecheck` | Vitest / tsc across workspaces |

Node 22+. `npm install` once at the repo root (npm workspaces).

## Data status

| Building | Adapter | Status |
|---|---|---|
| Old Town Park I–III | `oldtownpark` | ✅ real per-unit prices + ranges from per-tower availability pages |
| Stead 220 | `stead220` | ✅ floorplan/stack prices (plans are stacks; PH plans are real units). Deltas/alerts key stacks by floorplan name + beds. |
| 1225 Old Town | `sightmap` | ✅ per-unit prices/sqft/dates; lease-term cap (14 mo) at scrape time |
| The Leo | `leo` | ✅ per-unit cards from Jonah SSR JSON; Playwright fallback (Imunify360 on GH IPs) |

The stack→facade maps in `buildings.json` are placeholder quadrant guesses
until refined per building (`unitMapping.stacks`), except 1225 which also
has a SightMap-derived `data/unitmaps/` sidecar.

**Price history is sacred.** `data/snapshots/` is append-only. Never delete,
rewrite, squash, or rebase those files away. Failed scrapes are recorded as
`status: "error"` so the dashboard can show last-good data. See [`AUDIT.md`](AUDIT.md).

## Adding/fixing a site adapter

1. Run **Refresh prices** with `capture: true` (or locally
   `npm run refresh -- --capture` from a network that can reach the sites).
   Raw HTML/JSON payloads land in `scraper/fixtures/<building-id>/`.
2. Write an adapter in `scraper/src/adapters/` against those fixtures
   (`npm run refresh -- --fixtures` + tests to iterate offline), register it
   in `adapters/index.ts`, and point the building's `"adapter"` field at it.
3. Leave existing `data/snapshots/` files untouched. A new adapter only
   affects snapshots written after it ships.

The bundled `generic` adapter (JSON-LD → discovered JSON endpoints → DOM
heuristics) and `playwright-generic` (rendered pages + XHR capture) cover many
sites without custom code.

## Repo notes

- `data/skyline.geojson` uses **local meters** around a Chicago origin, not
  lon/lat — it's an internal format for the 3D scene; don't feed it to GIS
  tools.
- The deploy workflow targets the active development branch
  (`claude/repo-reset-4my0gv`); if the default branch changes (e.g. to
  `main`), update the branch list in `.github/workflows/deploy.yml` **before**
  switching the repo default, or Pages stops updating. The pre-reset branch
  `claude/chicago-apartment-3d-models-xs68so` is a different (SQLite-era)
  tree — do not point Pages at it.
- Snapshots of buildings whose scrape failed are recorded with
  `status: "error"` — history stays honest, and the dashboard simply shows
  the last good run.
- PRs run `.github/workflows/test.yml` (`typecheck` + `vitest`), including a
  parse of every committed snapshot so schema changes cannot silently drop
  history at compile time.
