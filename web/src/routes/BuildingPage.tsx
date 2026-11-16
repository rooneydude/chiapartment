import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listingKey } from "../../../shared/src/delta";
import { leaseTermTable, omittedAsListings } from "../../../shared/src/listing";
import { parseUnitNumber } from "../../../shared/src/parse";
import {
  UnitMappingSchema,
  type BuildingConfig,
  type BuildingHistory,
  type BuildingsConfig,
} from "../../../shared/src/types";
import AvailabilityTable from "../components/AvailabilityTable";
import DeltaSummary from "../components/DeltaSummary";
import ErrorBoundary, { PanelFallback } from "../components/ErrorBoundary";
import Filters from "../components/Filters";
import { loadConfig, loadHistory, useDataEpoch } from "../lib/data";
import { ageLabel, dateTime, isStale, longDate, moveIn } from "../lib/format";
import { useStore } from "../state/store";

// Each loads its own library (three.js, recharts) and sits in its own error
// boundary: a device without WebGL, or a download that failed, costs that one
// panel — never the unit table.
const Scene3D = lazy(() => import("../three/Scene3D"));
const PriceHistoryChart = lazy(() => import("../components/PriceHistoryChart"));

const FALLBACK_MAPPING = UnitMappingSchema.parse({});

export default function BuildingPage() {
  const { id } = useParams<{ id: string }>();
  const [config, setConfig] = useState<BuildingsConfig | null>(null);
  const [history, setHistory] = useState<BuildingHistory | null>(null);
  const [error, setError] = useState<{ unknownBuilding: boolean; message: string } | null>(null);
  /** Goes up when the reader asks to try a failed load again. */
  const [attempt, setAttempt] = useState(0);
  /** Goes up when a tab left open drops its old data: load again, keep what is shown meanwhile. */
  const epoch = useDataEpoch();
  const shown = useRef(false);
  /** The building lists units, but none in the sizes being shopped for. */
  const [focusEmpty, setFocusEmpty] = useState(false);
  const resetForBuilding = useStore((s) => s.resetForBuilding);
  const bedsFilter = useStore((s) => s.bedsFilter);
  const moveInWithin = useStore((s) => s.moveInWithin);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);

  useEffect(() => {
    if (!id) return;
    // A response that arrives after the page has moved on must not land.
    let current = true;
    (async () => {
      try {
        const c = await loadConfig();
        if (!current) return;
        if (!c.buildings.some((b) => b.id === id)) {
          setError({ unknownBuilding: true, message: "" });
          return;
        }
        const h = await loadHistory(id);
        if (!current) return;
        if (!shown.current) {
          // Map focus beds into filter buckets (3 = "3+").
          const focus = c.focus?.beds.map((b) => Math.min(b, 3)) ?? null;
          // Never open on an empty table: when nothing listed here matches the
          // sizes being shopped for, show everything that is listed instead.
          const units = h.latest?.units ?? [];
          const noneInFocus =
            focus !== null && units.length > 0 && !units.some((u) => focus.includes(Math.min(u.beds, 3)));
          // Only when the page opens: a later refresh of the data keeps the
          // reader's filters and selection.
          resetForBuilding(noneInFocus ? null : focus);
          setFocusEmpty(noneInFocus);
          shown.current = true;
        }
        setConfig(c);
        setHistory(h);
        setError(null);
      } catch (err: unknown) {
        // A failed refresh of data already on screen keeps what is shown.
        if (current && !shown.current) {
          setError({ unknownBuilding: false, message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [id, resetForBuilding, attempt, epoch]);

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

  // A snapshot taken by the old scraper: which of its listings it had left
  // out of its list (they are in latest.units all the same — see lib/data).
  const leftOutKeys = useMemo(
    () =>
      history?.omitted && history.omitted.length > 0
        ? new Set(omittedAsListings(history.omitted).map(listingKey))
        : null,
    [history],
  );

  const visibleUnitNumbers = useMemo(
    () => new Set(filteredUnits.map((u) => u.unitNumber).filter((u): u is string => u !== null)),
    [filteredUnits],
  );

  const visiblePlans = useMemo(() => new Set(filteredUnits.map((u) => u.floorplanName)), [filteredUnits]);
  const visiblePlanListings = useMemo(
    () => new Set(filteredUnits.filter((u) => u.unitNumber === null).map((u) => u.floorplanName)),
    [filteredUnits],
  );

  if (error?.unknownBuilding) {
    return (
      <div className="error-box" role="alert">
        There is no building “{id}” in this tracker.
        <div className="error-actions">
          <Link to="/">← all buildings</Link>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-box" role="alert">
        Failed to load: {error.message}
        <div className="error-actions">
          <button
            className="retry-btn"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
          <Link to="/">← all buildings</Link>
        </div>
      </div>
    );
  }
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
        <a className="meta" href={building.url} target="_blank" rel="noopener noreferrer">
          leasing site ↗
        </a>
        <span className="meta">
          {building.address} · {building.geometry.floors} floors
          {history.lastAttempt?.status === "error"
            ? ` · ${history.lastAttempt.blocked ? "site refused the scrape" : "scrape failed"} ${longDate(history.lastAttempt.timestamp)}${
                history.latest ? ` · last good ${longDate(history.latest.timestamp)}` : ""
              }`
            : history.latest
              ? ` · updated ${dateTime(history.latest.timestamp)} (${ageLabel(history.latest.timestamp)})`
              : ""}
        </span>
      </div>
      {/* A failed latest scrape explains itself in the warnings below. */}
      {history.latest && isStale(history.latest.timestamp) && history.lastAttempt?.status !== "error" && (
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
          {history.warnings.map((w, i) => (
            <div key={`${w.code}-${i}`}>⚠ {w.message}</div>
          ))}
        </div>
      )}
      {(history.omitted?.length ?? 0) > 0 && (
        <div className="warning-banner" role="status">
          <div>
            ⚠ The newest snapshot{history.latest ? ` (${dateTime(history.latest.timestamp)})` : ""} was
            taken by the tracker’s previous scraper. It recorded each apartment at its cheapest
            rent for a lease of 14 months or less — which can be more than the rent the site
            advertises — and left {history.omitted.length} apartment
            {history.omitted.length === 1 ? "" : "s"} that had no such lease out of its list.{" "}
            {history.omitted.length === 1 ? "It is" : "They are"} in the table below at the rent
            the site advertised (
            {history.omitted.map((o) => (o.unitNumber ? `#${o.unitNumber}` : o.floorplanName)).join(", ")}
            ). The next refresh records every apartment the current way: the advertised rent, its
            lease length, the price of every other lease length and the move-in date.
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
      <DeltaSummary
        delta={history.delta}
        concession={history.warnings?.some((w) => w.code === "uniform-reprice") ?? false}
      />
      <div style={{ height: 10 }} />
      {/* Nothing listed: nothing to filter. */}
      {(history.latest?.units.length ?? 0) > 0 && (
        <Filters
          maxFloor={building.geometry.floors}
          leaseTerms={leaseTermsAvailable}
          focusBeds={config.focus?.beds ?? null}
        />
      )}
      <div className="bldg-grid">
        <div className="panel">
          <div className="panel-title">
            Listed units
            {history.latest && history.latest.units.length > 0 && (
              <span className="hint">
                {filteredUnits.length === history.latest.units.length
                  ? `all ${filteredUnits.length}`
                  : `${filteredUnits.length} of ${history.latest.units.length} — ${
                      history.latest.units.length - filteredUnits.length
                    } hidden by the filters above`}{" "}
                · click a row for lease terms and its place in 3D
              </span>
            )}
          </div>
          <AvailabilityTable
            units={filteredUnits}
            delta={history.delta}
            mapping={building.unitMapping}
            meta={history.perUnitMeta ?? {}}
            asOf={history.latest?.timestamp ?? new Date().toISOString()}
            compareTerm={config.focus?.compareLeaseTermMonths ?? 12}
            alsoListed={history.alsoListed ?? []}
            publishes={building.publishes}
            leftOutKeys={leftOutKeys}
            totalListed={history.latest?.units.length ?? 0}
            hasSnapshot={history.latest != null}
          />
          {focusEmpty && bedsFilter === null && (
            <div className="table-footnote">
              Nothing listed here in the sizes you shop for (
              {(config.focus?.beds ?? []).map((b) => (b === 0 ? "Studio" : `${b} BR`)).join(", ")}) — showing
              every listed unit instead.
            </div>
          )}
          {(building.dataNotes?.length ?? 0) > 0 && (
            <div className="data-notes">
              <div className="data-notes-title">What this building’s leasing site publishes</div>
              <ul>
                {building.dataNotes!.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="panel">
          <ErrorBoundary fallback={(e) => <PanelFallback what="The 3D view" error={e} />}>
            <Suspense fallback={<div className="skeleton" style={{ height: 480, border: "none" }} />}>
              <Scene3D building={building} allBuildings={config.buildings} history={history} units={filteredUnits} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
      <div style={{ height: 16 }} />
      <ErrorBoundary
        fallback={(e) => (
          <div className="panel">
            <PanelFallback what="The price history chart" error={e} />
          </div>
        )}
      >
        <Suspense fallback={<div className="skeleton" style={{ height: 360 }} />}>
          <PriceHistoryChart
            history={history}
            visibleUnits={visibleUnitNumbers}
            visiblePlans={visiblePlans}
            visiblePlanListings={visiblePlanListings}
          />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
