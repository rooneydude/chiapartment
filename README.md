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
GitHub Actions "Refresh prices" (daily schedule, or the manual button)
  └─ scraper (adapter per leasing site)
       └─ data/snapshots/<timestamp>.json   ← committed, append-only history
            └─ build-data → static JSON → Vite dashboard → GitHub Pages
data/skyline.geojson ← OSM footprints+heights via Overpass (rare regeneration)
```

- **No database, no servers.** Price history is a folder of committed JSON
  snapshots; the dashboard is a static site reading compiled versions of them.
- **Refresh.** Scheduled once a day for 14:17 UTC (8–9 am Chicago) —
  GitHub often starts scheduled runs late (in Nov 2026 by 4½–11½ hours), so
  read it as "once a day", not "every morning". Also on
  demand via the **Refresh prices** workflow in the Actions tab (or
  `npm run refresh` locally, `-- --commit` to also commit). A commit that
  changes `.github/refresh-trigger` on the published branch starts one too
  (its words are flags: `capture`, `skyline`, `buildings=a,b`) — which is
  also how merging a change to the scraper can take a fresh snapshot at
  once. Each run appends one snapshot. Run-over-run deltas (new / removed / price changes) compare
  the last two **successful** scrapes per building; the weekday brief
  compares Chicago calendar days.
- **Deploy, and a look at the result.** Every refresh ends by rebuilding
  and publishing the site; so does every push to the published branch.
  Deployments wait for one another: only one run at a time builds and
  publishes. Publishing pauses twenty seconds after it has uploaded the
  site and, if it fails, is tried once more a minute later: GitHub does
  not always know of an upload in the moment after taking it, and its
  publishing step asks only once (on 24 Nov 2026 two refreshes in a row
  failed there). After each deployment a second job — outside that queue —
  looks at the live site and fails, saying what it found, unless the page
  is the copy that was just built, or a later one, and holds the newest
  snapshot on the branch (`scraper/src/verify-live.ts`). A green run
  therefore means the page shows the newest data there is. A red
  **publish** job means the page was not updated, and a red **verify** job
  that it is behind or could not be read; neither ever means that data was
  lost: every snapshot is committed before anything is deployed, and the
  next deployment publishes all of them.
- **Weekday brief.** Compiled at build time as
  [`brief.json`](https://rooneydude.github.io/chiapartment/data/brief.json)
  (also `focusDelta` on each `data/buildings/<id>.json`). Studios + 2-beds
  only: new / removed / price drops since the last successful scrape on a
  **prior Chicago calendar day**. Same-day extra refreshes do not reset
  “since yesterday.” The existing Grok bot can keep reading live building
  JSON; `delta` is unchanged in shape (additive `beds` on price changes,
  plus floorplan identity for Stead stacks).
- **Nothing is filtered at scrape time.** Every unit a leasing site lists is
  recorded, at the rent and lease length the site itself advertises — so a
  row can be checked against the website at a glance. No lease-length cap,
  no move-in-date cut-off. (A 14-month cap ran from 8 Sep to 14 Nov 2026 and
  hid every 1225 unit that was not vacant yet; it is gone. Snapshots from
  that period carry the hidden units in `omitted[]`, and the compiler folds
  them back into each unit's history.) Rows a site lists without a price or
  a bed count ("Contact for Pricing", penthouse/townhome plans) are kept in
  `alsoListed[]` and shown under the table instead of vanishing.
- **Lease terms.** Where a site publishes them (1225 Old Town), each unit
  carries its full lease-term price table (`leaseTerms`: 2–18 months → rent,
  quoted for the unit's own earliest move-in day). The dashboard shows the
  advertised term, the 12-month price next to it
  (`focus.compareLeaseTermMonths`), the whole table when a row is opened,
  and can re-price the table at any lease length. Choosing a lease length
  is a view setting — it never changes what is stored. See *Data status*
  for what each building does and does not publish.
- **Move-in dates.** `availableDate` is the earliest move-in day as a
  Chicago calendar date; `availableNow` marks units the site says can be
  moved into today, and `vacantSince` says how long they have sat empty
  when the site tells. The table shows "Now" or the date and can filter by
  move-in window (default: any).
- **Like-for-like changes.** A price change is only a price change when the
  two prices are comparable. If the site merely switches which lease length
  it headlines, the old term's price is looked up in the new lease table;
  if that is impossible — or the site flips between a rent range and a
  single price, which Old Town Park does for some plans within minutes —
  the change is recorded with `notComparable` and never alerted on.
- **Price alerts.** When a refresh finds a like-for-like focus-bed price
  drop or a new listing (including Stead floorplan/stack identity), the
  workflow opens a GitHub issue that states the lease term and move-in date.
  Alerts compare the last two **ok** scrapes per building, and only for
  buildings the latest run actually scraped, so neither a failed Leo run nor
  a single-building refresh re-announces old news. A unit that left and
  came back is announced as back, not new; one refusal by a site's bot
  protection does not open an issue (a streak does). Prefer `brief.json` for
  the morning digest — GitHub issues are a phone-push fallback. **To get
  issues as phone notifications:** install the GitHub mobile app and Watch
  this repository (Custom → Issues, or All Activity).
- **3D.** Building footprints come from OpenStreetMap (`npm run skyline`),
  extruded to their tagged heights. Every listed unit is marked on its
  tower, coloured by bed type; a legend counts them and says how sure each
  position is: **exact** (1225 only — from the building's own unit map),
  **side estimated** (the floor is parsed from the unit number, the side
  comes from the hand-made `unitMapping.stacks` table, which is mostly
  unverified), **side unknown** (a band round the floor) or **floor
  unknown** (a strip up a face, for a site that lists plan stacks). Units
  outside the current filter are drawn hollow, not hidden. Hovering or
  clicking a mark shows the unit, rent and move-in date and selects its
  row. The scene is lit for today's sun over Chicago at the hour on the
  slider (or `?t=17.5` in the URL), so it shows which sides get light
  when; "view from unit" stands at the unit's facade looking outward, so
  neighbouring building masses show what would block the view. Where WebGL
  is not available the 3D panel says so and the rest of the page works.

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
| `npm run test:browser` | The dashboard in a real browser (after `npm run build`; needs Chromium: `npx playwright install chromium`) |

Node 22+. `npm install` once at the repo root (npm workspaces).

**What the tests cover.** `npm test` runs the scrapers against recorded
pages, the change detection and the compiler — and the refresh job itself.
Its flag handling is code (`scraper/src/ci-flags.ts`). Its commit-and-push
step (`.github/scripts/commit-snapshot.sh`) is run against real throwaway
repositories: a pull request merged during the scrape, another refresh run
that pushed first (the two runs' unit maps are merged by
`.github/scripts/merge-unitmap.mjs`; one that cannot be merged stays as it
landed and the prices go through), changes that do not go together with
what landed (the step stops and pushes nothing), a remote that refuses.
And the job is
rehearsed offline by running the workflow's own commands
(`scraper/test/refresh-rehearsal.test.ts`): the command and variables of
the browser check, the flags, the scrape and the alert step, and of the
alarm for a day when nothing could be read, are read out of `refresh.yml`
and run with `bash -e` in a throwaway copy of the project. Not run by any
test: installing dependencies and the browser, and the skyline and unit-map
steps, which ask outside services — their command lines are pinned instead.
That test lists every step and job of the workflow, and its reader refuses
settings it does not reproduce (another shell or working directory,
workflow- or job-wide variables), so a change of that kind fails until it
has been looked at there. `npm run test:browser` drives the built dashboard
in Chromium against a few days of hand-made snapshots compiled by the real
compiler; the 3D view is judged by its picture. Both run on every pull
request. The two tries at publishing are GitHub's own steps under GitHub's
own conditions, which nothing here can run: the test holds their wiring word
for word, and says what each word is for. The check that follows a deployment is rehearsed too, against a
stand-in for the live site: one that serves what was built, one that is a
snapshot behind, one whose copy arrives a moment late, one built from the
wrong commit, and one that takes the call and says nothing.

## Data status

What each leasing site publishes — and therefore what the tracker can show.
Verified against the live sites on 15 Nov 2026.

| Building | Adapter | Units | Lease terms | Move-in dates | Notes |
|---|---|---|---|---|---|
| 1225 Old Town | `sightmap` | every unit, with sqft | ✅ full table per unit, 2–18 months, for the unit's move-in day | ✅ date per unit; "now" flagged; vacancy date from the marketing page when reachable | Rent is base rent. Required monthly charges on top (a utility bundle, electricity, renter's insurance) are recorded as `monthlyFees` when the feed puts amounts on them ($100–$230 until 16 Nov 2026) and named in `monthlyFeesUnpriced` when it only says "Varies" (since 17 Nov 2026). The marketing page (specials, "vacant since") answers GitHub's runners with HTTP 403 on some days; that is recorded in the snapshot's `gaps` and shown on the page. "18 Months" on the site is the *longest* lease at the cheapest price, not a requirement — often 12 months costs the same. |
| Old Town Park I–III | `oldtownpark` | every unit; interior + outdoor sqft | ❌ not published — only a rent **range** per unit (cheapest–dearest option). Per-term prices are in the leasing portal behind a bot challenge the tracker does not go around; every row deep-links there. | ✅ "Available" or a date per unit | "Jr. 2 Bed" / "1 Bed + Flex" / "Convertible" kept as `planType`. Penthouse / townhome rows have no published bed count → `alsoListed`. The site alternates between two pricing states for a few plans; the runner takes a second look and the pipeline never treats a range↔single flip as a price move. Rent is base rent: the page's own fee guide adds required monthly charges, recorded since 23 Nov 2026 — a $12 liability waiver as `monthlyFees`, allocated utilities and electricity named in `monthlyFeesUnpriced`. A guide row that names its towers is read on those towers' pages only, and one for a kind of suite is named, not summed; if the guide cannot be read the page says so. A unit the site has not priced yet prints “$-1”; it is listed without a price and said to have none. |
| The Leo | `leo` | every unit, with sqft | ❌ not published (one "starting at" price, which the site says may already include concessions) | ✅ "Available Now" (+ vacant since) or a date | Read from the page's embedded inventory in one request. A "JR 1 Bedroom" is filed as the site files it (0 bedrooms) under its own name. The site special is recorded as a notice. A page with an empty inventory is an empty building, not an error. When the site's bot protection refuses the request, that is recorded (`blocked`) and left alone — no browser, no retry; the next scheduled run asks again. |
| Stead 220 | `stead220` | **floorplans/stacks, not units** (penthouse plans are real units); no sqft | ❌ not published | ⚠️ hardly any — an active plan says "Available now" (recorded as available now), now and then a date (kept), and the penthouses "Contact for availability" (nothing recorded) | The page is a **1–5 day delayed copy** of the building's price list; each price carries the day the building last edited it (`sourceUpdatedAt`). "Contact for Pricing" and switched-off plans → `alsoListed` (with the price they last carried). Live and per-floor prices exist only behind `/api/`, which the site's `robots.txt` disallows — the tracker does not fetch it. Real per-unit inventory is in RentCafe behind a bot wall. Whatever the bar across the top of the page says is recorded as a notice (“6 WEEKS FREE on select apartments”, 23 Nov 2026), unless it is only an invitation (“Now leasing in Fulton Market”, 15 Nov), which is logged and left out. |

Each building's `publishes` block in `buildings.json` records these facts
for the dashboard: an empty cell reads "the site does not publish this"
only where the site really does not; otherwise it reads "not recorded in
this snapshot" (an older snapshot, or a detail request that failed).

The stack→facade maps in `buildings.json` are placeholder quadrant guesses
until refined per building (`unitMapping.stacks`), except 1225 which also
has a SightMap-derived `data/unitmaps/` sidecar (exact positions for every
unit the site has listed since August).

**Price history is sacred.** `data/snapshots/` is append-only. Never delete,
rewrite, squash, or rebase those files away. Failed scrapes are recorded as
`status: "error"` so the dashboard can show last-good data. See [`AUDIT.md`](AUDIT.md).

## Adding/fixing a site adapter

1. Run **Refresh prices** with `capture: true` (or locally
   `npm run refresh -- --capture` from a network that can reach the sites).
   Raw HTML/JSON payloads land in `scraper/fixtures/<building-id>/`; a
   re-capture replaces the previous one (older captures worth keeping as
   regression cases live under `scraper/fixtures/legacy-2026-09/`).
2. Write an adapter in `scraper/src/adapters/` against those fixtures
   (`npm run refresh -- --fixtures` + tests to iterate offline), register it
   in `adapters/index.ts`, and point the building's `"adapter"` field at it.
3. Leave existing `data/snapshots/` files untouched. A new adapter only
   affects snapshots written after it ships.

Rules every adapter follows (and `scraper/test/site-adapters.test.ts`
enforces):

- **Record what the site says.** `price` is the site's own advertised rent,
  `leaseTermMonths` the term it is advertised for. Never re-price, never
  drop a unit because of its lease length or move-in date.
- **Never drop a row silently.** A row without a price or bed count goes to
  `ctx.reportAlsoListed(...)`; a building-wide special to
  `ctx.reportNotice(...)`.
- **"Today" is the Chicago day**, taken from `ctx.now()` so tests can pin it;
  dates are calendar days (`YYYY-MM-DD`), never timestamps.
- **Do not go around bot protection.** Where the data sits behind a
  challenge (SecureCafe / RentCafe), store the deep link and stop.
- **An empty page is not always an error.** Distinguish "the building lists
  nothing" (ok, 0 units) from "we were served something else" (throw).

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
