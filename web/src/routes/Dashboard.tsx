import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BuildingConfig, BuildingHistory } from "../../../shared/src/types";
import Sparkline from "../components/Sparkline";
import { loadConfig, loadHistory } from "../lib/data";
import { ageLabel, bedsLabel, longDate, money } from "../lib/format";

interface Row {
  building: BuildingConfig;
  history: BuildingHistory;
}

export default function Dashboard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [focus, setFocus] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then((config) => {
        setFocus(config.focus?.beds ?? null);
        return Promise.all(
          config.buildings.map(async (building) => ({
            building,
            history: await loadHistory(building.id),
          })),
        );
      })
      .then(setRows)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="error-box">Failed to load data: {error}</div>;
  if (!rows) {
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

  const inFocus = (beds: number) => focus === null || focus.includes(beds);

  // Portfolio stats across every building's latest snapshot.
  const cheapest = (beds: number) => {
    let best: { price: number; name: string; id: string; unit: string | null } | null = null;
    for (const { building, history } of rows) {
      for (const u of history.latest?.units ?? []) {
        if (u.beds !== beds) continue;
        if (!best || u.price < best.price) {
          best = { price: u.price, name: building.name, id: building.id, unit: u.unitNumber };
        }
      }
    }
    return best;
  };
  const statBeds = focus ?? [0, 1];
  const statTiles = statBeds.map((b) => ({ beds: b, best: cheapest(b) }));

  // Biggest drop among focus-bed units (includes Stead floorplan/stack identity).
  let drop: { amount: number; name: string; id: string; label: string } | null = null;
  for (const { building, history } of rows) {
    for (const c of history.delta?.priceChanges ?? []) {
      if (!inFocus(c.beds)) continue;
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

  const totalUnits = rows.reduce(
    (s, r) => s + (r.history.latest?.units.filter((u) => inFocus(u.beds)).length ?? 0),
    0,
  );
  const focusLabel =
    focus === null ? "Units on market" : `${focus.map(bedsLabel).join(" + ")} on market`;
  const lastUpdated = rows
    .map((r) => r.history.latest?.timestamp)
    .filter((t): t is string => !!t)
    .sort()
    .pop();

  const scrapeFails = rows.filter((r) => r.history.lastAttempt?.status === "error");

  return (
    <>
      {scrapeFails.length > 0 && (
        <div className="warning-banner" role="status">
          {scrapeFails.map(({ building, history }) => {
            const attempt = history.lastAttempt!;
            const lastGood = history.latest?.timestamp;
            return (
              <div key={building.id}>
                ⚠ <strong>{building.name}</strong> scrape failed {ageLabel(attempt.timestamp)}
                {lastGood ? ` · showing last good data from ${longDate(lastGood)}` : ""}
              </div>
            );
          })}
        </div>
      )}
      <div className="stat-strip">
        {statTiles.map(
          ({ beds, best }) =>
            best && (
              <Link className="stat-tile" key={beds} to={`/b/${best.id}`}>
                <span className="stat-label">Cheapest {bedsLabel(beds)}</span>
                <span className="stat-value">{money(best.price)}</span>
                <span className="stat-sub">
                  {best.name}
                  {beds === 2 ? ` · ${money(Math.round(best.price / 2))}/person split` : ""}
                </span>
              </Link>
            ),
        )}
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
            {lastUpdated ? `as of ${longDate(lastUpdated)}` : "across 6 buildings"}
          </span>
        </div>
      </div>
      <div className="cards">
      {rows.map(({ building, history }) => {
        const allUnits = history.latest?.units ?? [];
        const units = allUnits.filter((u) => inFocus(u.beds));

        // Min price per focus bedroom count.
        const minByBeds = new Map<number, number>();
        for (const u of units) {
          const cur = minByBeds.get(u.beds);
          if (cur === undefined || u.price < cur) minByBeds.set(u.beds, u.price);
        }
        const bedsSorted = [...minByBeds.keys()].sort((a, b) => a - b);

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
        const focusChanges = (d?.priceChanges ?? []).filter((c) => inFocus(c.beds));
        const drops = focusChanges.filter((c) => c.to < c.from).length;
        const hikes = focusChanges.filter((c) => c.to > c.from).length;
        const omittedCount = history.omitted?.length ?? 0;

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
                  {focus === null
                    ? "No listings in last snapshot"
                    : `No ${focus.map(bedsLabel).join(" or ")} listed right now`}
                </span>
              )}
              {bedsSorted.map((b) => (
                <span key={b}>
                  {bedsLabel(b)} <strong>{money(minByBeds.get(b)!)}</strong>
                </span>
              ))}
            </div>
            <div className="badges">
              {history.warnings?.length > 0 && (
                <span className="badge bad" title={history.warnings.map((w) => w.message).join("\n")}>
                  {history.lastAttempt?.status === "error" ? "⚠ scrape failed" : "⚠ data"}
                </span>
              )}
              {units.length > 0 && <span className="badge">{units.length} available</span>}
              {newCount > 0 && <span className="badge new">{newCount} new</span>}
              {drops > 0 && <span className="badge good">▼ {drops} price drops</span>}
              {hikes > 0 && <span className="badge bad">▲ {hikes} increases</span>}
              {goneCount > 0 && <span className="badge">{goneCount} gone</span>}
              {omittedCount > 0 && (
                <span
                  className="badge"
                  title={history.omitted
                    .map(
                      (o) =>
                        `${o.unitNumber ? `#${o.unitNumber}` : o.floorplanName}: $${o.advertisedPrice.toLocaleString()} @ ${o.leaseTermMonths}mo (over-cap)`,
                    )
                    .join("\n")}
                >
                  {omittedCount} over-cap
                </span>
              )}
            </div>
            <div className="card-foot">
              <span>
                {history.lastAttempt?.status === "error"
                  ? `scrape failed ${longDate(history.lastAttempt.timestamp)}${
                      history.latest ? ` · last good ${longDate(history.latest.timestamp)}` : ""
                    }`
                  : history.latest
                    ? `updated ${longDate(history.latest.timestamp)}`
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
