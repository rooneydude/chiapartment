import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BuildingConfig, BuildingHistory } from "../../../shared/src/types";
import Sparkline from "../components/Sparkline";
import { loadConfig, loadHistory } from "../lib/data";
import { bedsLabel, longDate, money } from "../lib/format";

interface Row {
  building: BuildingConfig;
  history: BuildingHistory;
}

export default function Dashboard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then((config) =>
        Promise.all(
          config.buildings.map(async (building) => ({
            building,
            history: await loadHistory(building.id),
          })),
        ),
      )
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
  const s0 = cheapest(0);
  const s1 = cheapest(1);
  let drop: { amount: number; name: string; id: string; unit: string } | null = null;
  for (const { building, history } of rows) {
    for (const c of history.delta?.priceChanges ?? []) {
      const amount = c.from - c.to;
      if (amount > 0 && (!drop || amount > drop.amount)) {
        drop = { amount, name: building.name, id: building.id, unit: c.unitNumber };
      }
    }
  }
  const totalUnits = rows.reduce((s, r) => s + (r.history.latest?.units.length ?? 0), 0);
  const lastUpdated = rows
    .map((r) => r.history.latest?.timestamp)
    .filter((t): t is string => !!t)
    .sort()
    .pop();

  return (
    <>
      <div className="stat-strip">
        {s0 && (
          <Link className="stat-tile" to={`/b/${s0.id}`}>
            <span className="stat-label">Cheapest studio</span>
            <span className="stat-value">{money(s0.price)}</span>
            <span className="stat-sub">{s0.name}</span>
          </Link>
        )}
        {s1 && (
          <Link className="stat-tile" to={`/b/${s1.id}`}>
            <span className="stat-label">Cheapest 1 BR</span>
            <span className="stat-value">{money(s1.price)}</span>
            <span className="stat-sub">{s1.name}</span>
          </Link>
        )}
        {drop && (
          <Link className="stat-tile" to={`/b/${drop.id}`}>
            <span className="stat-label">Biggest recent drop</span>
            <span className="stat-value delta-down">▼ {money(drop.amount)}</span>
            <span className="stat-sub">
              #{drop.unit} · {drop.name}
            </span>
          </Link>
        )}
        <div className="stat-tile">
          <span className="stat-label">Units on market</span>
          <span className="stat-value">{totalUnits}</span>
          <span className="stat-sub">
            {lastUpdated ? `as of ${longDate(lastUpdated)}` : "across 6 buildings"}
          </span>
        </div>
      </div>
      <div className="cards">
      {rows.map(({ building, history }) => {
        const units = history.latest?.units ?? [];
        // Min price per bedroom count.
        const minByBeds = new Map<number, number>();
        for (const u of units) {
          const cur = minByBeds.get(u.beds);
          if (cur === undefined || u.price < cur) minByBeds.set(u.beds, u.price);
        }
        const bedsSorted = [...minByBeds.keys()].sort((a, b) => a - b);

        // Sparkline: min listed price across all units per run.
        const minPerRun = history.runs.map((t) => {
          let min = Infinity;
          for (const series of Object.values(history.perUnit)) {
            for (const p of series) if (p.t === t && p.price < min) min = p.price;
          }
          return min;
        });

        const d = history.delta;
        const drops = d?.priceChanges.filter((c) => c.to < c.from).length ?? 0;
        const hikes = d?.priceChanges.filter((c) => c.to > c.from).length ?? 0;

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
              {bedsSorted.length === 0 && <span>No listings in last snapshot</span>}
              {bedsSorted.map((b) => (
                <span key={b}>
                  {bedsLabel(b)} <strong>{money(minByBeds.get(b)!)}</strong>
                </span>
              ))}
            </div>
            <div className="badges">
              {history.warnings?.length > 0 && (
                <span className="badge bad" title={history.warnings.map((w) => w.message).join("\n")}>
                  ⚠ data
                </span>
              )}
              {units.length > 0 && <span className="badge">{units.length} available</span>}
              {(d?.newUnits.length ?? 0) > 0 && (
                <span className="badge new">{d!.newUnits.length} new</span>
              )}
              {drops > 0 && <span className="badge good">▼ {drops} price drops</span>}
              {hikes > 0 && <span className="badge bad">▲ {hikes} increases</span>}
              {(d?.removedUnits.length ?? 0) > 0 && (
                <span className="badge">{d!.removedUnits.length} gone</span>
              )}
            </div>
            <div className="card-foot">
              <span>
                {history.latest ? `updated ${longDate(history.latest.timestamp)}` : "no data yet"}
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
