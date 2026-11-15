import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  AlsoListed,
  BuildingHistory,
  SnapshotDelta,
  UnitListing,
  UnitMapping,
} from "../../../shared/src/types";
import { listingKey, listingLabel } from "../../../shared/src/delta";
import { cheapestTerm, leaseTermTable, priceAtTerm } from "../../../shared/src/listing";
import { parseUnitNumber, stackFromPlan } from "../../../shared/src/parse";
import { UnitMappingSchema } from "../../../shared/src/types";
import {
  bedsLabel,
  daysSince,
  longDate,
  money,
  moveIn,
  priceLabel,
  shortDate,
} from "../lib/format";
import { useStore } from "../state/store";

type SortKey = "unit" | "floor" | "type" | "sqft" | "price" | "lease" | "movein" | "listed";

const FALLBACK_MAPPING = UnitMappingSchema.parse({});

/** The price a row shows: the site's own headline, or a chosen lease length. */
export interface ShownPrice {
  price: number;
  priceMax?: number;
  /** Lease term the shown price is for; null when the site gives none. */
  term: number | null;
  /** A lease length was asked for that this unit has no published price for. */
  termUnavailable: boolean;
}

export function shownPrice(u: UnitListing, leaseTerm: number | null): ShownPrice {
  if (leaseTerm !== null) {
    const at = priceAtTerm(u, leaseTerm);
    if (at !== null) return { price: at, term: leaseTerm, termUnavailable: false };
    return {
      price: u.price,
      ...(u.priceMax !== undefined ? { priceMax: u.priceMax } : {}),
      term: u.leaseTermMonths ?? null,
      termUnavailable: true,
    };
  }
  return {
    price: u.price,
    ...(u.priceMax !== undefined ? { priceMax: u.priceMax } : {}),
    term: u.leaseTermMonths ?? null,
    termUnavailable: false,
  };
}

/** nulls always sort last, whatever the direction. */
function compare(a: string | number | null, b: string | number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true });
  return cmp * dir;
}

function UnitDetail({
  u,
  asOf,
  compareTerm,
  meta,
}: {
  u: UnitListing;
  asOf: string;
  compareTerm: number;
  meta: BuildingHistory["perUnitMeta"][string] | undefined;
}) {
  const table = leaseTermTable(u);
  const cheapest = cheapestTerm(u);
  const mi = moveIn(u, asOf);
  const facts: string[] = [];
  facts.push(`${bedsLabel(u.beds)}${u.baths != null ? ` · ${u.baths} bath` : ""}`);
  if (u.sqft != null) {
    facts.push(
      `${u.sqft.toLocaleString()} sq ft${u.outdoorSqft ? ` + ${u.outdoorSqft.toLocaleString()} outdoor` : ""}`,
    );
  }
  facts.push(mi.kind === "unknown" ? "No move-in date published" : mi.title);
  if (meta) {
    facts.push(
      `First seen ${longDate(meta.firstSeen)} at ${money(meta.firstPrice)}${meta.firstTerm ? ` (${meta.firstTerm}-mo lease)` : ""}`,
    );
  }

  return (
    <div className="unit-detail">
      <div className="unit-detail-facts">
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>

      {table.length > 1 ? (
        <>
          <div className="unit-detail-title">
            Lease length → monthly rent
            {u.availableDate ? ` for a ${mi.kind === "now" ? "move-in now" : `${longDate(u.availableDate)} move-in`}` : ""}
          </div>
          <div className="lease-grid" role="table" aria-label="Lease term prices">
            {table.map((t) => {
              const isAdvertised = t.months === u.leaseTermMonths;
              const isCheapest = cheapest !== null && t.price === cheapest.price;
              const extra = cheapest ? t.price - cheapest.price : 0;
              return (
                <div
                  key={t.months}
                  role="row"
                  className={`lease-cell${isAdvertised ? " advertised" : ""}${isCheapest ? " cheapest" : ""}${t.months === compareTerm ? " compare" : ""}`}
                  title={
                    isAdvertised
                      ? "The lease length the site advertises this unit at"
                      : extra > 0
                        ? `${money(extra)}/mo more than the cheapest lease length`
                        : "Cheapest lease length"
                  }
                >
                  <span className="lease-months">{t.months} mo</span>
                  <span className="lease-price">{money(t.price)}</span>
                  <span className="lease-extra">{extra > 0 ? `+${money(extra)}` : "lowest"}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="unit-detail-note">
          {u.leaseTermMonths != null
            ? `The site quotes ${money(u.price)} for a ${u.leaseTermMonths}-month lease and publishes no other lease lengths.`
            : u.priceMax !== undefined
              ? `The site prints a range (${priceLabel(u.price, u.priceMax)}) instead of a price per lease length — the price for each lease term is shown in its leasing portal.`
              : "The site publishes one price and no lease lengths for this listing — ask the leasing office or open the listing for terms."}
        </div>
      )}

      {u.specials && <div className="unit-detail-note">✨ {u.specials}</div>}
      {u.sourceUpdatedAt && (
        <div className="unit-detail-note">
          The building last edited this price on {longDate(u.sourceUpdatedAt)} — it is a
          hand-maintained “starting from” figure, not a live quote.
        </div>
      )}
      {u.url && (
        <a
          className="unit-link"
          href={u.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          Open on the leasing site ↗
        </a>
      )}
    </div>
  );
}

function AlsoListedBlock({ rows, asOf }: { rows: AlsoListed[]; asOf: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="also-listed">
      <div className="also-listed-title">
        Also on the leasing site — not in the table above because the site gives no price or no
        bed count
      </div>
      <ul>
        {rows.map((a, i) => {
          const mi = moveIn(
            { availableDate: a.availableDate ?? null, ...(a.availableNow !== undefined ? { availableNow: a.availableNow } : {}) },
            asOf,
          );
          const bits = [
            a.beds !== null ? bedsLabel(a.beds) : null,
            a.sqft != null ? `${a.sqft.toLocaleString()} sq ft` : null,
            a.price !== undefined ? priceLabel(a.price, a.priceMax) : null,
            mi.kind === "now" ? "move-in now" : mi.kind === "future" ? `move-in ${mi.label}` : null,
          ].filter((b): b is string => b !== null);
          const label = a.unitNumber ? `#${a.unitNumber} · ${a.floorplanName}` : a.floorplanName;
          return (
            <li key={`${label}-${i}`}>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {label} ↗
                </a>
              ) : (
                <span>{label}</span>
              )}
              <span className="also-note"> — {a.note}</span>
              {bits.length > 0 && <span className="also-bits"> · {bits.join(" · ")}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function AvailabilityTable({
  units,
  delta,
  mapping,
  meta,
  asOf,
  compareTerm,
  alsoListed,
}: {
  units: UnitListing[];
  delta: SnapshotDelta | null;
  mapping: UnitMapping | undefined;
  meta: BuildingHistory["perUnitMeta"];
  /** Timestamp of the snapshot the units come from. */
  asOf: string;
  /** Lease length shown as a comparison next to the advertised one. */
  compareTerm: number;
  alsoListed: AlsoListed[];
}) {
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const selectUnit = useStore((s) => s.selectUnit);
  const selectPlan = useStore((s) => s.selectPlan);
  const hoverUnit = useStore((s) => s.hoverUnit);
  const leaseTerm = useStore((s) => s.leaseTerm);
  const [sortKey, setSortKey] = useState<SortKey>("price");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  /** Expanded row for listings that have no unit number to select. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const selectedRow = useRef<HTMLTableRowElement | null>(null);

  const m = mapping ?? FALLBACK_MAPPING;
  const newSet = useMemo(() => new Set(delta?.newUnits.map(listingKey)), [delta]);
  const changeByKey = useMemo(() => {
    const map = new Map<string, SnapshotDelta["priceChanges"][number]>();
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
    const val = (u: UnitListing): string | number | null => {
      switch (sortKey) {
        case "unit":
          return u.unitNumber ?? u.floorplanName;
        case "floor":
          return parseUnitNumber(u.unitNumber, m).floor;
        case "type":
          return u.beds * 1000 + (u.sqft ?? 0) / 100;
        case "sqft":
          return u.sqft;
        case "lease":
          return shownPrice(u, leaseTerm).term;
        case "movein":
          return moveIn(u, asOf).days;
        case "listed":
          return u.unitNumber ? (meta[u.unitNumber]?.firstSeen ?? null) : null;
        default:
          return shownPrice(u, leaseTerm).price;
      }
    };
    return [...units].sort(
      (a, b) =>
        compare(val(a), val(b), sortDir) ||
        // Stable, readable tie-break: cheapest first, then unit number.
        a.price - b.price ||
        String(a.unitNumber ?? a.floorplanName).localeCompare(
          String(b.unitNumber ?? b.floorplanName),
          undefined,
          { numeric: true },
        ),
    );
  }, [units, sortKey, sortDir, m, meta, leaseTerm, asOf]);

  // A unit picked in the 3D scene or the chart scrolls into view here.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedUnit]);

  const header = (key: SortKey, label: string, num = false, title?: string) => (
    <th
      className={num ? "num" : undefined}
      title={title}
      aria-sort={sortKey === key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
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

  const COLS = 9;

  return (
    <>
      <div className="tbl-wrap">
        <table className="units">
          <thead>
            <tr>
              {header("unit", "Unit")}
              {header("floor", "Fl", true)}
              {header("type", "Type")}
              {header("sqft", "SqFt", true)}
              {header(
                "price",
                leaseTerm !== null ? `Rent @${leaseTerm}mo` : "Rent",
                true,
                leaseTerm !== null
                  ? `Monthly rent for a ${leaseTerm}-month lease where the site publishes it`
                  : "Monthly rent exactly as the leasing site advertises it",
              )}
              {header("lease", "Lease", false, "Lease length the shown rent is for")}
              {header("movein", "Move-in", false, "Earliest move-in date")}
              <th className="num" title="Change since the previous scrape (like-for-like lease length), and since the unit was first listed (Σ)">
                Δ
              </th>
              {header("listed", "Listed", true, "Days since the tracker first saw this unit")}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr className="empty-row">
                <td colSpan={COLS}>No listings match the current filters.</td>
              </tr>
            )}
            {sorted.map((u, i) => {
              const key = listingKey(u) || `fp-${i}`;
              const change = changeByKey.get(listingKey(u));
              const floor = parseUnitNumber(u.unitNumber, m).floor;
              const planStack = !u.unitNumber ? stackFromPlan(u.floorplanName, m) : null;
              const isSelected =
                u.unitNumber !== null
                  ? selectedUnit === u.unitNumber
                  : planStack !== null && selectedPlan === u.floorplanName;
              const isOpen = u.unitNumber !== null ? isSelected : openKey === key;
              const shown = shownPrice(u, leaseTerm);
              const mi = moveIn(u, asOf);
              const termCount = leaseTermTable(u).length;
              const atCompare =
                shown.term !== compareTerm && !shown.termUnavailable
                  ? priceAtTerm(u, compareTerm)
                  : null;
              const first = u.unitNumber ? meta[u.unitNumber] : undefined;
              // Since-first-listing change, only when it is like for like.
              const nowAtFirstTerm =
                first === undefined
                  ? null
                  : first.firstTerm === undefined || first.firstTerm === (u.leaseTermMonths ?? undefined)
                    ? u.price
                    : priceAtTerm(u, first.firstTerm);
              return (
                <Fragment key={key}>
                  <tr
                    ref={isSelected && u.unitNumber !== null ? selectedRow : undefined}
                    className={`${isSelected ? "sel" : ""}${isOpen ? " open" : ""}`.trim() || undefined}
                    aria-expanded={isOpen}
                    onClick={() => {
                      if (u.unitNumber) {
                        selectUnit(selectedUnit === u.unitNumber ? null : u.unitNumber);
                      } else {
                        setOpenKey(openKey === key ? null : key);
                        if (planStack) {
                          selectPlan(selectedPlan === u.floorplanName ? null : u.floorplanName);
                        }
                      }
                    }}
                    onMouseEnter={() => hoverUnit(u.unitNumber)}
                    onMouseLeave={() => hoverUnit(null)}
                  >
                    <td>
                      <span className="caret" aria-hidden="true">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      {u.unitNumber ?? "—"}{" "}
                      {newSet.has(listingKey(u)) && <span className="badge new">NEW</span>}
                    </td>
                    <td className="num">{floor ?? "—"}</td>
                    <td>
                      {bedsLabel(u.beds)} <span className="plan-name">{u.floorplanName}</span>
                    </td>
                    <td className="num">{u.sqft?.toLocaleString() ?? "—"}</td>
                    <td className="num price-cell">
                      <span
                        className={shown.termUnavailable ? "price-fallback" : undefined}
                        title={
                          shown.termUnavailable
                            ? `No ${leaseTerm}-month price is published for this listing — showing the advertised price`
                            : undefined
                        }
                      >
                        {priceLabel(shown.price, shown.priceMax)}
                      </span>
                      {u.specials && (
                        <span title={u.specials} className="special-mark">
                          ✨
                        </span>
                      )}
                    </td>
                    <td className="lease-col">
                      {shown.term !== null ? (
                        <span className="lease-term">{shown.term} mo</span>
                      ) : (
                        <span
                          className="muted"
                          title="The leasing site does not say which lease length this price is for"
                        >
                          —
                        </span>
                      )}
                      {atCompare !== null && (
                        <span className="lease-compare" title={`Rent for a ${compareTerm}-month lease`}>
                          {compareTerm} mo {money(atCompare)}
                        </span>
                      )}
                      {termCount > 1 && atCompare === null && (
                        <span className="lease-compare">{termCount} terms</span>
                      )}
                    </td>
                    <td title={mi.title}>
                      {mi.kind === "now" ? (
                        <span className="badge now">Now</span>
                      ) : mi.kind === "future" ? (
                        mi.label
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {change && !change.termChangeOnly && (
                        <span
                          className={change.to < change.from ? "delta-down" : "delta-up"}
                          title={`${money(change.from)} → ${money(change.to)}${change.fromTerm ? ` for a ${change.fromTerm}-month lease` : ""} since the previous scrape`}
                        >
                          {change.to < change.from ? "▼" : "▲"} {money(Math.abs(change.to - change.from))}
                        </span>
                      )}
                      {change?.termChangeOnly && (
                        <span
                          className="muted"
                          title={`The site now advertises a ${change.toTerm}-month lease instead of ${change.fromTerm} months (${money(change.from)} → ${money(change.to)}) — not a like-for-like price change`}
                        >
                          {change.fromTerm}→{change.toTerm}mo
                        </span>
                      )}
                      {first && nowAtFirstTerm !== null && nowAtFirstTerm !== first.firstPrice && (
                        <span
                          className={nowAtFirstTerm < first.firstPrice ? "delta-down" : "delta-up"}
                          title={`vs first listing ${shortDate(first.firstSeen)} at ${money(first.firstPrice)}${first.firstTerm ? ` (${first.firstTerm}-month lease)` : ""}`}
                          style={{ marginLeft: change ? 6 : 0, opacity: 0.75 }}
                        >
                          Σ{nowAtFirstTerm < first.firstPrice ? "▼" : "▲"}
                          {money(Math.abs(nowAtFirstTerm - first.firstPrice))}
                        </span>
                      )}
                    </td>
                    <td
                      className="num"
                      title={first ? `first seen ${shortDate(first.firstSeen)}` : undefined}
                    >
                      {first ? `${daysSince(first.firstSeen)}d` : "—"}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail-row">
                      <td colSpan={COLS}>
                        <UnitDetail u={u} asOf={asOf} compareTerm={compareTerm} meta={first} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <AlsoListedBlock rows={alsoListed} asOf={asOf} />
      {delta && delta.removedUnits.length > 0 && (
        <div className="removed-block">
          No longer listed since the previous scrape:{" "}
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
