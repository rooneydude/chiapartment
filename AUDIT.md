# chiapartment audit — 15 Nov 2026

Full audit of the tracker against the live leasing sites, prompted by the
owner's worry that it "isn't working properly", plus the fixes it led to.
Every building's site was read live on 15 Nov 2026 and compared, unit by
unit, with what the tracker had stored and published. The previous audit
(8 Sep 2026) is kept below for the record; where the two disagree, this one
wins — in particular the 14-month lease filter that audit endorsed is gone.

## Verdict

The tracker was running every day and its history is intact, but **what it
showed was materially wrong for five of the six buildings**:

| Building | What the site listed on 15 Nov | What the tracker showed | Why |
|---|---|---|---|
| 1225 Old Town | 15 units | **7** — and 4 of those 7 at a different price than the site | A 14-month lease filter dropped every future-move-in unit and re-priced the rest |
| Old Town Park I–III | 58 units, 32 with a future move-in date | 58 units, **no future move-in date** on any of them | The date format the site prints (`12/10/2026`) was not understood |
| The Leo | 2 units | 2 units, but the cheaper one filed as a 1-bedroom, so the studio view showed **nothing** | "JR 1 Bedroom" read as "1" |
| Stead 220 | 14 priced plans | 13, **4 at stale prices**, 1 missing | The page the tracker reads is a 1–5 day delayed copy of the building's price list |
| every building | — | every move-in date **one day early** ("Sep 21" for 22 Sep) | Calendar dates were formatted through a time zone |

Lease terms — the thing the owner most wanted to see — were recorded for no
unit at all in a usable form: 1225 publishes a full lease-length price table
per unit and the tracker threw it away; the other three sites do not publish
lease lengths, and the tracker did not say so.

All of this is fixed on this branch, verified against the live sites the same
day, and covered by tests built from that day's real pages. **It goes live
when this branch is merged into the default branch** — the scheduled refresh
runs the default branch's code.

## What was wrong, building by building

### 1225 Old Town (SightMap)

- `focus.maxLeaseTermMonths: 14` was meant to hide "teaser" 18-month prices.
  In practice every unit on this site is advertised with "18 Months" (it is
  simply the longest lease at the lowest price — for 9 of 15 units a 12- or
  13-month lease costs the same), so the filter put **every** unit through a
  re-pricing path each day.
- That path asked SightMap's lease-price API without a move-in date. For a
  unit that is not vacant yet the API then answers with an empty table, and
  the unit was dropped as "over the cap". Result: **every future-move-in unit
  was missing from all 64 daily snapshots from 12 Sep to 14 Nov** (424
  omitted unit-rows since the filter went in on 8 Sep), including 2 of the 3
  two-bedrooms on 14 Nov — the dashboard's "cheapest 2 BR" read $5,071 while
  the site offered $4,874.
- Units that survived were stored at the cheapest price within 14 months,
  and which lease length that was hopped between 8 and 14 months from day to
  day. 49 of the 122 price changes recorded for this building since 8 Sep
  coincide with such a switch — false drops and rises, some of them alerted
  on.
- Not stored at all: the lease-length price table (17 lengths, 2–18 months,
  different for each move-in date), the mandatory $100–$230 monthly utility
  bundle the site adds to its headline price, the site-wide special, and the
  day a vacant unit actually became vacant.
- 7 of the 250 apartments on the site's floor plate are drawn as rectangles
  rather than polygons and were skipped by the 3D position map (one of
  them, 0509, is listed today).

### Old Town Park I, II, III

- Future move-in dates are printed as `M/D/YYYY`. The parser only understood
  "Available" and month names, so **not one future date was recorded** in
  any snapshot through 14 Nov (8,085 unit rows).
- For five floor plans the site alternates between two prices — a range
  (`$3,355 – $3,709`) one minute, a single different figure the next. Each
  flip was recorded as a price change: 108 of them so far. The underlying
  per-lease-length prices live in the leasing portal, which sits behind a
  Cloudflare challenge the tracker does not try to pass, so neither state can
  be called the true one.
- Penthouse and townhome rows (no bed count on the page) were dropped without
  a trace; square footage silently included the terrace; "Jr. 2 Bed",
  "1 Bed + Flex" and "Convertible" were flattened to a bed count.

### The Leo

- Unit 602 is a "JR 1 Bedroom" (508 sq ft, the cheapest apartment in the
  building; the site's own structured data counts it as 0 bedrooms). The
  tracker took the digit in the label and filed it as a 1-bedroom, so with
  the owner's studio + 2-bedroom focus the building showed "0 of 2".
- Both units say "Available Now" on the site; the tracker showed "Sep 21"
  and "Nov 9" — the day each became vacant, shifted a day early.
- On 12 Nov both rents fell by exactly the same ratio (×17/18) the day a
  "half a month free" banner went up; the site says its prices "may include
  concessions". The tracker reported two ordinary price drops and recorded no
  special.
- The scrape failed on 16 of 115 runs — almost certainly the site's bot
  protection, though the old error messages did not record what was served.
  On each failure the old code made six more attempts with a headless
  browser; that rescued no run since early September. A sold-out building
  would have been recorded as a permanent scrape failure.

### Stead 220

- The site lists floor-plan stacks ("Unit 01" … "Unit 13") with a "starting
  from" price, not apartments; it publishes no square footage, no lease
  lengths and no move-in dates (every active plan carries the same
  "Available Now" label). That part was handled correctly.
- But the page the tracker reads is a **delayed copy** of the building's own
  price list. Twelve dated price edits reached the snapshots 21–118 hours
  late (median about 68). On 15 Nov four of thirteen tracked prices differed
  from what a visitor's browser shows, and a re-listed $2,450 studio — the
  cheapest in the building — was missing.
- Plans switched to "Contact for Pricing" (two studios today) were dropped
  and then reported as "removed"; when a price came back they were announced
  as new — seven such events for studios so far.
- Eleven requests per run, ten of them to plan pages that hold nothing the
  tracker can use (and, before the browser fills them in, placeholder prices).

### Everything downstream

- Calendar dates were formatted in Chicago time from midnight UTC, so every
  move-in date on the site showed the previous day.
- A building page opened pre-filtered to the owner's sizes even when that
  left it empty.
- The alert job created its issue before the snapshot was pushed, alerted on
  every single-day bot refusal, and re-announced other buildings' changes on
  a single-building refresh.
- The scheduled run is set for 14:00 UTC, but in November GitHub started it
  between 18:30 and 23:20 UTC (4½–9 hours late; verified in the run history).

## What changed

**Nothing is filtered at scrape time any more.** Every unit a site lists is
stored at the price the site itself advertises, so any number can be checked
against the website at a glance. The lease length the owner compares at
(`focus.compareLeaseTermMonths`, default 12) is a view setting.

Scrapers
- 1225: every unit, with its advertised lease length, the **full lease-length
  price table** for its own move-in date, the move-in date, mandatory monthly
  fees, an apply link, the site special and (when the marketing page answers)
  the day a vacant unit became vacant. 15/15 units, 17 lease lengths each.
- Old Town Park: move-in dates for every unit; interior and outdoor area kept
  apart; the printed price wins over hidden attributes; unit types kept;
  penthouse / townhome rows listed separately; a deep link per unit into the
  leasing portal; a second look, 75 seconds later, whenever a plan appears to
  have flipped between its two pricing states. One tower with an empty page
  is recorded as fully leased; all three empty in the same run (as on 1 Oct)
  is recorded as a site outage, not three sell-outs.
- The Leo: junior one-beds classified as the site classifies them and shown
  under their own name; "available now" with the vacancy date; the special
  and the concession disclaimer recorded; an empty building is an empty
  building; a refusal by the bot protection is recorded as exactly that and
  left alone — one request, no browser, no retry.
- Stead 220: one request; "Contact for Pricing" and switched-off plans kept
  on the record; each price carries the day the building last edited it.

Pipeline
- Price changes are like for like: the same lease length where the site
  publishes one, never a range against a single figure. What cannot be
  compared is recorded as such and never alerted on.
- Move-in date changes are tracked. A plan whose price is withdrawn is still
  listed (with the price it last carried); a unit that leaves and returns is
  "back", not "new".
- Warnings for a collapsed scrape (missing lease tables or dates), for every
  unit repricing by the same ratio (a concession, not a rent change), and for
  snapshot files that no longer parse.
- `brief.json` carries every focus-size listing with lease terms and move-in
  dates.

Dashboard
- Columns for lease length and move-in date; a row opens into the lease-length
  price table, the fees, and a link to the unit on the leasing site.
- Filters for move-in window and lease length that default to "everything";
  hidden rows are counted, never silent.
- Each building page says in plain words what its site does and does not
  publish, and a dash is footnoted as "the site does not say".
- Dates are calendar dates. Stale or failed data is banner-flagged.

Operations
- Refresh is scheduled at :17 rather than on the hour (GitHub's documented
  remedy for late scheduled runs), pushes data before alerting, survives a
  concurrent commit, lists each building's result on the run page and turns
  red when nothing at all could be read.

History is untouched: no committed snapshot was changed or removed, and all
117 still load. Units the old filter hid are restored to the per-unit history
at build time from the `omitted` records those snapshots already carried.

## What each site publishes — and what cannot be had

| | Units | Lease lengths | Move-in dates | Not obtainable |
|---|---|---|---|---|
| 1225 Old Town | every unit | ✅ full table per unit and move-in date | ✅ | — |
| Old Town Park | every unit | ❌ a price or range only | ✅ | per-term prices (leasing portal, Cloudflare-protected) |
| The Leo | every unit | ❌ one "starting at" rent | ✅ | lease lengths, gross rent before concessions |
| Stead 220 | floor-plan stacks | ❌ | ❌ ("Available Now" on everything) | sq ft, dates, lease lengths, true inventory (RentCafe, Cloudflare-protected) |

Bot protection was met at three places (Old Town Park's SecureCafe portal,
RentCafe for Stead, and intermittently The Leo). In each case it was recorded
and left alone.

## Decisions for the owner

1. **Merge this branch** to make any of it live. Until then the scheduled
   refresh keeps running the old scraper on the default branch. The merge
   itself starts a refresh (this branch changes `.github/refresh-trigger`),
   so the first snapshot from the new scraper lands a few minutes later
   without anyone pressing a button.
2. **Stead 220's live prices.** The current, per-floor rents are served by
   the site's own JSON endpoint under `/api/`, which every visitor's browser
   calls — and which the site's `robots.txt` asks robots not to fetch. The
   tracker does not use it. Using it would fix the 1–5 day lag and give
   per-floor rents (up to three per stack); it is the owner's call, not an
   implementation detail. (During this audit one automated check made five
   requests to that endpoint before reading `robots.txt`; none since.)
3. **Junior one-beds count as studios.** The Leo's site counts them as 0
   bedrooms, so they now appear in the studio view, labelled "Jr 1 Bedroom".

## What to expect on the first run after merging

- 1225 goes from 7 to all listed units. They are not announced as new — the
  old snapshots recorded them as omitted — and their prices are compared with
  the old ones at the same lease length.
- Old Town Park units gain move-in dates; that is not reported as a date
  change.
- The Leo's "1 BR" line in the floor-plan chart steps up on 15 Nov because
  the junior one-bed now has a line of its own. The first alert names that
  unit once — "#602 (Jr 1 Bedroom) now counted as a studio" — because
  studios are a size being watched.
- The price chart for 1225 shades 15–16 Nov (and any further days until the
  merge): runs of the old and the new scraper alternate there.
- `data/unitmaps/1225-old-town.json` is deliberately the published branch's
  copy, so the daily job's edits to it cannot conflict with the merge. The
  first refresh after merging rewrites it (adding unit 0509, which the old
  scraper never mapped; until then that one unit's 3D position is a side
  estimate).

## How it was verified

- Each site read live on 15 Nov 2026 and compared field by field with the
  adapter's output: 1225 15/15 units, Old Town Park 19/19/20 (+2 penthouse /
  townhome rows), The Leo 2/2, Stead 13 priced plans + 2 unpriced — matching
  the page the tracker is allowed to read.
- A full run of the finished scrapers on 16 Nov 2026 (the committed
  snapshot `2026-11-16T17-01-38Z`): 6 of 6 buildings, 86 priced listings
  plus 4 listed without a price; every 1225 unit with its lease table, fees
  and move-in date; every Old Town Park and Leo unit with a move-in date.
  Compiled against the old history it raises no warning; the alert it would
  have sent names two real price drops (checked against the stored ranges)
  and the Leo junior one-bed.
- 285 automated tests, most of them run against pages captured that day
  (kept under `scraper/fixtures/`, with the August captures as a second set),
  plus `tsc` and a production build.
- The CI changes were simulated locally (run summary, health gate, push
  rebase-and-retry against a concurrent commit).
- The first run of the new scraper against the old history was replayed:
  it raises no alert and reports no new unit, no price change and no date
  change that did not happen.

## Independent review of the new pipeline

After the rewrite, a separate adversarial review tried to break the
change-detection code and had to reproduce every claim by running it. It
confirmed thirteen defects — two serious — all fixed since, each with a test:

- With a full lease table on both days, prices were compared at yesterday's
  lease length. When the cheapest lease simply changed length that reported a
  "+61%" rise that never happened, and hid real cuts. Advertised rent is now
  compared with advertised rent.
- A listing that sat on the site without a price was invisible to every
  comparison: getting its price back was never announced. It is now ("has a
  price again: $1,950, was $2,250 on Oct 27").
- Old Town Park's range ↔ single-price flips swallowed real price moves that
  landed on a flip day (46 in the history, 6 of them cuts on studio / 2-bed
  units). A flipped unit is now compared with the last time it was priced
  the same way.
- A same-ratio repricing of every unit was alerted as plain price drops; it
  now has its own section and says it is probably a concession.
- Smaller ones: warnings that vanished after a second run the same day; a
  chart line stepping on the two days the stored number changed meaning (now
  marked); the daily brief replaying yesterday's news for a building that was
  not re-scraped; dates invented from text such as "December 2026" or
  "1-2 weeks"; an outage missed when one tower's request failed outright; a
  partial second look replacing a full first one; a damaged snapshot file
  silencing alerts; alert wording (UTC date in the title, scraped text pasted
  unescaped).

## Independent review of the scrapers

A second adversarial review took the four site scrapers and tried to make
each return wrong data while still reporting success — by editing single
rows of the captured pages in the ways leasing sites really change them. It
confirmed ten weaknesses. None was producing wrong data on 15 Nov; each
would have, the day a site changed. All are closed, each with a test:

- **Old Town Park — the rent was any dollar amount in the row.** A promo tag
  such as "$1,000 Rent Credit" next to a unit would have been stored as its
  rent (a 57% "price drop"); a struck-through "was" price became a price
  range; a page served without whitespace fused the rent with the date into
  a six-digit rent. The rent is now read from the price element only, and
  the date only from a label that is a date.
- **Old Town Park — a hidden number stood in for a withheld price.** A row
  whose price slot prints words ("Call for Details") was given the page's
  hidden attribute as its rent unless the words matched one of three known
  phrases. Any price slot that prints words is now listed without a price,
  with the slot's own text as the note.
- **Old Town Park — a renamed page hook meant an empty tower recorded as
  "ok".** Every unit row on the page is now read wherever it sits, and a
  page whose rows cannot be read fails loudly instead of returning a shorter
  list.
- **1225 — a unit with no number, or a plan with no whole-number bed count,**
  was dropped silently or (worse) made the whole run invalid. Such units are
  now listed under "also listed" with the reason.
- **The Leo — a lease-term table would not have been read.** The site does
  not publish one today; had it switched one on (its widget is the same one
  1225's site uses, which does), the table would have been dropped without
  a word. It is now read in the widget's real format. Unit records the
  scraper cannot read are no longer just counted in a log line, and an
  apartment the site's catalogue marks available but its unit list omits is
  reported.
- **Stead 220 — a plan's identity hung on incidental card markup.** It now
  comes from the page's own data record.
- **Specials longer than 300 characters were dropped whole.** They are
  shortened at a word boundary instead.
- **Only one scraper recognised a bot-protection refusal as a refusal.** All
  four now do, the same way: recorded as "refused", not retried in the run,
  never worked around.
- **One malformed row could discard a whole run** (all six buildings). A row
  that does not fit the snapshot format now costs that row only.

## Independent review of the dashboard

A third adversarial review drove the dashboard itself in a real browser —
six buildings, three screen sizes, both themes, every filter and sort — and
compared what it rendered with the compiled data, cell by cell. Every table
cell matched (168 rows checked), calendar days were right in three time
zones, and filters, sorting and links did what they said. It also confirmed
eighteen defects, three of them serious. All are fixed and were re-checked
in the browser:

- **A snapshot from the previous scraper kept 8 of 1225's 15 apartments out
  of the table, the counts and the "cheapest" figures**, and labelled its
  capped rents "exactly as the site advertises". They are ordinary rows
  everywhere now, at the rent the site advertised; rows recorded the old way
  say so.
- **Without WebGL a building page went completely white**, and the
  dashboard itself could not start without downloading the 3D library. The
  3D view, the chart and each page now fail on their own; the dashboard's
  own script is about 60 kB compressed and needs neither library.
- **One building's data file failing to load took the whole dashboard
  down**, and the failure stuck until a reload. Buildings load
  independently now; a failed one gets its own card with "Try again".
- **"The site does not publish X" was inferred from X being absent in the
  latest snapshot** — false whenever a snapshot simply lacked it. Each
  building's config now states what its site publishes; anything else reads
  "not recorded in this snapshot".
- **Listings with no move-in date were counted as "later"**; the dashboard
  now keeps three buckets (now, later, no date on record).
- **Change summaries used the wrong words**: a switch between a rent range
  and a single price was called a "lease-term switch", a re-listed unit was
  counted as "new", a building-wide concession was promoted as the "biggest
  recent drop". Each now says what it is.
- **Stead 220's price history was wrong where it mattered**: a flat
  sparkline drawn from one penthouse, and no chart line for its cheapest
  studio or two-bedroom. Charts now follow the listings the filters show.
- **The unit table did not fit** on 1024–1320 px screens or, for Stead, on
  a phone (columns cut off with nothing to say so); it fits from 360 px up.
- **Rows and sort headers were mouse-only**; they are real buttons now.
  Secondary text in the light theme went from 3.5:1 to 5.3:1 contrast.
- Smaller ones: a building switched by URL showing the previous building's
  rows; a tab left open for days blaming the refresh job for its own stale
  copy; the stale-data banner quoting the wrong age; a move-in date change
  that was only counted, never shown; "Listed" sorting against its arrow;
  the plan name unreadable on a phone.

## The 3D view

- **New rendering.** Glass-and-mullion facades with floor lines, a sky and
  ground lit for the real position of the sun over Chicago at the chosen
  hour (a slider in the view, 5 am to 11 pm), soft shadows, lit windows at
  night, streets, parks and trees from OpenStreetMap.
- **Every listed unit is on its tower**, coloured by bed type, with a
  legend. A mark says how sure its position is — and for every building
  except 1225 the honest answer is "the floor is right, the side is an
  estimate": the stack-to-side tables in `buildings.json` were never
  verified against floor plans. 1225's positions are exact (from its unit
  map). Units outside the filter are drawn hollow rather than hidden.
- **Street names lie on the ground** along their streets, so they no longer
  print across the tower; "reset view" brings back the whole-tower view.
- Not done: the stack-to-side tables are still unverified guesses (a
  per-building job with the leasing sites' floor plans), and the default
  camera does not yet turn to the side with the most listed units.

## Addendum — the day of the merge (17 Nov 2026)

- **The first refresh after the merge failed, because of a bug in this
  audit's own workflow change.** The new check on the "buildings" input
  rejected an empty list — which is the normal case — so the run stopped
  before scraping anything, and every scheduled run would have too. It had
  not been tested with an empty value. It was fixed within five minutes (pull
  request #92, opened by the repository's Cursor agent) and the refresh that
  followed succeeded: 5 of 6 buildings read, The Leo refused.
- **1225 stopped publishing the amount of its utility bundle that day.** Its
  feed had priced it at $100–$230 a month; from 17 Nov it says "Varies", and
  the site headlines base rent alone. The scraper now records required
  monthly charges that have no amount (`monthlyFeesUnpriced`) and the row
  detail names them, so base rent is not mistaken for the monthly bill.
- **1225's own website answers GitHub's runners with HTTP 403** (it answered
  normally from elsewhere the same hour). Special offers and "vacant since"
  dates come from that page. Nothing works around the refusal; the snapshot
  now records what the run could not read (`gaps`) and the building's page
  says so, instead of yesterday's offer silently disappearing.

- **20 Nov 2026 — the two untested areas are under test.** The three
  scheduled runs after the merge (17, 18, 19 Nov) each read six of six
  buildings. The failure of 17 Nov came from shell written inside the
  refresh workflow, which nothing tested; that logic is now code with tests
  (`ci-flags.ts`, `commit-snapshot.sh`) and the whole job is rehearsed
  offline on every pull request. The dashboard, until then checked only by
  hand-run browser scripts, has a committed browser suite (`web/e2e`) that
  runs in CI; breaking the listing of left-out units, or removing the
  boundary round the 3D view, fails it.

  Two independent reviews of that work, before it was merged, found
  nothing broken in what the job does today, and several places where the
  new tests — and then one of my fixes — promised more than they did.

  First review:

  1. *Nothing ran the program the job runs.* The tests called functions;
     the job runs commands. Re-adding the very line that failed on 17 Nov
     to the program's entry point left every test green. The rehearsal now
     reads the command and variables of the browser check, the flags, the
     scrape, the alert step and the alarm out of `refresh.yml` and runs
     them with `bash -e` in a throwaway copy of the project; re-adding that
     line, renaming a variable on one side only, or dropping the scrape's
     arguments now fails it.
  2. *Two overlapping refresh runs lost the later run's snapshot* — older
     than this work, and real: every run rewrites the unit map, so the
     second push's retry met a conflict and the step failed. The script's
     own comment said that could not happen.
  3. *"Starts without the 3D and chart libraries" passed with both compiled
     into the start-up file.* It now requires them to exist as files of
     their own and holds the start-up scripts to a size budget.
  4. *The 3D test passed with nothing drawn on the tower and the sun fixed
     at noon.* It now compares pictures: pointing at each unit's row must
     change the picture, differently for every unit, and the scene must be
     much darker at 11 PM than at 1 PM and at noon.

  Second review, of those fixes:

  5. *My fix for 2 was wrong.* I had the later run's unit map replace the
     earlier one's whole, on the belief that the file is regenerated each
     run. It is not: it accumulates the positions of units seen listed, so
     that rule silently dropped whatever the earlier run had just learned —
     and my test asserted the loss. The two files are now merged by unit
     (`.github/scripts/merge-unitmap.mjs`): what either run learned is
     kept, a unit both placed is the later run's. Only the skyline, which
     is regenerated whole, is replaced whole.
  6. *The rehearsal read the commands but not the settings around them.* A
     step made conditional, given another shell or working directory, or a
     job-wide setting would have stopped the scrape on GitHub with every
     test green. The reader now refuses settings it does not reproduce,
     and the test pins every step and job and each condition.
  7. *The 3D test would have failed on a missing optional file* (the
     browser logs the 404 as an error, and the test had begun to treat
     console errors as failures). That line is no longer counted.
  8. *Sentences here and in the README said more than the code did* — for
     one, that the rehearsal runs every step's command (it runs five; the
     rest are named with the reason they are not run). Reworded.

  Third review, of the commit step alone:

  9. *The stricter merge could cost a run its prices.* A hand edit that
     leaves a unit map unreadable, landing while a run is under way, made
     the new merge refuse — and the step then pushed nothing, where the
     old one would have pushed the snapshot. The workflow's own rule is
     that positional data never blocks prices. The merge program now keeps
     to it: where two unit maps cannot be merged (one is unreadable, they
     are in different versions of the format) it leaves the one that
     landed exactly as it is, drops this run's, and puts a warning on the
     run's page. The prices go through.
  10. *What the step sets up for a race ran before every push*, and under
      `set -e` could have stopped a run nothing raced with. Its failure is
      now a warning, and the step goes on to push.
  11. *The tests ran the script from outside the checkout it works in*, so
      three ways of breaking it went unnoticed. They now run it the way the
      workflow does, from inside a checkout that holds it — including a
      case where what lands replaces the script while it runs.
  12. Smaller: the settings were written where a linked worktree does not
      read them; a per-cent sign in the checkout's path broke the merge
      program's command line; unit maps in two versions of the format were
      joined; no test pinned the order of units in a merged map.

  Fourth review, of my first answer to 9:

  13. *That answer could undo what had landed.* I had first made the step
      replace its commit by one carrying the snapshot alone whenever the
      rest did not go together with what landed. Where a pull request had
      left a link or a file at `data/snapshots`, that commit replaced it
      with a folder; where the folder had been moved, it put the snapshot
      in the old place and called the run a success; and it also ran when
      a pull had merely failed. I took it out. What it was for is covered
      by 9, inside the merge program, with nothing that rebuilds a commit.
      Every other case in which this run's files do not go together with
      what landed — a pull request removed the unit map, a recorded
      response was changed on both sides, the snapshots folder moved —
      stops the step, pushing nothing, as it did before any of this work.
  14. *Its tests never read the snapshot they said had been pushed.* The
      commit-step tests now compare what is on the branch, byte for byte,
      with what each side wrote.

  What the commit step does differently from before this work, in full:
  two overlapping refresh runs no longer cost the later one its snapshot
  (their unit maps are merged, the later skyline wins); a step that stops
  says why on the run's page and leaves the checkout on the run's own
  commit; a missing skyline file no longer keeps the unit map from being
  committed. Nothing else changed.

  Not run by any test, and said so in the rehearsal: installing
  dependencies and the browser, and the skyline and unit-map steps, which
  ask outside services.

---

# Previous audit — 8 Sep 2026

> Kept for the record. Superseded by the 15 Nov 2026 audit above wherever the two disagree — in particular, the 14-month lease filter described here has been removed.

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
