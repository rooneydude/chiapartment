import { useMemo, useState } from "react";
import type {
  BuildingHistory,
  SnapshotDelta,
  UnitListing,
  UnitMapping,
} from "../../../shared/src/types";
import { listingKey, listingLabel } from "../../../shared/src/delta";
import { parseUnitNumber, stackFromPlan } from "../../../shared/src/parse";
import { UnitMappingSchema } from "../../../shared/src/types";
import { bedsLabel, daysSince, money, shortDate } from "../lib/format";
import { useStore } from "../state/store";

type SortKey = "unit" | "floor" | "plan" | "beds" | "sqft" | "price" | "avail" | "listed";

const FALLBACK_MAPPING = UnitMappingSchema.parse({});

export default function AvailabilityTable({
  units,
  delta,
  mapping,
  meta,
}: {
  units: UnitListing[];
  delta: SnapshotDelta | null;
  mapping: UnitMapping | undefined;
  meta: BuildingHistory["perUnitMeta"];
}) {
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const selectUnit = useStore((s) => s.selectUnit);
  const selectPlan = useStore((s) => s.selectPlan);
  const hoverUnit = useStore((s) => s.hoverUnit);
  const [sortKey, setSortKey] = useState<SortKey>("price");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const m = mapping ?? FALLBACK_MAPPING;
  const newSet = useMemo(
    () => new Set(delta?.newUnits.map(listingKey)),
    [delta],
  );
  const changeByKey = useMemo(() => {
    const map = new Map<string, { from: number; to: number }>();
    for (const c of delta?.priceChanges ?? []) {
      const key =
        c.unitNumber === c.floorplanName
          ? listingKey({ unitNumber: null, floorplanName: c.floorplanName, beds: c.beds })
          : listingKey({ unitNumber: c.unitNumber, floorplanName: c.floorplanName, beds: c.beds });
      map.set(key, c);
    }
    return map;
  }, [delta]);

  const sorted = useMemo(() => {
    const floorOf = (u: UnitListing) => parseUnitNumber(u.unitNumber, m).floor ?? -1;
    const val = (u: UnitListing): string | number => {
      switch (sortKey) {
        case "unit":
          return u.unitNumber ?? "";
        case "floor":
          return floorOf(u);
        case "plan":
          return u.floorplanName;
        case "beds":
          return u.beds;
        case "sqft":
          return u.sqft ?? 0;
        case "avail":
          return u.availableDate ?? "9999";
        case "listed":
          return u.unitNumber ? (meta[u.unitNumber]?.firstSeen ?? "9999") : "9999";
        default:
          return u.price;
      }
    };
    return [...units].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return cmp * sortDir;
    });
  }, [units, sortKey, sortDir, m]);

  const header = (key: SortKey, label: string, num = false) => (
    <th
      className={num ? "num" : undefined}
      onClick={() => {
        if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
        else {
          setSortKey(key);
          setSortDir(1);
        }
      }}
    >
      {label}
      {sortKey === key ? (sortDir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );

  return (
    <>
      <div className="tbl-wrap">
        <table className="units">
          <thead>
            <tr>
              {header("unit", "Unit")}
              {header("floor", "Fl", true)}
              {header("plan", "Plan")}
              {header("beds", "Beds")}
              {header("sqft", "SqFt", true)}
              {header("price", "Price", true)}
              <th className="num">Δ</th>
              {header("avail", "Avail")}
              {header("listed", "Listed", true)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((u, i) => {
              const key = listingKey(u) || `fp-${i}`;
              const change = changeByKey.get(listingKey(u));
              const floor = parseUnitNumber(u.unitNumber, m).floor;
              const planStack = !u.unitNumber ? stackFromPlan(u.floorplanName, m) : null;
              const isSelected =
                u.unitNumber !== null
                  ? selectedUnit === u.unitNumber
                  : planStack !== null && selectedPlan === u.floorplanName;
              return (
                <tr
                  key={key}
                  className={isSelected ? "sel" : undefined}
                  onClick={() => {
                    if (u.unitNumber) {
                      selectUnit(selectedUnit === u.unitNumber ? null : u.unitNumber);
                    } else if (planStack) {
                      selectPlan(selectedPlan === u.floorplanName ? null : u.floorplanName);
                    }
                  }}
                  onMouseEnter={() => hoverUnit(u.unitNumber)}
                  onMouseLeave={() => hoverUnit(null)}
                >
                  <td>
                    {u.unitNumber ?? "—"}{" "}
                    {newSet.has(listingKey(u)) && <span className="badge new">NEW</span>}
                  </td>
                  <td className="num">{floor ?? "—"}</td>
                  <td>{u.floorplanName}</td>
                  <td>{bedsLabel(u.beds)}</td>
                  <td className="num">{u.sqft?.toLocaleString() ?? "—"}</td>
                  <td className="num price-cell">
                    {money(u.price)}
                    {u.priceMax ? `+` : ""}
                    {u.leaseTermMonths != null && (
                      <span
                        title={`price applies to a ${u.leaseTermMonths}-month lease`}
                        style={{ marginLeft: 4, fontSize: "0.72em", opacity: 0.65 }}
                      >
                        {u.leaseTermMonths}mo
                      </span>
                    )}
                    {u.specials && (
                      <span title={u.specials} style={{ marginLeft: 4, cursor: "help" }}>
                        ✨
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {change && (
                      <span className={change.to < change.from ? "delta-down" : "delta-up"}>
                        {change.to < change.from ? "▼" : "▲"} {money(Math.abs(change.to - change.from))}
                      </span>
                    )}
                    {(() => {
                      const m = u.unitNumber ? meta[u.unitNumber] : undefined;
                      if (!m || m.firstPrice === u.price) return null;
                      const drop = u.price < m.firstPrice;
                      return (
                        <span
                          className={drop ? "delta-down" : "delta-up"}
                          title={`vs first listing ${shortDate(m.firstSeen)} at ${money(m.firstPrice)}`}
                          style={{ marginLeft: change ? 6 : 0, opacity: 0.75 }}
                        >
                          Σ{drop ? "▼" : "▲"}{money(Math.abs(u.price - m.firstPrice))}
                        </span>
                      );
                    })()}
                  </td>
                  <td>{u.availableDate ? shortDate(u.availableDate) : "—"}</td>
                  <td
                    className="num"
                    title={
                      u.unitNumber && meta[u.unitNumber]
                        ? `first seen ${shortDate(meta[u.unitNumber]!.firstSeen)}`
                        : undefined
                    }
                  >
                    {u.unitNumber && meta[u.unitNumber]
                      ? `${daysSince(meta[u.unitNumber]!.firstSeen)}d`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {delta && delta.removedUnits.length > 0 && (
        <div className="removed-block">
          No longer listed:{" "}
          {delta.removedUnits.map((u, i) => (
            <span key={listingKey(u) || i}>
              {i > 0 && ", "}
              <s>
                {listingLabel(u)} ({money(u.price)})
              </s>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
