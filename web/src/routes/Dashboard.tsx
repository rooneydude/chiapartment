import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { priceAtTerm } from "../../../shared/src/listing";
import type {
  BuildingConfig,
  BuildingHistory,
  CompiledConfig,
  UnitListing,
} from "../../../shared/src/types";
import Sparkline from "../components/Sparkline";
import { loadConfig, loadHistory, useDataEpoch } from "../lib/data";
import {
  ageLabel,
  ageWords,
  bedsLabel,
  dateTime,
  isStale,
  longDate,
  money,
  moveIn,
  priceLabel,
} from "../lib/format";

interface Row {
  building: BuildingConfig;
  history: BuildingHistory;
}

/** A building in the order the config lists it: loaded, or the reason it could not be. */
interface Entry {
  building: BuildingConfig;
  history: BuildingHistory | null;
  problem?: string;
}

interface Best {
  unit: UnitListing;
  name: string;
  id: string;
  asOf: string;
}

export default function Dashboard() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [focus, setFocus] = useState<number[] | null>(null);
  const [compareTerm, setCompareTerm] = useState(12);
  const [error, setError] = useState<string | null>(null);
  /** Snapshot files the build could not read and left out of the history. */
  const [skipped, setSkipped] = useState<string[]>([]);
  /** Goes up when the reader asks to try a failed load again. */
  const [attempt, setAttempt] = useState(0);
  /** Goes up when a tab left open drops its old data: load again, keep what is shown meanwhile. */
  const epoch = useDataEpoch();
  const shown = useRef(false);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const config = await loadConfig();
        // Each building on its own: one file that fails to load costs one
        // card, not the dashboard.
        const settled = await Promise.allSettled(config.buildings.map((b) => loadHistory(b.id)));
        if (!current) return;
        setFocus(config.focus?.beds ?? null);
        setCompareTerm(config.focus?.compareLeaseTermMonths ?? 12);
        setSkipped((config as CompiledConfig).health?.skippedSnapshots ?? []);
        setEntries((before) =>
          config.buildings.map((building, i): Entry => {
            const result = settled[i]!;
            if (result.status === "fulfilled") return { building, history: result.value };
            // A refresh that fails keeps the copy already on screen.
            const had = before?.find((e) => e.building.id === building.id)?.history ?? null;
            if (had) return { building, history: had };
            const reason: unknown = result.reason;
            return { building, history: null, problem: reason instanceof Error ? reason.message : String(reason) };
          }),
        );
        setError(null);
        shown.current = true;
      } catch (err: unknown) {
        if (current && !shown.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, epoch]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };

  if (error) {
    return (
      <div className="error-box" role="alert">
        Failed to load data: {error}
        <div className="error-actions">
          <button className="retry-btn" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!entries) {
    return (
      <>
        <div className="stat-strip">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stat-tile skeleton" style={{ height: 74 }} />
          ))}
        </div>
        <div className="cards">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card skeleton" style={{ height: 180 }} />
          ))}
        </div>
      </>
    );
  }

  const rows = entries.filter((e): e is Row => e.history !== null);
  const notLoaded = entries.filter((e) => e.history === null);
  const inFocus = (beds: number) => focus === null || focus.includes(beds);

  // Portfolio stats across every building's latest snapshot.
  // A "Jr. 2 Bed" is counted as a 2 BR but is not what someone shopping a
  // full two-bedroom means — so the tile can also name the cheapest regular one.
  const isJunior = (u: UnitListing) => /\bjr\b|junior/i.test(u.planType ?? "");
  const cheapest = (beds: number, regularOnly = false): Best | null => {
    let best: Best | null = null;
    for (const { building, history } of rows) {
      if (!history.latest) continue;
      for (const u of history.latest.units) {
        if (u.beds !== beds) continue;
        if (regularOnly && isJunior(u)) continue;
        if (!best || u.price < best.unit.price) {
          best = { unit: u, name: building.name, id: building.id, asOf: history.latest.timestamp };
        }
      }
    }
    return best;
  };
  const statBeds = focus ?? [0, 1];
  const statTiles = statBeds.map((b) => {
    const best = cheapest(b);
    return { beds: b, best, regular: best && isJunior(best.unit) ? cheapest(b, true) : null };
  });

  // Biggest REAL drop among focus-bed units: like-for-like lease length only
  // (a site re-headlining a longer lease is not a price drop).
  let drop: { amount: number; name: string; id: string; label: string } | null = null;
  for (const { building, history } of rows) {
    for (const c of history.delta?.priceChanges ?? []) {
      if (!inFocus(c.beds) || c.notComparable) continue;
      const amount = c.from - c.to;
      if (amount > 0 && (!drop || amount > drop.amount)) {
        drop = {
          amount,
          name: building.name,
          id: building.id,
          label: c.unitNumber === c.floorplanName ? c.floorplanName : `#${c.unitNumber}`,
        };
      }
    }
  }

  // Three buckets, never two: a listing with no move-in date on record is
  // not "later" — nobody knows when.
  let totalUnits = 0;
  let totalNow = 0;
  let totalLater = 0;
  let totalAllBeds = 0;
  for (const { history } of rows) {
    if (!history.latest) continue;
    totalAllBeds += history.latest.units.length;
    for (const u of history.latest.units) {
      if (!inFocus(u.beds)) continue;
      totalUnits++;
      const kind = moveIn(u, history.latest.timestamp).kind;
      if (kind === "now") totalNow++;
      else if (kind === "future") totalLater++;
    }
  }
  const totalUndated = totalUnits - totalNow - totalLater;
  const focusLabel =
    focus === null ? "Units on market" : `${focus.map(bedsLabel).join(" + ")} on market`;
  const updates = rows
    .map((r) => r.history.latest?.timestamp)
    .filter((t): t is string => !!t)
    .sort();
  const lastUpdated = updates[updates.length - 1];
  const oldestUpdate = updates[0];

  const scrapeFails = rows.filter((r) => r.history.lastAttempt?.status === "error");
  const staleRows = rows.filter(
    (r) =>
      r.history.latest &&
      isStale(r.history.latest.timestamp) &&
      r.history.lastAttempt?.status !== "error",
  );

  // Each stale building's own age — not the oldest timestamp on the page.
  const staleAges = new Set(staleRows.map((r) => ageWords(r.history.latest!.timestamp)));

  return (
    <>
      {notLoaded.length > 0 && (
        <div className="warning-banner" role="alert">
          <div>
            ⚠ {notLoaded.map((e) => e.building.name).join(", ")} could not be loaded — the figures
            below leave {notLoaded.length === 1 ? "it" : "them"} out.{" "}
            <button className="retry-btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      )}
      {scrapeFails.length > 0 && (
        <div className="warning-banner" role="status">
          {scrapeFails.map(({ building, history }) => {
            const attempt = history.lastAttempt!;
            const lastGood = history.latest?.timestamp;
            return (
              <div key={building.id}>
                ⚠ <strong>{building.name}</strong>{" "}
                {attempt.blocked
                  ? "— the leasing site’s bot protection refused the last scrape"
                  : "scrape failed"}{" "}
                {ageLabel(attempt.timestamp)}
                {(attempt.failedRuns ?? 0) > 1 ? ` (${attempt.failedRuns} runs in a row)` : ""}
                {lastGood ? ` · showing last good data from ${longDate(lastGood)}` : ""}
              </div>
            );
          })}
        </div>
      )}
      {staleRows.length > 0 && (
        <div className="warning-banner" role="status">
          <div>
            ⚠{" "}
            {staleRows.length === rows.length && staleAges.size === 1
              ? `Prices are ${[...staleAges][0]} old`
              : `Prices are out of date for ${staleRows
                  .map((r) => `${r.building.name} (${ageWords(r.history.latest!.timestamp)} old)`)
                  .join(", ")}`}{" "}
            — the daily refresh has not produced newer data. Check the “Refresh prices” workflow.
          </div>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="warning-banner" role="status">
          <div>
            ⚠ {skipped.length} snapshot file{skipped.length === 1 ? "" : "s"} could not be read and{" "}
            {skipped.length === 1 ? "is" : "are"} left out of the price history: {skipped.join(", ")}
          </div>
        </div>
      )}
      <div className="stat-strip">
        {statTiles.map(({ beds, best, regular }) => {
          if (!best) return null;
          const u = best.unit;
          const mi = moveIn(u, best.asOf);
          const atCompare =
            u.leaseTermMonths != null && u.leaseTermMonths !== compareTerm
              ? priceAtTerm(u, compareTerm)
              : null;
          return (
            <Link className="stat-tile" key={beds} to={`/b/${best.id}`}>
              <span className="stat-label">Cheapest {bedsLabel(beds)}</span>
              <span className="stat-value">
                {money(u.price)}
                {u.leaseTermMonths != null && (
                  <span className="stat-term"> {u.leaseTermMonths}-mo lease</span>
                )}
              </span>
              <span className="stat-sub">
                {u.planType ? `${u.planType} · ` : ""}
                {best.name}
                {u.unitNumber ? ` #${u.unitNumber}` : ""}
                {mi.kind === "now" ? " · move-in now" : mi.kind === "future" ? ` · move-in ${mi.label}` : ""}
                {atCompare !== null ? ` · ${compareTerm}-mo ${money(atCompare)}` : ""}
                {beds === 2 ? ` · ${money(Math.round(u.price / 2))}/person` : ""}
                {regular
                  ? ` · regular ${bedsLabel(beds)} from ${money(regular.unit.price)} (${regular.name}${
                      regular.unit.unitNumber ? ` #${regular.unit.unitNumber}` : ""
                    })`
                  : ""}
              </span>
            </Link>
          );
        })}
        {drop && (
          <Link className="stat-tile" to={`/b/${drop.id}`}>
            <span className="stat-label">Biggest recent drop</span>
            <span className="stat-value delta-down">▼ {money(drop.amount)}</span>
            <span className="stat-sub">
              {drop.label} · {drop.name}
            </span>
          </Link>
        )}
        <div className="stat-tile">
          <span className="stat-label">{focusLabel}</span>
          <span className="stat-value">{totalUnits}</span>
          <span className="stat-sub">
            {totalNow} move-in now · {totalLater} later
            {totalUndated > 0 ? ` · ${totalUndated} with no move-in date on record` : ""}
            {focus !== null ? ` · ${totalAllBeds} listings of all sizes` : ""}
            {lastUpdated ? ` · as of ${dateTime(lastUpdated)}` : ""}
          </span>
        </div>
      </div>
      <div className="cards">
      {entries.map((entry) => {
        if (entry.history === null) {
          return (
            <div className="card card-problem" key={entry.building.id} role="alert">
              <div className="card-head">
                <div>
                  <h2>{entry.building.name}</h2>
                  <div className="addr">{entry.building.address}</div>
                </div>
              </div>
              <div className="prices">Could not load this building’s data.</div>
              <div className="addr">{entry.problem}</div>
              <div className="card-foot">
                <button className="retry-btn" onClick={retry}>
                  Try again
                </button>
              </div>
            </div>
          );
        }
        const { building, history } = entry;
        const asOf = history.latest?.timestamp ?? null;
        const allUnits = history.latest?.units ?? [];
        const units = allUnits.filter((u) => inFocus(u.beds));

        // Min price per focus bedroom count.
        const minByBeds = new Map<number, number>();
        // The cheapest listing of each size, kept whole so a junior /
        // convertible plan can be named as what it is.
        const cheapestByBeds = new Map<number, (typeof units)[number]>();
        for (const u of units) {
          const cur = minByBeds.get(u.beds);
          if (cur === undefined || u.price < cur) {
            minByBeds.set(u.beds, u.price);
            cheapestByBeds.set(u.beds, u);
          }
        }
        const bedsSorted = [...minByBeds.keys()].sort((a, b) => a - b);

        // Move-in picture for the focus units.
        const moves = asOf ? units.map((u) => moveIn(u, asOf)) : [];
        const nowCount = moves.filter((m) => m.kind === "now").length;
        const nextFuture = moves
          .filter((m) => m.kind === "future")
          .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))[0];
        const undated = moves.filter((m) => m.kind === "unknown").length;
        const terms = [...new Set(units.map((u) => u.leaseTermMonths).filter((t): t is number => t != null))].sort(
          (a, b) => a - b,
        );

        // Sparkline: min price per run among units currently known to be
        // focus-beds (past-only units have unknown beds and are skipped).
        const focusUnitNumbers = new Set(
          units.map((u) => u.unitNumber).filter((u): u is string => u !== null),
        );
        const minPerRun = history.runs.map((t) => {
          let min = Infinity;
          for (const [unitNumber, series] of Object.entries(history.perUnit)) {
            if (focus !== null && !focusUnitNumbers.has(unitNumber)) continue;
            for (const p of series) if (p.t === t && p.price < min) min = p.price;
          }
          // Floorplan-only buildings (Stead 220) have no unit numbers in perUnit.
          if (!Number.isFinite(min)) {
            const focusPlans = new Set(units.map((u) => u.floorplanName));
            for (const [plan, series] of Object.entries(history.perFloorplan)) {
              if (focus !== null && !focusPlans.has(plan)) continue;
              for (const p of series) if (p.t === t && p.minPrice < min) min = p.minPrice;
            }
          }
          return min;
        });

        const d = history.delta;
        const newCount = d?.newUnits.filter((u) => inFocus(u.beds)).length ?? 0;
        const goneCount = d?.removedUnits.filter((u) => inFocus(u.beds)).length ?? 0;
        const focusChanges = (d?.priceChanges ?? []).filter(
          (c) => inFocus(c.beds) && !c.notComparable,
        );
        const drops = focusChanges.filter((c) => c.to < c.from).length;
        const hikes = focusChanges.filter((c) => c.to > c.from).length;
        const omittedCount = history.omitted?.length ?? 0;
        const alsoCount = history.alsoListed?.length ?? 0;
        const failed = history.lastAttempt?.status === "error";

        return (
          <Link className="card" key={building.id} to={`/b/${building.id}`}>
            <div className="card-head">
              <div>
                <h2>{building.name}</h2>
                <div className="addr">
                  {building.address} · {building.geometry.floors} floors
                </div>
              </div>
              {building.neighborhood && <span className="hood">{building.neighborhood}</span>}
            </div>
            <div className="prices">
              {bedsSorted.length === 0 && (
                <span>
                  {!history.latest
                    ? "Not read successfully yet — no data"
                    : allUnits.length === 0
                      ? `The ${failed ? "last good scrape" : "last scrape"} (${longDate(history.latest.timestamp)}) found no listings`
                      : `No ${(focus ?? []).map(bedsLabel).join(" or ")} listed ${
                          failed ? `as of ${longDate(history.latest.timestamp)}` : "right now"
                        } (${allUnits.length} other listing${allUnits.length === 1 ? "" : "s"})`}
                </span>
              )}
              {bedsSorted.map((b) => {
                const type = cheapestByBeds.get(b)?.planType;
                return (
                  <span
                    key={b}
                    title={type ? `The cheapest ${bedsLabel(b)} listing is a “${type}”` : undefined}
                  >
                    {bedsLabel(b)} <strong>{money(minByBeds.get(b)!)}</strong>
                    {type ? <span className="plan-name"> {type}</span> : null}
                  </span>
                );
              })}
            </div>
            {units.length > 0 && (
              <div className="card-movein">
                {nowCount > 0
                  ? `${nowCount} move-in now`
                  : undated === units.length
                    ? building.publishes?.moveInDate === false
                      ? "the site publishes no move-in dates"
                      : "move-in dates not recorded in this snapshot"
                    : undated > 0
                      ? "none known to be available now"
                      : "none available now"}
                {nextFuture ? ` · next ${nextFuture.label}` : ""}
                {undated > 0 && undated < units.length ? ` · ${undated} without a date` : ""}
                {terms.length > 0
                  ? ` · ${terms.length === 1 ? `${terms[0]}-mo` : `${terms[0]}–${terms[terms.length - 1]}-mo`} leases advertised`
                  : ""}
              </div>
            )}
            <div className="badges">
              {history.warnings?.length > 0 && (
                <span className="badge bad" title={history.warnings.map((w) => w.message).join("\n")}>
                  {failed ? (history.lastAttempt?.blocked ? "⚠ site refused scrape" : "⚠ scrape failed") : "⚠ data"}
                </span>
              )}
              {units.length > 0 && (
                <span
                  className="badge"
                  title={
                    focus !== null
                      ? `${units.length} ${focus.map(bedsLabel).join(" / ")} of ${allUnits.length} listings of all sizes`
                      : undefined
                  }
                >
                  {units.length} listed
                </span>
              )}
              {newCount > 0 && <span className="badge new">{newCount} new</span>}
              {drops > 0 && <span className="badge good">▼ {drops} price drops</span>}
              {hikes > 0 && <span className="badge bad">▲ {hikes} increases</span>}
              {goneCount > 0 && <span className="badge">{goneCount} gone</span>}
              {alsoCount > 0 && (
                <span
                  className="badge"
                  title={history.alsoListed
                    .map(
                      (a) =>
                        `${a.unitNumber ? `#${a.unitNumber} ` : ""}${a.floorplanName}: ${a.note}${a.price !== undefined ? ` (${priceLabel(a.price, a.priceMax)})` : ""}`,
                    )
                    .join("\n")}
                >
                  +{alsoCount} unpriced
                </span>
              )}
              {omittedCount > 0 && (
                <span
                  className="badge bad"
                  title={`The newest snapshot was taken by the tracker's previous scraper: rents are each apartment's cheapest lease of 14 months or less, and the ${omittedCount} apartment${omittedCount === 1 ? "" : "s"} it left out of its list ${omittedCount === 1 ? "is" : "are"} counted here at the rent the site advertised (${history.omitted
                    .map((o) => (o.unitNumber ? `#${o.unitNumber}` : o.floorplanName))
                    .join(", ")}). The next refresh records every apartment the current way.`}
                >
                  old-method snapshot
                </span>
              )}
            </div>
            <div className="card-foot">
              <span>
                {failed
                  ? `${history.lastAttempt!.blocked ? "site refused the scrape" : "scrape failed"} ${longDate(history.lastAttempt!.timestamp)}${
                      history.latest ? ` · last good ${longDate(history.latest.timestamp)}` : ""
                    }`
                  : history.latest
                    ? `updated ${dateTime(history.latest.timestamp)}`
                    : "no data yet"}
              </span>
              <Sparkline points={minPerRun.filter((v) => Number.isFinite(v))} />
            </div>
          </Link>
        );
      })}
      </div>
    </>
  );
}
