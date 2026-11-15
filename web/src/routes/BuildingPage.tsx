import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { leaseTermTable } from "../../../shared/src/listing";
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
import { ageLabel, dateTime, isStale, longDate, moveIn } from "../lib/format";
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
  const moveInWithin = useStore((s) => s.moveInWithin);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);

  useEffect(() => {
    if (!id) return;
    Promise.all([loadConfig(), loadHistory(id)])
      .then(([c, h]) => {
        // Map focus beds into filter buckets (3 = "3+").
        const focus = c.focus?.beds.map((b) => Math.min(b, 3)) ?? null;
        resetForBuilding(focus);
        setConfig(c);
        setHistory(h);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id, resetForBuilding]);

  const building: BuildingConfig | undefined = config?.buildings.find((b) => b.id === id);
  const mapping = building?.unitMapping ?? FALLBACK_MAPPING;

  const asOf = history?.latest?.timestamp ?? null;

  const filteredUnits = useMemo(() => {
    const units = history?.latest?.units ?? [];
    return units.filter((u) => {
      if (bedsFilter !== null) {
        const bucket = Math.min(u.beds, 3);
        if (!bedsFilter.includes(bucket)) return false;
      }
      if (moveInWithin !== null && asOf !== null) {
        // A date filter hides listings with no published date; the default
        // ("Any move-in date") shows them.
        const days = moveIn(u, asOf).days;
        if (days === null || days > moveInWithin) return false;
      }
      if (floorMin !== null || floorMax !== null) {
        const floor = parseUnitNumber(u.unitNumber, mapping).floor;
        if (floor === null) return false;
        if (floorMin !== null && floor < floorMin) return false;
        if (floorMax !== null && floor > floorMax) return false;
      }
      return true;
    });
  }, [history, asOf, bedsFilter, moveInWithin, floorMin, floorMax, mapping]);

  // Lease lengths at least one listed unit publishes a price for.
  const leaseTermsAvailable = useMemo(() => {
    const months = new Set<number>();
    for (const u of history?.latest?.units ?? []) {
      const table = leaseTermTable(u);
      if (table.length > 1) for (const t of table) months.add(t.months);
    }
    return [...months].sort((a, b) => a - b);
  }, [history]);

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
          {history.lastAttempt?.status === "error"
            ? ` · scrape failed ${longDate(history.lastAttempt.timestamp)}${
                history.latest ? ` · last good ${longDate(history.latest.timestamp)}` : ""
              }`
            : history.latest
              ? ` · updated ${dateTime(history.latest.timestamp)} (${ageLabel(history.latest.timestamp)})`
              : ""}
        </span>
      </div>
      {history.latest && isStale(history.latest.timestamp) && (
        <div className="warning-banner" role="status">
          <div>
            ⚠ These prices are from {longDate(history.latest.timestamp)} (
            {ageLabel(history.latest.timestamp)}). The daily refresh has not produced newer data
            for this building — check the “Refresh prices” workflow.
          </div>
        </div>
      )}
      {(history.warnings?.length ?? 0) > 0 && (
        <div className="warning-banner">
          {history.warnings.map((w) => (
            <div key={w.code}>⚠ {w.message}</div>
          ))}
        </div>
      )}
      {(history.omitted?.length ?? 0) > 0 && (
        <div className="warning-banner" role="status">
          <div>
            ⚠ This snapshot predates the removal of the old 14-month lease filter, which left{" "}
            {history.omitted.length} listed unit{history.omitted.length === 1 ? "" : "s"} out of
            the table:{" "}
            {history.omitted
              .map(
                (o) =>
                  `${o.unitNumber ? `#${o.unitNumber}` : o.floorplanName} $${o.advertisedPrice.toLocaleString()} @ ${o.leaseTermMonths}mo`,
              )
              .join(" · ")}
            . The next refresh lists every unit.
          </div>
        </div>
      )}
      {(history.notices?.length ?? 0) > 0 && (
        <div className="info-banner" role="status">
          {history.notices.map((n) => (
            <div key={n}>✨ {n}</div>
          ))}
        </div>
      )}
      <DeltaSummary delta={history.delta} />
      <div style={{ height: 10 }} />
      <Filters
        maxFloor={building.geometry.floors}
        leaseTerms={leaseTermsAvailable}
        focusBeds={config.focus?.beds ?? null}
      />
      <div className="bldg-grid">
        <div className="panel">
          <div className="panel-title">
            Listed units
            <span className="hint">
              {filteredUnits.length === (history.latest?.units.length ?? 0)
                ? `all ${filteredUnits.length}`
                : `${filteredUnits.length} of ${history.latest?.units.length ?? 0} — ${
                    (history.latest?.units.length ?? 0) - filteredUnits.length
                  } hidden by the filters above`}{" "}
              · click a row for lease terms and its place in 3D
            </span>
          </div>
          <AvailabilityTable
            units={filteredUnits}
            delta={history.delta}
            mapping={building.unitMapping}
            meta={history.perUnitMeta ?? {}}
            asOf={history.latest?.timestamp ?? new Date().toISOString()}
            compareTerm={config.focus?.compareLeaseTermMonths ?? 12}
            alsoListed={history.alsoListed ?? []}
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
