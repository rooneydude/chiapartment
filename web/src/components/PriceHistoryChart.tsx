import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BuildingHistory } from "../../../shared/src/types";
import { longDate, money, shortDate } from "../lib/format";
import { useStore } from "../state/store";

const SLOT_VARS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`);
const MAX_PLAN_SERIES = 8;

interface TooltipRow {
  name: string;
  value: number;
  color: string;
}

function ChartTooltip({
  active,
  label,
  payload,
  termAt,
}: {
  active?: boolean;
  label?: number;
  payload?: { name?: string; value?: number | string; stroke?: string }[];
  /** series name → run time (ms) → lease term the price was quoted for. */
  termAt?: Map<string, Map<number, number>>;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const rows: TooltipRow[] = payload
    .filter((p) => typeof p.value === "number" && p.name)
    .map((p) => ({ name: p.name!, value: p.value as number, color: p.stroke ?? "inherit" }))
    .sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, 8);
  return (
    <div className="viz-tooltip">
      <div className="t">{shortDate(new Date(label).toISOString())}</div>
      {shown.map((r) => {
        const term = termAt?.get(r.name)?.get(label);
        return (
          <div className="row" key={r.name}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="swatch" style={{ background: r.color, width: 8, height: 8, borderRadius: 2, display: "inline-block" }} />
              {r.name}
            </span>
            <strong>
              {money(r.value)}
              {term !== undefined && <span className="tooltip-term"> {term}mo</span>}
            </strong>
          </div>
        );
      })}
      {rows.length > shown.length && (
        <div className="t" style={{ marginTop: 4 }}>
          +{rows.length - shown.length} more
        </div>
      )}
    </div>
  );
}

export default function PriceHistoryChart({
  history,
  visibleUnits,
}: {
  history: BuildingHistory;
  /** Unit numbers passing the current filters. */
  visibleUnits: Set<string>;
}) {
  const chartMode = useStore((s) => s.chartMode);
  const setChartMode = useStore((s) => s.setChartMode);
  const selectedUnit = useStore((s) => s.selectedUnit);
  const hoveredUnit = useStore((s) => s.hoveredUnit);
  const selectUnit = useStore((s) => s.selectUnit);

  // Stable slot assignment: alphabetical over ALL plans ever seen, so colors
  // never shift when filters change series membership.
  const allPlans = useMemo(() => Object.keys(history.perFloorplan).sort(), [history]);
  const planSlot = useMemo(() => {
    const map = new Map<string, number>();
    allPlans.forEach((p, i) => map.set(p, i));
    return map;
  }, [allPlans]);
  // Which plans get a line: the ones listed right now first, then the ones
  // with the longest history. A plan name seen in a single run and gone again
  // (a one-off label) draws nothing useful and is left out.
  const { plans, plansLeftOut } = useMemo(() => {
    const latestT = history.latest?.timestamp;
    const ranked = allPlans
      .map((plan) => {
        const series = history.perFloorplan[plan] ?? [];
        return { plan, n: series.length, current: series[series.length - 1]?.t === latestT };
      })
      .filter((x) => x.current || x.n >= 2)
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || b.n - a.n || a.plan.localeCompare(b.plan),
      );
    return {
      plans: ranked.slice(0, MAX_PLAN_SERIES).map((x) => x.plan),
      plansLeftOut: Math.max(0, ranked.length - MAX_PLAN_SERIES),
    };
  }, [allPlans, history]);

  const unitNumbers = useMemo(
    () => Object.keys(history.perUnit).filter((u) => visibleUnits.has(u)),
    [history, visibleUnits],
  );

  const rows = useMemo(() => {
    const byT = new Map<string, Record<string, number>>();
    for (const t of history.runs) byT.set(t, {});
    if (chartMode === "floorplans") {
      for (const [plan, series] of Object.entries(history.perFloorplan)) {
        for (const p of series) {
          const row = byT.get(p.t);
          if (row) row[plan] = p.minPrice;
        }
      }
    } else {
      for (const u of unitNumbers) {
        for (const p of history.perUnit[u] ?? []) {
          const row = byT.get(p.t);
          if (row) row[u] = p.price;
        }
      }
    }
    return [...byT.entries()]
      .map(([t, values]) => ({ t: new Date(t).getTime(), ...values }))
      .sort((a, b) => a.t - b.t);
  }, [history, chartMode, unitNumbers]);

  // Lease term behind each price point, for the tooltip — and whether the
  // visible series mix lease lengths at all.
  const { termAt, mixedTerms } = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    const terms = new Set<number>();
    const series: [string, { t: string; term?: number }[]][] =
      chartMode === "floorplans"
        ? plans.map((p) => [p, history.perFloorplan[p] ?? []])
        : unitNumbers.map((u) => [u, history.perUnit[u] ?? []]);
    for (const [name, points] of series) {
      const byTime = new Map<number, number>();
      for (const p of points) {
        if (p.term === undefined) continue;
        byTime.set(new Date(p.t).getTime(), p.term);
        terms.add(p.term);
      }
      if (byTime.size > 0) map.set(name, byTime);
    }
    return { termAt: map, mixedTerms: terms.size > 1 };
  }, [history, chartMode, plans, unitNumbers]);

  // Points where what the stored prices MEAN changed (not the prices).
  const methodChanges = history.methodChanges ?? [];

  const single = history.runs.length < 2;

  return (
    <div className="panel">
      <div className="panel-title">
        Price history
        <span className="seg">
          <button
            className={chartMode === "floorplans" ? "on" : ""}
            onClick={() => setChartMode("floorplans")}
          >
            Floorplans
          </button>
          <button
            className={chartMode === "units" ? "on" : ""}
            onClick={() => setChartMode("units")}
          >
            Units
          </button>
        </span>
        {chartMode === "units" && (
          <span className="hint">
            {selectedUnit ? `unit ${selectedUnit} highlighted` : "click a unit row to highlight"}
          </span>
        )}
        {single && <span className="hint">one snapshot so far — history builds with each refresh</span>}
      </div>
      {mixedTerms && (
        <div className="chart-note">
          Each point is the rent recorded that day. The lease length it was quoted for changed
          over time (hover a point to see it), so a step in a line can be a different lease
          length rather than a price change.
        </div>
      )}
      {methodChanges.length > 0 && (
        <div className="chart-note">
          <strong>Dashed lines</strong> mark where the recorded number changed meaning, not
          price:
          {methodChanges.map((m) => (
            <span key={m.t}>
              {" "}
              <strong>{longDate(m.t)}</strong> — {m.note}
            </span>
          ))}
        </div>
      )}
      {chartMode === "floorplans" && (
        <div className="legend-row">
          {plans.map((p) => (
            <span className="key" key={p}>
              <span
                className="swatch"
                style={{ background: SLOT_VARS[planSlot.get(p)! % SLOT_VARS.length] }}
              />
              {p}
            </span>
          ))}
          {plansLeftOut > 0 && (
            <span className="key">+{plansLeftOut} more plans (see units view)</span>
          )}
        </div>
      )}
      <div className="chart-box" style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 24, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="var(--grid-line)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) => shortDate(new Date(t).toISOString())}
              stroke="var(--baseline)"
              tick={{ fill: "var(--text-muted)", fontSize: 11.5 }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
              stroke="var(--baseline)"
              tick={{ fill: "var(--text-muted)", fontSize: 11.5, fontVariantNumeric: "tabular-nums" } as never}
              tickLine={false}
              width={48}
              domain={["auto", "auto"]}
            />
            <Tooltip
              content={<ChartTooltip termAt={termAt} />}
              cursor={{ stroke: "var(--baseline)", strokeDasharray: "3 3" }}
            />
            {methodChanges.map((m) => (
              <ReferenceLine
                key={m.t}
                x={new Date(m.t).getTime()}
                stroke="var(--text-muted)"
                strokeDasharray="5 4"
                ifOverflow="hidden"
              />
            ))}
            {chartMode === "floorplans"
              ? plans.map((p) => (
                  <Line
                    key={p}
                    dataKey={p}
                    name={p}
                    stroke={SLOT_VARS[planSlot.get(p)! % SLOT_VARS.length]}
                    strokeWidth={2}
                    dot={single ? { r: 4 } : false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))
              : unitNumbers.map((u) => {
                  const emphasized = u === selectedUnit || u === hoveredUnit;
                  return (
                    <Line
                      key={u}
                      dataKey={u}
                      name={u}
                      stroke={emphasized ? "var(--series-1)" : "var(--context-line)"}
                      strokeWidth={emphasized ? 2.5 : 1.5}
                      dot={single ? { r: emphasized ? 4 : 2.5 } : false}
                      activeDot={{ r: 4 }}
                      connectNulls={false}
                      isAnimationActive={false}
                      style={{ cursor: "pointer" }}
                      onClick={() => selectUnit(u === selectedUnit ? null : u)}
                    />
                  );
                })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
