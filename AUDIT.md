# chiapartment audit — 8 Sep 2026

Audit of [rooneydude/chiapartment](https://github.com/rooneydude/chiapartment) (live: https://rooneydude.github.io/chiapartment/#/). Default / Pages production branch is `claude/repo-reset-4my0gv`.

**Scope:** architecture, scraper reliability, snapshot history integrity, product gaps for Jonathan (studios + 2-beds, weekday briefs, Leo / OTP / 1225 / Stead), code quality, and a prioritized backlog. No redesign. Committed `data/snapshots/*.json` were not modified.

**Verified (not assumed) against origin HEAD `1a431b6` (snapshot 2026-09-08T10:59:10Z), PR #34, Actions logs, and the live Pages JSON.**

---

## History-preservation status: SAFE (with caveats)

| Check | Result |
|---|---|
| Snapshots are append-only committed JSON | **Yes.** `refresh()` only writes a new file. Git history is the database. |
| Failed scrapes do not overwrite last-good prices | **Yes.** `status: "error"` + `units: []`. `build-data` serves the last `ok` run and flags `scrape-error`. |
| PR #34 lease-cap does **not** rewrite past snapshots | **Yes.** Filter is scrape-time only. 7 Sep still has the eight 18-month teasers; 8 Sep omits them. |
| `build-data` never writes back into `data/snapshots/` | **Yes.** Output is gitignored `web/public/data/`. |
| Retention | **All 47 snapshots kept** (2026-08-03 → 2026-09-08, ~1.7 MB). No pruning. |
| Schema tripwire | **This PR adds** `scraper/test/snapshots-history.test.ts` so tightening `SnapshotSchema` cannot silently skip historical files at compile time. |

**Do not:** delete, squash, rebase-away, or rewrite `data/snapshots/`. Do not back-apply the 14-month cap onto old 1225 rows. Do not make new unit fields required without `.optional()` / defaults — `build-data` **skips** snapshots that fail Zod parse (history would vanish from the dashboard while files still sit in git).

**Current methodology discontinuity (not data loss):** from 8 Sep, 1225 omits units whose only advertised price needs >14 months. Deltas, “gone” badges, and the `count-drop` warning compare 14 → 6 listings as if inventory vanished. Those units’ earlier prices remain in `perUnit` / old snapshots, including 18-month teasers that are **not** comparable to shoppable 12-month quotes.

---

## 1. Architecture

```
GitHub Actions "Refresh prices"  (cron 14:00 UTC daily + manual + .github/refresh-trigger push)
  └─ scraper adapters (cheerio / SightMap API / Playwright)
       └─ data/snapshots/<ISO>.json     ← committed, append-only
            └─ npm run build:data       ← compile per-building JSON (gitignored)
                 └─ Vite static app     ← HashRouter, base /chiapartment/
                      └─ GitHub Pages   (workflow deploy, not branch-from-folder)
```

No database, no server. Price “API” is the compiled static files:

- `https://rooneydude.github.io/chiapartment/data/config.json` — buildings + `health.buildings[id]` warning counts
- `https://rooneydude.github.io/chiapartment/data/buildings/<id>.json` — latest units, run-over-run `delta`, `perUnit`, `perFloorplan`, `perUnitMeta`, `runs`, `lastAttempt`, `warnings`

| Layer | Key files |
|---|---|
| Config | `buildings.json` (`focus.beds: [0, 2]`, `maxLeaseTermMonths: 14`) |
| Adapters | `sightmap` (1225), `oldtownpark` (OTP I–III), `leo`, `stead220`; unused: `generic`, `playwright-generic` |
| Pipeline | `scraper/src/run.ts`, `build-data.ts`, `alerts.ts`, `unitmap.ts`, `skyline.ts` |
| Model | `shared/src/types.ts` (`Snapshot` vs compiled `BuildingHistory`) |
| Deltas | `shared/src/delta.ts` — keyed by `unitNumber`; floorplan-only rows excluded |
| Web | `web/src/routes/{Dashboard,BuildingPage}.tsx` + 3D scene |
| Workflows | `refresh.yml` (scrape + commit + alert issues + chained deploy), `deploy.yml` (Pages) |

OTP towers share `group: old-town-park` but **not** a scrape cache: `adapterOptions.towerPath` differs, so each tower is fetched separately (correct).

---

## 2. Reliability

### PR #34 (merged 8 Sep 10:53Z) — verified

- Leo: parse Jonah `#jd-fp-data-script-app` JSON first; detect Imunify360; 3 Chromium attempts; `domcontentloaded` + tracker abort (no `networkidle`).
- Refresh: retry failed buildings after 8s.
- 1225: skip over-cap units when the leasing matrix has no ≤14-month price.
- UI: `lastAttempt`, scrape-failed banner vs last-good copy; Stead sparkline falls back to floorplan mins.

### Post-merge refresh (Actions `34218249186`, snapshot `2026-09-08T10-59-10Z`)

| Building | Result | Notes |
|---|---|---|
| The Leo | **4 listings, health 0** | Recovered. Plain-HTTP path succeeded from GH Actions this run (~0.8s). |
| 1225 Old Town | 6 listings, **health 1** | 8 units skipped (18-month teasers, no in-cap matrix). `count-drop` 14→6. **Not a scrape failure** (`lastAttempt.status: ok`). |
| OTP I / II / III | 18 / 21 / 27 ok | OTP II 22→21 (one unit actually gone). |
| Stead 220 | 15 ok | 3 real unit numbers (PH); rest floorplan/stack. |

### Leo error history (9 / 47 runs)

Same message family since 3 Aug: `no floorplan cards parsed` or Playwright `page.content` mid-navigation. Last failure 7 Sep. Imunify360 on GitHub IPs remains the residual risk; PR #34 mitigates, does not eliminate. Follow-up if it flakes again: self-hosted runner or allowlist — **not** rewriting snapshots.

### Other reliability notes

- **HTTP:** 3 retries, 30s timeout, backoff on 429/5xx (`http.ts`). Playwright-generic still uses `networkidle` (unused by current buildings).
- **Schedule:** `0 14 * * *` (every day, not weekdays). GitHub cron is often late: many “morning” runs landed 16:30–18:40 UTC (11:30–13:40 CDT), some at 23:xx. Not a data-loss issue; it **is** a problem for a 8am weekday brief.
- **Workflow always greens** if any buildings scrape: a Leo miss still commits + deploys stale Leo. After PR #34 the dashboard says so; before, only `⚠ data`.
- **Double deploy:** snapshot push triggers `deploy.yml` *and* `refresh.yml` calls it via `workflow_call`. `concurrency: pages` cancels in-progress. Wasteful, not harmful.
- **Partial snapshot:** `2026-08-18T15:16:51Z` contains **only 1225** (capture trigger). Other buildings simply have no point that run (`missing=1`). Uneven calendar, not corruption.
- **Aug 7→10 gap (~72h):** before daily cron (`b81ba2f`). No gap >36h since daily started.

---

## 3. Data integrity

### Snapshot format

```text
{ schemaVersion: 1, timestamp, buildings: [{ buildingId, status, error?, source, units[] }] }
```

Unit rows: `unitNumber | null`, `floorplanName`, `beds`, `baths`, `sqft`, `price`, optional `priceMax` / `leaseTermMonths` / `specials` / `url`, `availableDate`. Older rows without `leaseTermMonths` still parse (field is optional) — 5,479 listings across four key-shapes; none fail current Zod.

### Per-unit history

Compiled only from **ok** runs. Identity = `unitNumber`.

| Building | Unit-level series | Floorplan-only |
|---|---|---|
| 1225 | Yes (SightMap numbers) | Early noise only |
| OTP I–III | Yes | No |
| Leo | Yes (after first real adapter) | First snapshot had some plan-level rows |
| Stead 220 | Sparse (PH `2802`-style only) | **Dominant** — alerts/deltas ignore these |

`perUnitMeta.firstSeen` / `firstPrice` never overwrite. Unit maps (`data/unitmaps/`) merge, never replace.

### Deltas

`build-data` diffs consecutive **ok** runs (Leo 8 Sep delta is vs 6 Sep, skipping the 7 Sep error). `alerts.ts` diffs consecutive **snapshot files**; if yesterday was `error`, that building is skipped and a recovery-day drop can be missed.

Floorplan-only listings never appear in new/removed/price-change. Stead price moves are largely invisible to alerts and the “biggest recent drop” tile.

### Lease-term handling

Only 1225 exposes terms. Cap is 14 months, applied **at scrape**:

1. Advertised term ≤14 → keep advertised price.
2. Term >14 + matrix has ≤14 price → quote cheapest in-cap (often *higher* than the teaser).
3. Term >14 + no in-cap price → **omit the unit** (PR #34). Previously the teaser was kept.

8 Sep skip list (still present, with 18-month prices, in the 7 Sep snapshot): `#0523,0812,0817,0917` studios, `#1503` 2BR, plus 1BR/3BR teasers. Dashboard “gone” = those eight. Focus inventory on 1225 is now **two studios, zero 2-beds**.

`count-drop` cannot tell “lease-cap omit” from “partial scrape.” Health badge is `⚠ data`, not `⚠ scrape failed` (correct after PR #34), but the tooltip still says “possible partial scrape.”

### `focus.beds`

UI, cheapest tiles, alerts, and dashboard badges filter to studios + 2BR. 1BRs are scraped and stored (good — history stays complete) but omitted from briefs/alerts.

---

## 4. Product gaps (Jonathan)

**What works today**

- Six buildings, real prices, 3D + table + charts.
- Focus beds [0, 2]; 2BR tile shows `/person split`.
- Last-good vs last-attempt after a failed scrape (PR #34).
- GitHub issues on focus-bed drops / new listings / scrape errors → phone via GitHub mobile Watch.
- Compiled JSON is enough raw material for a weekday brief (full `runs` + `perUnit` back to 3 Aug).

**Gaps**

1. **No weekday brief.** Alerts are per-refresh GitHub issues (20+ left OPEN). They mix drops with scrape errors, never close, and are run-over-run (a same-day extra refresh makes “since yesterday” wrong). Cron is daily including weekends and often late.
2. **1225 look-through-teaser vs shoppable.** Cheapest-studio tile is now honest ($2,390 @ 12mo, unit 0624) but the building looks half-empty and “5 gone” in focus. Historical charts still mix teaser mins into floorplan series.
3. **Stead is a stack catalog**, not a unit tracker. No drop alerts, weak 3D unit pick. Fine if Jonathan only needs a starting-at price; not fine for “did 2204 drop.”
4. **Leo studio coverage is thin** (often zero studios on market; current four listings are 1BR+2BR). When Leo fails, a whole building disappears from the morning picture unless you notice the banner.
5. **OTP is the healthiest feed** (stable counts, real unit numbers, ranges, dates) — should be the backbone of any brief.
6. **README data-status table was stale** (claimed `playwright-generic` for Leo/1225, “no unit numbers” on Leo). Corrected in this PR. Stack maps are still mostly quadrant guesses except 1225 SightMap sidecar.

---

## 5. Code quality, CI, branches, docs

| Topic | Finding |
|---|---|
| Tests | Solid fixture + unit coverage (`vitest`: adapters, lease-cap, build-data warnings, alerts, parse, geo). **No test workflow existed** — PRs could merge with a red suite; Pages-only CI. This PR adds `.github/workflows/test.yml`. |
| Typecheck | `npm run typecheck` across workspaces; not run in old CI. |
| Default branch | `claude/repo-reset-4my0gv` — agent leftover. `deploy.yml` hardcodes it + `main`. Renaming without updating workflow **stops Pages**. |
| Pages API `source.branch` | Still `claude/chicago-apartment-3d-models-xs68so` (pre-reset SQLite app, last commit 31 Jul). Live site is **workflow** deploy, so this is dormant — but flipping Pages back to “branch” would publish the **wrong repo**. Delete or archive that branch only after confirming workflow-only Pages. |
| Docs | README told adapters to “delete sample snapshots” — **history hazard**. Removed in this PR. |
| Issues | Price-alert issues accumulate forever (no `price-alert` label close, no digest). |
| Branch protection | Could not read (token 403); assume unprotected default + Actions `contents: write` can push snapshots directly. |

---

## 6. Backlog

Effort: **S** = small PR, **M** = a few files / careful data semantics, **L** = product work. History risk: **none** / **low** (optional new fields only) / **high** (touches snapshots).

### P0 — do soon; none need snapshot rewrites

| ID | Item | Effort | History risk | PR now? |
|---|---|---|---|---|
| P0.1 | Run tests + typecheck on every PR (and optionally on push) | S | none | **Yes — this PR** |
| P0.2 | Forbid deleting/rewriting snapshots in README + schema parse test over all committed files | S | none | **Yes — this PR** |
| P0.3 | Treat 1225 `count-drop` as explained: record scrape-time `omitted[]` (term, advertised price) as an **optional** snapshot field; don’t fire `count-drop` when omit accounts for the delta. **Do not rewrite 7 Sep.** | M | low (additive) | Not this pass — wait until the badge is confusing Jonathan |
| P0.4 | Coordinated default-branch rename to `main`: update `deploy.yml`, repo default, Pages; do **not** delete snapshot history | S ops | none if fast-forward only | Separate ops PR; don’t rush |

### P1 — product / reliability

| ID | Item | Effort | History risk | PR now? |
|---|---|---|---|---|
| P1.1 | Weekday brief: weekday cron (`0 13 * * 1-5`) + one markdown issue (or discussion) that diffs **calendar yesterday vs today** on `focus.beds`, then close or skip stale alerts. Read compiled history; don’t mutate snapshots. | M | none | No |
| P1.2 | Alerts: diff last two **ok** runs per building (match `build-data`), include Stead floorplan identity (`floorplanName`+beds) as a second key | S | none | No |
| P1.3 | Snapshot metadata: `buildingsFilter`, adapter versions — optional fields so partial runs are obvious | S | low | No |
| P1.4 | If Leo fails again from GH IPs: self-hosted runner / allowlist. Keep writing `status: error`. | ops | none | Only if it flakes post-#34 |
| P1.5 | Chart / sparkline: keep historical units that are not currently listed (or a “include off-market” toggle) so 1225 teasers remain visible as history, labeled by term | M | none (compile/UI only) | No |
| P1.6 | Auto-close or collapse old `Price alert` issues; add label | S | none | No |

### P2 — polish

| ID | Item | Effort | History risk |
|---|---|---|---|
| P2.1 | Deduplicate refresh→deploy double workflow | S | none |
| P2.2 | Align `playwright-generic` wait with `domcontentloaded` (unused today) | S | none |
| P2.3 | Real stack facings beyond guesses; Stead per-unit if RentCafe ever SSR’s them | M | none |
| P2.4 | Archive `claude/chicago-apartment-3d-models-xs68so` after Pages source is confirmed workflow-only | ops | none |
| P2.5 | Don’t `git add scraper/fixtures` on scheduled runs (capture-only) | S | none (fixtures ≠ prices) |
| P2.6 | `health` as `{ warnings, scrapeStatus }` so a count-drop isn’t the same badge shape as a WAF miss | S | none |

---

## What this PR changes (history-safe)

- Adds this audit.
- Adds CI tests so schema/adapter regressions fail the PR, not silent Pages.
- Adds a parse-all-snapshots test (compile-time skip detector).
- Corrects README adapters + **never delete snapshots**.

No snapshot files touched. No adapter behavior change. No backfill of 1225 teasers.
