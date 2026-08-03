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
  if (!rows) return <div className="loading">Loading…</div>;

  return (
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
            <div>
              <h2>{building.name}</h2>
              <div className="addr">
                {building.address} · {building.geometry.floors} floors
              </div>
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
  );
}
