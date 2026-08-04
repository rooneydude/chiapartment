import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { parseUnitNumber } from "../../../shared/src/parse";
import {
  UnitMappingSchema,
  type BuildingConfig,
  type BuildingHistory,
  type BuildingsConfig,
} from "../../../shared/src/types";
import AvailabilityTable from "../components/AvailabilityTable";
import DeltaSummary from "../components/DeltaSummary";
import Filters from "../components/Filters";
import PriceHistoryChart from "../components/PriceHistoryChart";
import { loadConfig, loadHistory } from "../lib/data";
import { longDate } from "../lib/format";
import { useStore } from "../state/store";
import Scene3D from "../three/Scene3D";

const FALLBACK_MAPPING = UnitMappingSchema.parse({});

export default function BuildingPage() {
  const { id } = useParams<{ id: string }>();
  const [config, setConfig] = useState<BuildingsConfig | null>(null);
  const [history, setHistory] = useState<BuildingHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resetForBuilding = useStore((s) => s.resetForBuilding);
  const bedsFilter = useStore((s) => s.bedsFilter);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);

  useEffect(() => {
    resetForBuilding();
    if (!id) return;
    Promise.all([loadConfig(), loadHistory(id)])
      .then(([c, h]) => {
        setConfig(c);
        setHistory(h);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id, resetForBuilding]);

  const building: BuildingConfig | undefined = config?.buildings.find((b) => b.id === id);
  const mapping = building?.unitMapping ?? FALLBACK_MAPPING;

  const filteredUnits = useMemo(() => {
    const units = history?.latest?.units ?? [];
    return units.filter((u) => {
      if (bedsFilter !== null) {
        const bucket = Math.min(u.beds, 3);
        if (!bedsFilter.includes(bucket)) return false;
      }
      if (floorMin !== null || floorMax !== null) {
        const floor = parseUnitNumber(u.unitNumber, mapping).floor;
        if (floor === null) return false;
        if (floorMin !== null && floor < floorMin) return false;
        if (floorMax !== null && floor > floorMax) return false;
      }
      return true;
    });
  }, [history, bedsFilter, floorMin, floorMax, mapping]);

  const visibleUnitNumbers = useMemo(
    () => new Set(filteredUnits.map((u) => u.unitNumber).filter((u): u is string => u !== null)),
    [filteredUnits],
  );

  if (error) return <div className="error-box">Failed to load: {error}</div>;
  if (!config || !history || !building) {
    return (
      <>
        <div className="skeleton" style={{ height: 34, maxWidth: 460, marginBottom: 14 }} />
        <div className="bldg-grid">
          <div className="skeleton" style={{ height: 480 }} />
          <div className="skeleton" style={{ height: 480 }} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bldg-head">
        <Link to="/" className="meta">
          ← all buildings
        </Link>
        <h2>{building.name}</h2>
        <span className="meta">
          {building.address} · {building.geometry.floors} floors
          {history.latest ? ` · updated ${longDate(history.latest.timestamp)}` : ""}
        </span>
      </div>
      {(history.warnings?.length ?? 0) > 0 && (
        <div className="warning-banner">
          {history.warnings.map((w) => (
            <div key={w.code}>⚠ {w.message}</div>
          ))}
        </div>
      )}
      <DeltaSummary delta={history.delta} />
      <div style={{ height: 10 }} />
      <Filters maxFloor={building.geometry.floors} />
      <div className="bldg-grid">
        <div className="panel">
          <div className="panel-title">
            Available units
            <span className="hint">
              {filteredUnits.length} of {history.latest?.units.length ?? 0} · click a row to
              locate in 3D
            </span>
          </div>
          <AvailabilityTable
            units={filteredUnits}
            delta={history.delta}
            mapping={building.unitMapping}
            meta={history.perUnitMeta ?? {}}
          />
        </div>
        <div className="panel">
          <Scene3D building={building} allBuildings={config.buildings} history={history} />
        </div>
      </div>
      <div style={{ height: 16 }} />
      <PriceHistoryChart history={history} visibleUnits={visibleUnitNumbers} />
    </>
  );
}
