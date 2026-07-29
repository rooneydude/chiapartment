"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { BuildingSpec } from "@/lib/massing/spec";
import type { FloorPlate } from "@/lib/floorplan/schema";
import CompassDial from "./CompassDial";
import type { SceneUnit } from "./BuildingScene";

// The canvas has no server rendering path, and it is the heaviest thing on the
// page, so it loads on the client only and behind a placeholder of the same size.
const BuildingScene = dynamic(() => import("./BuildingScene"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-[13px] text-ink-500">
      Loading model…
    </div>
  ),
});

export interface ExplorerUnit extends SceneUnit {
  id: string;
  availableOn: string | null;
  sqft: number | null;
  planName: string | null;
  listingUrl: string | null;
}

interface Props {
  spec: BuildingSpec;
  plate: FloorPlate;
  units: ExplorerUnit[];
  /** Notes from the geometry solver, shown behind a disclosure. */
  notes?: string[];
  confidence?: string | null;
}

type SortKey = "floor" | "rent" | "sqft" | "ppsf";

const EXPOSURES = ["N", "E", "S", "W"] as const;

export default function BuildingExplorer({
  spec,
  plate,
  units,
  notes = [],
  confidence,
}: Props) {
  const [selected, setSelected] = useState<string | null>(units[0]?.unitCode ?? null);
  const [bedFilter, setBedFilter] = useState<number[]>([]);
  const [facingFilter, setFacingFilter] = useState<string[]>([]);
  const [minFloor, setMinFloor] = useState(0);
  const [sort, setSort] = useState<SortKey>("floor");

  const bedOptions = useMemo(
    () =>
      [...new Set(units.map((u) => u.bedrooms).filter((b): b is number => b != null))].sort(
        (a, b) => a - b,
      ),
    [units],
  );

  const filtered = useMemo(() => {
    const rows = units.filter((u) => {
      if (bedFilter.length && (u.bedrooms == null || !bedFilter.includes(u.bedrooms))) {
        return false;
      }
      if (
        facingFilter.length &&
        !u.placement.exposures.some((e) => facingFilter.some((f) => e.point.startsWith(f)))
      ) {
        return false;
      }
      if (u.placement.floor < minFloor) return false;
      return true;
    });

    return rows.sort((a, b) => {
      switch (sort) {
        case "rent":
          return (a.rent ?? Infinity) - (b.rent ?? Infinity);
        case "sqft":
          return (b.sqft ?? 0) - (a.sqft ?? 0);
        case "ppsf":
          return ppsf(a) - ppsf(b);
        default:
          return b.placement.floor - a.placement.floor;
      }
    });
  }, [units, bedFilter, facingFilter, minFloor, sort]);

  const active = filtered.find((u) => u.unitCode === selected) ?? filtered[0] ?? null;
  const maxFloor = spec.topFloor;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* ---------------------------------------------------------------- 3D */}
      <div className="relative h-[clamp(420px,62vh,760px)] overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
        <BuildingScene
          spec={spec}
          plate={plate}
          units={filtered}
          selectedUnitCode={active?.unitCode ?? null}
          onSelect={setSelected}
        />

        <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-1.5">
          <Legend />
          {confidence && confidence !== "measured" && (
            <span className="pointer-events-auto w-fit rounded-full border border-ink-700 bg-ink-950/85 px-2.5 py-1 text-[11px] text-ink-400">
              Geometry {confidence} from listing data
            </span>
          )}
        </div>

        {notes.length > 0 && (
          <details className="absolute bottom-4 left-4 max-w-[min(28rem,calc(100%-2rem))] rounded-lg border border-ink-700 bg-ink-950/90 text-[11px] backdrop-blur">
            <summary className="cursor-pointer select-none px-3 py-2 text-ink-300">
              How this model was derived
            </summary>
            <ul className="space-y-1.5 border-t border-ink-800 px-3 py-2 text-ink-400">
              {notes.map((n, i) => (
                <li key={i} className="leading-snug">
                  · {n}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* ------------------------------------------------------------- panel */}
      <div className="flex min-h-0 flex-col gap-3">
        {active && <UnitDetail unit={active} topFloor={maxFloor} />}

        <div className="rounded-xl border border-ink-800 bg-ink-900">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 p-3">
            <FilterGroup label="Beds">
              {bedOptions.map((b) => (
                <Chip
                  key={b}
                  active={bedFilter.includes(b)}
                  onClick={() =>
                    setBedFilter((prev) =>
                      prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b],
                    )
                  }
                >
                  {b === 0 ? "Studio" : `${b}bd`}
                </Chip>
              ))}
            </FilterGroup>

            <FilterGroup label="Faces">
              {EXPOSURES.map((f) => (
                <Chip
                  key={f}
                  active={facingFilter.includes(f)}
                  onClick={() =>
                    setFacingFilter((prev) =>
                      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                    )
                  }
                >
                  {f}
                </Chip>
              ))}
            </FilterGroup>
          </div>

          <div className="flex items-center gap-3 border-b border-ink-800 px-3 py-2.5">
            <label className="flex flex-1 items-center gap-2 text-[11px] text-ink-400">
              <span className="whitespace-nowrap">Floor {minFloor}+</span>
              <input
                type="range"
                min={0}
                max={maxFloor}
                value={minFloor}
                onChange={(e) => setMinFloor(Number(e.target.value))}
                className="h-1 flex-1 cursor-pointer accent-[var(--color-accent)]"
                aria-label="Minimum floor"
              />
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-300 outline-none focus:border-ink-500"
              aria-label="Sort units"
            >
              <option value="floor">Highest floor</option>
              <option value="rent">Lowest rent</option>
              <option value="sqft">Largest</option>
              <option value="ppsf">Best $/sqft</option>
            </select>
          </div>

          <div className="max-h-[46vh] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-ink-500">
                No units match these filters.
              </p>
            ) : (
              <ul className="divide-y divide-ink-850">
                {filtered.map((u) => (
                  <UnitRow
                    key={u.id}
                    unit={u}
                    selected={u.unitCode === active?.unitCode}
                    onSelect={() => setSelected(u.unitCode)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-ink-800 px-3 py-2 text-[11px] text-ink-500">
            {filtered.length} of {units.length} available
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UnitDetail({ unit, topFloor }: { unit: ExplorerUnit; topFloor: number }) {
  const p = unit.placement;
  return (
    <div className="rounded-xl border border-accent/25 bg-ink-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink-100">
            Unit {unit.unitCode}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-400">
            {unit.planName ?? `Line ${p.line}`}
            {unit.bedrooms != null &&
              ` · ${unit.bedrooms === 0 ? "Studio" : `${unit.bedrooms} bed`}`}
          </p>
        </div>
        <div className="text-right">
          <div className="tnum text-lg font-semibold text-accent">
            {unit.rent != null ? `$${unit.rent.toLocaleString()}` : "—"}
          </div>
          {unit.rent != null && unit.sqft != null && (
            <div className="tnum text-[11px] text-ink-500">
              ${(unit.rent / unit.sqft).toFixed(2)}/sqft
            </div>
          )}
        </div>
      </div>

      <div className="mt-3.5 flex items-stretch gap-3">
        <dl className="grid flex-1 grid-cols-3 gap-2.5">
          <Stat label="Floor" value={`${p.floor}`} sub={`of ${topFloor}`} />
          <Stat
            label="Faces"
            value={p.facing}
            sub={p.isCorner ? "corner unit" : "single exposure"}
          />
          <Stat label="Size" value={p.areaSqft.toLocaleString()} sub="sqft" />
        </dl>
        <div
          className="grid shrink-0 place-items-center rounded-lg bg-ink-850 px-2"
          title={p.exposureLabel}
        >
          <CompassDial exposures={p.exposures} size={84} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
        <span className="tnum">{Math.round(p.slabHeightM)} m above street</span>
        {unit.availableOn && <span>Available {formatDate(unit.availableOn)}</span>}
        {unit.listingUrl && (
          <a
            href={unit.listingUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-300 underline decoration-ink-600 underline-offset-2 transition-colors hover:text-accent"
          >
            View listing ↗
          </a>
        )}
      </div>
    </div>
  );
}

function UnitRow({
  unit,
  selected,
  onSelect,
}: {
  unit: ExplorerUnit;
  selected: boolean;
  onSelect: () => void;
}) {
  const p = unit.placement;
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={selected}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
          selected ? "bg-accent/10" : "hover:bg-ink-850"
        }`}
      >
        <span
          className={`tnum w-14 shrink-0 text-[13px] font-medium ${
            selected ? "text-accent" : "text-ink-200"
          }`}
        >
          {unit.unitCode}
        </span>
        <span className="w-16 shrink-0 text-[11px] text-ink-400">{p.facing}</span>
        <span className="tnum w-16 shrink-0 text-[11px] text-ink-400">
          {unit.sqft ? `${unit.sqft.toLocaleString()} sf` : "—"}
        </span>
        <span className="tnum ml-auto text-[13px] text-ink-200">
          {unit.rent != null ? `$${unit.rent.toLocaleString()}` : "—"}
        </span>
      </button>
    </li>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-ink-850 px-2.5 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink-100">{value}</dd>
      {sub && <dd className="text-[10px] text-ink-500">{sub}</dd>}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-ink-500">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200"
      }`}
    >
      {children}
    </button>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none flex items-center gap-3 rounded-full border border-ink-700 bg-ink-950/85 px-3 py-1.5 text-[11px] text-ink-400 backdrop-blur">
      <span className="flex items-center gap-1.5">
        <i className="h-2 w-2 rounded-[2px] bg-accent" /> selected
      </span>
      <span className="flex items-center gap-1.5">
        <i className="h-2 w-2 rounded-[2px] bg-[#ffd79a] opacity-40" /> available
      </span>
    </div>
  );
}

function ppsf(u: ExplorerUnit): number {
  if (u.rent == null || !u.sqft) return Infinity;
  return u.rent / u.sqft;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
