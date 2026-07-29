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

Refreshing is just re-running the scrape. Nothing is overwritten: new prices
append to the unit's history, units that vanish from the feed are marked
leased, and a re-run against unchanged data is a complete no-op.

To add what an agent told you:

```bash
npm run ingest -- --building the-leo --file tour-email.txt
pbpaste | npm run ingest -- --building the-leo          # straight from the clipboard
```

To try the whole thing without touching anyone's website:

```bash
npm run fixture -- --port 4310 --round 1   # a stand-in leasing site
npm run scrape  -- --add http://127.0.0.1:4310/
npm run scrape  -- 127-0-0-1
# restart the fixture with --round 2 and scrape again to watch the refresh
```

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

### 4. What the rent actually includes

Advertised rent is not comparable across buildings. The Leo quotes rent and
bills a separate bundled-utility fee that scales with unit type ($50 studio →
$115 two-bed) plus $65 internet; Old Town Park splits utilities through RUBS
and adds $375 parking and a $12 liability waiver; Stead 220 quotes an "all in"
number with utilities already inside it. Comparing the headline numbers
compares three different things.

So every levy is modelled as a `Charge` and the all-in figure is computed:

```
$5,050  base rent                 unit 707, The Leo
   $65  internet (Zentro)
  $115  bundled utilities, 2 bed   gas, water, sewer, trash, recycling
------
$5,230  all-in monthly            + metered electric on your own ComEd account
  $575  on signing                 $500 admin + $75 application
```

Two rules keep it honest. A charge with no fixed amount — a RUBS split,
metered electric — is never treated as zero; it is carried as a variable line
so an all-in total reads as a floor rather than a promise. And a fee sheet's
unit-type rows are alternatives, not a list to sum: a "1 Bedroom + Den" pays
the $105 den tier *instead of* the $90 one-bedroom tier.

### 5. Agent emails

Tour follow-up emails are the highest-quality source in the pipeline, and the
only one that states a unit's orientation outright — "Southeast facing view",
"Views Facing South", "View: South-West facing". A scraped listing page never
says which way a unit looks; the agent always does.

`npm run ingest` reads unit blocks (rent, all-in, size, lease term, move-in
range, tower designator) and fee schedules out of that prose, then feeds the
stated facings back into the geometry solver as observations. Compound compass
directions are matched before their components, and a direction is only
trusted next to "view"/"facing"/"exposure", so "741 N Wells St" is not read as
north-facing.

Floor-plan PDFs are worth keeping for the same reason: most carry a key plate
showing every tier on the plate with a north arrow, which pins the arrangement
down completely.

### 6. Price tracking

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
| `npm run ingest -- --building <slug> --file <email>` | Ingest an agent's tour email |
| `npm run seed:demo` | Load two synthetic buildings |
| `npm run fixture -- --port 4310 --round 1` | Run a stand-in leasing site |
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
3. **The compass exposures look wrong.** Ingest a tour email stating any
   unit's facing. With no observations the line arrangement is only a
   convention (clockwise from the north-west, ascending line number); with one
   or two it is fitted, and the model reports the fit error.

---

## Layout

```
src/lib/scrape/     adapters, robots-aware fetcher, shape recognition
src/lib/massing/    BuildingSpec schema, geometry solver, persistence
src/lib/floorplan/  floor plate and unit plan schemas
src/lib/units/      unit-code parsing, placement solver
src/lib/pricing/    charge model and the all-in calculation
src/lib/ingest/     agent-email parsing
src/lib/db/         Drizzle schema and queries
src/lib/testing/    the stand-in leasing site
src/components/     3D viewer, explorer, charts
scripts/            scrape / ingest / infer / seed / fixture CLIs
tests/              126 tests, including a full scrape-and-refresh run
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
