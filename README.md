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
- **Manual refresh.** Run the **Refresh prices** workflow from the Actions tab
  (or `npm run refresh` locally, `-- --commit` to also commit). Each run
  appends one snapshot; deltas (new / removed / price changes) are computed
  between consecutive snapshots at build time.
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
| Stead 220 | `stead220` | ✅ real floorplan/stack prices (plans are stacks; PH plans are single units) |
| 1225 Old Town | `playwright-generic` | ✅ real prices/sqft, unit numbers on some rows (rendered-page heuristics; site's plain-HTTP endpoints sit behind Imunify360, but the full browser gets through) |
| The Leo | `playwright-generic` | ✅ real floorplan-level prices/sqft (no unit numbers exposed) |

The stack→facade maps in `buildings.json` are placeholder quadrant guesses
until refined per building (`unitMapping.stacks`).

## Adding/fixing a site adapter

1. Run **Refresh prices** with `capture: true` (or locally
   `npm run refresh -- --capture` from a network that can reach the sites).
   Raw HTML/JSON payloads land in `scraper/fixtures/<building-id>/`.
2. Write an adapter in `scraper/src/adapters/` against those fixtures
   (`npm run refresh -- --fixtures` + tests to iterate offline), register it
   in `adapters/index.ts`, and point the building's `"adapter"` field at it.
3. Delete the sample snapshot files in `data/snapshots/` in the same commit
   that lands the first real snapshot.

The bundled `generic` adapter (JSON-LD → discovered JSON endpoints → DOM
heuristics) and `playwright-generic` (rendered pages + XHR capture) cover many
sites without custom code.

## Repo notes

- `data/skyline.geojson` uses **local meters** around a Chicago origin, not
  lon/lat — it's an internal format for the 3D scene; don't feed it to GIS
  tools.
- The deploy workflow targets the active development branch
  (`claude/repo-reset-4my0gv`); if the default branch changes (e.g. to
  `main`), update the branch list in `.github/workflows/deploy.yml`.
  Recommended cleanup: make this branch (or `main` cut from it) the repo
  default and delete the stale pre-reset branch.
- Snapshots of buildings whose scrape failed are recorded with
  `status: "error"` — history stays honest, and the dashboard simply shows
  the last good run.
