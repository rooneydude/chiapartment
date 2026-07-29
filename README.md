# chiapartment

Tracks real-time pricing on Chicago apartment buildings and places every listing
where it physically sits in its building — floor, compass exposure, and size.

The core idea: **the building's geometry is derived from the listing data
itself.** Chicago towers number units `<floor><line>` (3208 is line 08 on floor
32), so a building's unit labels plus its published square footages are enough
to solve for the floor plate, work out which way each line faces, and place any
listing in a 3D model — with nobody measuring anything.

---

## Quick start

```bash
npm install
npm run seed:demo        # synthetic building, so you can look around immediately
npm run dev              # http://localhost:3000
```

To track a real building:

```bash
npm run scrape -- --add https://fulbrix.com/    # probe, detect, register
npm run scrape -- fulbrix                       # pull availability
npm run scrape -- --all                         # ...or every registered source
```

`--add` checks `robots.txt` first, fingerprints the leasing platform, scores
every adapter, runs a real test parse, and tells you what it found before
writing anything.

---

## How it works

### 1. Scraping

`--add <url>` probes a site and picks an adapter by detection score:

| Adapter | Handles |
| --- | --- |
| `rentcafe` | Yardi RENTCafé, via the `rentcafeapi.aspx` availability endpoint |
| `appfolio` | AppFolio portals, via `listings.json` |
| `embedded-json` | Availability embedded in the page: `__NEXT_DATA__`, Next.js RSC flight data, Nuxt/Apollo/Redux state, JSON-LD |
| `site-crawl` | Bespoke marketing sites — follows the homepage to `/floorplans`, `/availability` etc. and mines each page |
| `dom-heuristic` | Last resort: availability tables (read via their header row) and unit cards |

Two pieces do most of the work and are worth knowing about:

- **Shape-based recognition** (`src/lib/scrape/shape.ts`). Rather than mapping
  field names per platform, it recognises a unit *by shape* — `unitNumber` /
  `UnitNumber` / `apartment_name` / `unit` all resolve, as do wrapped values
  like `{rent: {amount: 2395}}`. A record needs a plausible unit code **plus**
  corroborating evidence, which is what stops floor-plan objects being read as
  units.
- **Polite fetching** (`src/lib/scrape/http.ts`). `robots.txt` is parsed
  properly (group selection by user-agent, longest-match-wins between
  `Allow`/`Disallow`, `Crawl-delay`, `*` and `$`), requests to a host are
  serialised behind a crawl delay, and responses cache to disk so re-parsing
  during development costs the building nothing. A disallowed path is a hard
  error — there is no override flag.

### 2. Deriving the building

`src/lib/massing/infer.ts` turns listings into geometry:

```
unit labels          → floor range, line vocabulary, skipped floors
unit square footage  → gross plate area (÷ residential efficiency)
plate area + aspect  → plate width and depth
perimeter            → ring depth, from  4d² − P·d + A_units = 0
walk the perimeter   → each line's footprint, and therefore its facing
lines by floor       → podium and setbacks
```

Every step is a real constraint rather than a guess: a plate holding 6,621 sqft
of units at ~78% efficiency *must* be about 8,500 sqft gross, and a ring of
units around a core of that perimeter *must* be about 7 m deep. What it can't
know is absolute orientation and which line sits on which face — those are
assumptions, reported in the UI under "How this model was derived" and recorded
as `provenance.confidence = "estimated"`.

Two details worth calling out:

- **Skipped floors** are only inferred for superstition-numbered floors that are
  absent *and* bracketed by floors that are present. Plain absence means
  "nothing available", not "doesn't exist".
- **Setbacks** are detected with a significance test. Availability is a sparse
  sample, so a line's highest *listed* floor isn't its highest floor; a ceiling
  is only treated as real when it would be surprising under uniform sampling
  (`((f − base)/(top − base))^n < 0.02`) and at least two lines agree.

The solver re-runs after every scrape, so the model sharpens the longer you
track a building.

### 3. Placement

`resolveUnitPlacement()` answers the actual question for a given listing:

- **Floor** — and its height above street, accounting for podium floors,
  per-segment floor heights, and skipped numbers
- **Exposure** — the compass bearing its windows face, with corner units
  reporting multiple exposures (`S + E corner`)
- **Size** — advertised sqft where published, derived polygon area otherwise

### 4. Price tracking

- `price_snapshots` is append-only, one row per unit per material change. A unit
  vanishing from the feed is recorded as `leased` — the disappearance *is* the
  signal that it rented.
- `type_snapshots` rolls up per bedroom count per building on every run: count
  available, min/median/avg/max rent, avg sqft, median $/sqft. This is what
  makes "2-beds here are up $140 this month" answerable without re-aggregating
  the whole history on page load.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app |
| `npm run scrape -- --add <url>` | Probe and register a building |
| `npm run scrape -- <slug>` | Scrape one source |
| `npm run scrape -- --all` | Scrape every enabled source |
| `npm run scrape -- --list` | List registered sources |
| `npm run infer -- <slug> -v` | Re-derive geometry; `-v` prints each line's facing |
| `npm run seed:demo` | Load a synthetic building |
| `npm test` | Run the test suite |

Useful scrape flags: `--dry-run` (parse, print, write nothing), `--adapter <id>`
(force one), `--cache <sec>` (reuse cached pages), `--no-images`, `--no-infer`.

---

## When a site doesn't parse

Run `npm run scrape -- <slug> --dry-run` and read the warnings. The usual causes:

1. **Availability is loaded over XHR.** The crawler only sees the served HTML.
   Open DevTools → Network → Fetch/XHR, find the request returning the unit
   list, and add an adapter for it — `harvestUnits()` will normalise whatever
   JSON it returns, so an adapter is usually just the URL plus a call to it.
2. **Unit labels aren't `<floor><line>`.** Placement needs a floor and a line.
   The run reports how many labels it couldn't split.
3. **The compass exposures look wrong.** Line ordering around the plate is a
   convention (clockwise from the north-west, ascending line number), not a
   verified fact. Correcting it per building is the highest-value manual fix.

---

## Layout

```
src/lib/scrape/     adapters, robots-aware fetcher, shape recognition
src/lib/massing/    BuildingSpec schema, geometry solver, persistence
src/lib/floorplan/  floor plate and unit plan schemas
src/lib/units/      unit-code parsing, placement solver
src/lib/db/         Drizzle schema and queries
src/components/     3D viewer, explorer, charts
scripts/            scrape / infer / seed CLIs
tests/              63 tests over parsing, geometry and detection
```

Data lives in `data/chiapartment.db` (SQLite, gitignored). Set `CHIAPARTMENT_DB`
to move it.

---

## Notes and limits

- Geometry is **estimated from listings**, not surveyed. The UI says so, and
  every assumption is listed in the model panel.
- Only units whose labels carry a floor and a line can be placed. Penthouse
  labels like `PH02` resolve a line but no storey.
- Scraping runs locally and respects `robots.txt`. Check a building's terms
  before pointing it at their site.
