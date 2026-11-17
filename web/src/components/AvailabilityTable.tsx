import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  AlsoListedCompiled,
  BuildingConfig,
  BuildingHistory,
  DateChange,
  SnapshotDelta,
  UnitListing,
  UnitMapping,
} from "../../../shared/src/types";
import { alsoListedKey, listingKey, listingLabel } from "../../../shared/src/delta";
import {
  cheapestTerm,
  leaseTermTable,
  priceAtTerm,
  shortestTermAtAdvertisedPrice,
} from "../../../shared/src/listing";
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

/**
 * Key of a listing in `perUnitMeta`: its unit number, or — for floorplan /
 * stack listings that have none — the same identity deltas use.
 */
const metaKey = (u: UnitListing): string => u.unitNumber ?? listingKey(u);

/** What the building's leasing site publishes per apartment (from its config). */
type Publishes = BuildingConfig["publishes"];
/**
 * How a snapshot taken by the old scraper (before 15 Nov 2026) recorded a
 * row: at the cheapest rent for a lease of 14 months or less ("capped"), or
 * not in its list at all ("left-out" — shown here from its omitted record).
 * null for every row of a snapshot taken the current way.
 */
type Recorded = "capped" | "left-out" | null;

/** "a 12-month lease", "an 18-month lease" — the article follows the number as spoken. */
const monthLease = (months: number | null | undefined): string =>
  months == null ? "a lease" : `${/^(8|11|18)/.test(String(months)) ? "an" : "a"} ${months}-month lease`;

/** Numbers read the same whatever the browser's language is set to. */
const count = (n: number): string => n.toLocaleString("en-US");

/**
 * How to word a fact a row does not have. "The site does not publish it" is
 * only said when the building's config says so; otherwise the snapshot simply
 * did not record it — the site may well show it.
 */
function missing(publishes: Publishes, what: "moveInDate" | "leaseLength"): { detail: string; cell: string } {
  const notPublished = publishes?.[what] === false;
  if (what === "moveInDate") {
    return notPublished
      ? { detail: "The site publishes no move-in date", cell: "The leasing site publishes no move-in dates" }
      : { detail: "Move-in date not recorded in this snapshot", cell: "No move-in date was recorded for this listing in this snapshot" };
  }
  return notPublished
    ? { detail: "The site publishes no lease lengths", cell: "The leasing site does not say which lease length this price is for" }
    : { detail: "Lease length not recorded in this snapshot", cell: "No lease length was recorded for this price in this snapshot" };
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
  floor,
  change,
  publishes,
  recorded,
  dateChange,
}: {
  u: UnitListing;
  asOf: string;
  compareTerm: number;
  meta: BuildingHistory["perUnitMeta"][string] | undefined;
  floor: number | null;
  /** Price change since the previous scrape, when there is one. */
  change: SnapshotDelta["priceChanges"][number] | undefined;
  publishes: Publishes;
  recorded: Recorded;
  /** Move-in date change since the previous scrape, when there is one. */
  dateChange: DateChange | undefined;
}) {
  const table = leaseTermTable(u);
  const cheapest = cheapestTerm(u);
  const shortest = shortestTermAtAdvertisedPrice(u);
  const mi = moveIn(u, asOf);
  /** Required monthly charges the site lists in words only ("Varies"). */
  const unpriced = u.monthlyFeesUnpriced ?? [];
  const facts: string[] = [];
  facts.push(
    `${u.planType ? `${u.planType} (${bedsLabel(u.beds)})` : bedsLabel(u.beds)}${u.baths != null ? ` · ${u.baths} bath` : ""}`,
  );
  if (u.sqft != null) {
    facts.push(
      `${count(u.sqft)} sq ft${u.outdoorSqft ? ` + ${count(u.outdoorSqft)} outdoor` : ""}`,
    );
  } else {
    facts.push(publishes?.sqft === false ? "The site publishes no square footage" : "Square footage not recorded");
  }
  facts.push(mi.kind === "unknown" ? missing(publishes, "moveInDate").detail : mi.title);
  if (floor !== null) facts.unshift(`Floor ${floor}`);
  if (dateChange) {
    facts.push(
      `Move-in date changed since the previous scrape: was ${dateChange.from ? longDate(dateChange.from) : "not given"}`,
    );
  }
  // The same statement the Δ column makes — on a phone, where that column
  // gives way, this is the only place it is made.
  if (change && !change.notComparable) {
    facts.push(
      `${change.to < change.from ? "Down" : "Up"} ${money(Math.abs(change.to - change.from))} since ${
        change.since
          ? `${shortDate(change.since)}, the last time it was priced the same way`
          : "the previous scrape"
      } (${money(change.from)} → ${money(change.to)})`,
    );
  } else if (change?.notComparable === "lease-term") {
    facts.push(
      `The site now advertises ${monthLease(change.toTerm)} instead of ${change.fromTerm} months (${money(change.from)} → ${money(change.to)}) — a different lease length, not a like-for-like price change`,
    );
  } else if (change?.notComparable === "price-form") {
    facts.push(
      `The site switched between a rent range and a single price (${money(change.from)} → ${money(change.to)}) — not counted as a price change`,
    );
  }
  if (u.unitNumber !== null && u.floorplanName !== (u.planType ?? bedsLabel(u.beds))) {
    facts.push(`Plan ${u.floorplanName}`);
  }
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

      {u.monthlyFees && (
        <div className="unit-detail-note">
          Base rent {priceLabel(u.price, u.priceMax)} + required monthly fees{" "}
          {priceLabel(u.monthlyFees.min, u.monthlyFees.max)} ={" "}
          <strong>
            {priceLabel(u.price + u.monthlyFees.min, (u.priceMax ?? u.price) + u.monthlyFees.max)}
          </strong>{" "}
          a month, which is the figure the leasing site headlines.
          {unpriced.length === 0 ? " Usage-based utilities and insurance are extra." : ""}
        </div>
      )}
      {unpriced.length > 0 && (
        <div className="unit-detail-note">
          {u.monthlyFees
            ? "Also required every month, with no amount published by the site: "
            : `${priceLabel(u.price, u.priceMax)} is base rent. Also required every month, but the site publishes no amount for ${unpriced.length === 1 ? "it" : "them"}: `}
          <strong>{unpriced.join("; ")}</strong>.
        </div>
      )}
      {shortest !== null && u.leaseTermMonths != null && shortest < u.leaseTermMonths && (
        <div className="unit-detail-note">
          The site advertises {money(u.price)} with “{u.leaseTermMonths} months”, but that is just
          the longest lease at this price — a <strong>{shortest}-month</strong> lease costs the
          same.
        </div>
      )}

      {table.length > 1 ? (
        <>
          <div className="unit-detail-title">
            Lease length → monthly rent
            {u.availableDate ? ` for a ${mi.kind === "now" ? "move-in now" : `${longDate(u.availableDate)} move-in`}` : ""}
          </div>
          <div className="lease-grid" role="list" aria-label="Lease term prices">
            {table.map((t) => {
              const isAdvertised = t.months === u.leaseTermMonths;
              const isCheapest = cheapest !== null && t.price === cheapest.price;
              const extra = cheapest ? t.price - cheapest.price : 0;
              return (
                <div
                  key={t.months}
                  role="listitem"
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
          <div className="lease-key">
            Outlined: the lease length the site advertises this apartment at · ★ your {compareTerm}-month
            comparison
          </div>
        </>
      ) : (
        <div className="unit-detail-note">
          {recorded === "left-out"
            ? `The scraper that took this snapshot left this apartment out of its list, because the site offered it for no lease of 14 months or less. ${money(u.price)} is the rent the site advertised${u.leaseTermMonths != null ? `, for ${monthLease(u.leaseTermMonths)}` : ""}. Its other lease lengths and its move-in date were not recorded; the next refresh records them.`
            : recorded === "capped"
              ? `This snapshot was taken the old way: ${money(u.price)} is the cheapest rent the site offered for a lease of 14 months or less${u.leaseTermMonths != null ? ` (here ${u.leaseTermMonths} months)` : ""}, which can be more than the rent it advertised. The advertised rent and the other lease lengths were not recorded; the next refresh records them.`
              : u.leaseTermMonths != null
                ? publishes?.leaseTable === false
                  ? `The site quotes ${money(u.price)} for ${monthLease(u.leaseTermMonths)} and publishes no other lease lengths.`
                  : `The site quotes ${money(u.price)} for ${monthLease(u.leaseTermMonths)}. Its prices for other lease lengths were not recorded in this snapshot.`
                : publishes?.leaseLength !== false
                  ? "No lease length was recorded for this price in this snapshot."
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

function AlsoListedBlock({
  rows,
  asOf,
  newKeys,
}: {
  rows: AlsoListedCompiled[];
  asOf: string;
  /** Keys of the rows that appeared since the previous scrape. */
  newKeys: Set<string>;
}) {
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
            a.sqft != null ? `${count(a.sqft)} sq ft` : null,
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
              {newKeys.has(alsoListedKey(a) ?? "") && (
                <>
                  {" "}
                  <span className="badge new" title="Not on the site at the previous scrape">
                    NEW
                  </span>
                </>
              )}
              <span className="also-note"> — {a.note}</span>
              {bits.length > 0 && <span className="also-bits"> · {bits.join(" · ")}</span>}
              {a.lastPrice !== undefined && a.lastPricedAt && (
                <span className="also-bits">
                  {" "}
                  · last listed with a price on {shortDate(a.lastPricedAt)}: {money(a.lastPrice)}
                </span>
              )}
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
  publishes,
  leftOutKeys,
  totalListed,
  hasSnapshot,
}: {
  units: UnitListing[];
  delta: SnapshotDelta | null;
  mapping: UnitMapping | undefined;
  meta: BuildingHistory["perUnitMeta"];
  /** Timestamp of the snapshot the units come from. */
  asOf: string;
  /** Lease length shown as a comparison next to the advertised one. */
  compareTerm: number;
  alsoListed: AlsoListedCompiled[];
  /** What the leasing site publishes per apartment, so an empty cell can be worded truthfully. */
  publishes: Publishes;
  /**
   * Set when the snapshot was taken by the old scraper: the keys of the
   * listings it had left out of its list (shown here from its omitted record).
   * null for a snapshot taken the current way.
   */
  leftOutKeys: Set<string> | null;
  /** Listings in the snapshot before any filter. */
  totalListed: number;
  /** False when the building has never been scraped successfully. */
  hasSnapshot: boolean;
}) {
  const oldMethod = leftOutKeys !== null;
  const recordedAs = (u: UnitListing): Recorded =>
    leftOutKeys === null ? null : leftOutKeys.has(listingKey(u)) ? "left-out" : "capped";
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
  // New against the previous scrape, but listed before: back, not new.
  const relistedSet = useMemo(() => new Set(delta?.relistedKeys ?? []), [delta]);
  // On the site all along, but without a price until now.
  const pricedAgain = useMemo(
    () => new Map((delta?.pricedAgain ?? []).map((p) => [p.key, p])),
    [delta],
  );
  const newAlsoKeys = useMemo(
    () =>
      new Set(
        (delta?.newAlsoListed ?? []).map(alsoListedKey).filter((k): k is string => k !== null),
      ),
    [delta],
  );
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

  const dateChangeByKey = useMemo(() => {
    const map = new Map<string, DateChange>();
    for (const c of delta?.dateChanges ?? []) {
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
        case "listed": {
          // The cell shows days since first seen: more recent = fewer days.
          const firstSeen = meta[metaKey(u)]?.firstSeen;
          return firstSeen ? -new Date(firstSeen).getTime() : null;
        }
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

  // `secondary` columns give way on a phone, where rent, lease length and
  // move-in date must be readable without scrolling sideways; what they hold
  // is repeated in the row's detail panel.
  const header = (key: SortKey, label: string, num = false, title?: string, secondary = false) => (
    <th
      className={[num ? "num" : "", secondary ? "hide-sm" : ""].join(" ").trim() || undefined}
      title={title}
      aria-sort={sortKey === key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="sort-btn"
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
      </button>
    </th>
  );

  const COLS = 9;
  // "—" must not read as a tracker gap: say when the site simply does not publish it.
  const noTerm = units.filter((u) => u.leaseTermMonths == null && leaseTermTable(u).length === 0).length;
  const noDate = units.filter((u) => moveIn(u, asOf).kind === "unknown").length;

  return (
    <>
      <div className="tbl-wrap">
        {/* "no-lease": no listing here carries a lease length, so on a narrow
            screen that column of dashes gives way (the footnote says why). */}
        <table
          className={`units${units.length > 0 && noTerm === units.length ? " no-lease" : ""}`}
          aria-label="Listed units"
        >
          <thead>
            <tr>
              {header("unit", "Unit")}
              {header("floor", "Fl", true, undefined, true)}
              {header("type", "Type")}
              {header("sqft", "SqFt", true, undefined, true)}
              {header(
                "price",
                leaseTerm !== null ? `Rent @${leaseTerm}mo` : "Rent",
                true,
                leaseTerm !== null
                  ? `Monthly rent for ${monthLease(leaseTerm)} where the site publishes it`
                  : oldMethod
                    ? "This snapshot was taken the old way: each apartment's cheapest rent for a lease of 14 months or less — and, for the apartments that had none, the rent the site advertised (see the Lease column)"
                    : "Monthly rent exactly as the leasing site advertises it",
              )}
              {header("lease", "Lease", false, "Lease length the shown rent is for")}
              {header("movein", "Move-in", false, "Earliest move-in date")}
              <th className="num hide-sm" title="Change since the previous scrape (like-for-like lease length), and since the unit was first listed (Σ)">
                Δ
              </th>
              {header("listed", "Listed", true, "Days since the tracker first saw this unit", true)}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr className="empty-row">
                <td colSpan={COLS}>
                  {!hasSnapshot
                    ? "This building has not been read successfully yet — there is nothing to show."
                    : totalListed === 0
                      ? "The last scrape found no listings on the leasing site."
                      : "No listings match the current filters."}
                </td>
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
              const shortest = shortestTermAtAdvertisedPrice(u);
              const atCompare =
                shown.term !== compareTerm && !shown.termUnavailable
                  ? priceAtTerm(u, compareTerm)
                  : null;
              const first = meta[metaKey(u)];
              // Since-first-listing change, only when it is like for like.
              const nowAtFirstTerm =
                first === undefined
                  ? null
                  : first.firstTerm === undefined || first.firstTerm === (u.leaseTermMonths ?? undefined)
                    ? u.price
                    : priceAtTerm(u, first.firstTerm);
              const recorded = recordedAs(u);
              const dateChange = dateChangeByKey.get(listingKey(u));
              // An old-method rent against a first price with no lease length
              // on record is two different kinds of number.
              const sigmaComparable = !(recorded === "capped" && first?.firstTerm === undefined);
              return (
                <Fragment key={key}>
                  <tr
                    ref={isSelected && u.unitNumber !== null ? selectedRow : undefined}
                    className={`${isSelected ? "sel" : ""}${isOpen ? " open" : ""}`.trim() || undefined}
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
                    <td
                      title={
                        u.unitNumber === null
                          ? "The site lists this as a floorplan / stack with a starting price, not as an individual unit"
                          : undefined
                      }
                    >
                      {/* The row opens on a click anywhere in it; this button is the
                          same control for the keyboard (its click bubbles to the row). */}
                      <button
                        type="button"
                        className="row-toggle"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Hide" : "Show"} lease terms and details for ${
                          u.unitNumber ? `unit ${u.unitNumber}` : u.floorplanName
                        }`}
                      >
                        <span className="caret" aria-hidden="true">
                          {isOpen ? "▾" : "▸"}
                        </span>
                        {/* A floorplan-level listing is identified by its plan name. */}
                        {u.unitNumber ?? <span className="plan-as-unit">{u.floorplanName}</span>}
                      </button>{" "}
                      {newSet.has(listingKey(u)) &&
                        (pricedAgain.has(listingKey(u)) ? (
                          <span
                            className="badge back"
                            title={(() => {
                              const again = pricedAgain.get(listingKey(u))!;
                              return again.lastPrice !== undefined && again.lastPricedAt
                                ? `Has a price again — it was ${money(again.lastPrice)} when last priced (${shortDate(again.lastPricedAt)})`
                                : "Listed without a price until now";
                            })()}
                          >
                            PRICED
                          </span>
                        ) : relistedSet.has(listingKey(u)) ? (
                          <span
                            className="badge back"
                            title={`Back on the leasing site${first ? ` — first listed ${shortDate(first.firstSeen)}` : ""}`}
                          >
                            BACK
                          </span>
                        ) : (
                          <span className="badge new" title="Not listed at the previous scrape">
                            NEW
                          </span>
                        ))}
                    </td>
                    <td className="num hide-sm">{floor ?? "—"}</td>
                    <td
                      title={
                        u.planType
                          ? `The site calls this a "${u.planType}" — counted with ${bedsLabel(u.beds)} listings`
                          : undefined
                      }
                    >
                      {u.planType ?? bedsLabel(u.beds)}
                      {u.unitNumber !== null && u.floorplanName !== (u.planType ?? bedsLabel(u.beds)) && (
                        <>
                          {" "}
                          <span className="plan-name" title={`Floor plan ${u.floorplanName}`}>
                            {u.floorplanName}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="num hide-sm">{u.sqft != null ? count(u.sqft) : "—"}</td>
                    <td className="num price-cell">
                      <span
                        className={shown.termUnavailable ? "price-fallback" : undefined}
                        title={
                          shown.termUnavailable
                            ? `No ${leaseTerm}-month price is published for this listing — showing the advertised price`
                            : undefined
                        }
                      >
                        {/* a range may break after its dash where the column is narrow */}
                        {priceLabel(shown.price, shown.priceMax).replace("–", "–\u200B")}
                      </span>
                      {u.specials && (
                        <span title={u.specials} className="special-mark">
                          ✨
                        </span>
                      )}
                    </td>
                    <td className="lease-col">
                      {shown.term !== null ? (
                        <span
                          className="lease-term"
                          title={
                            leaseTerm === null && shortest !== null && shortest < shown.term
                              ? `Advertised with ${monthLease(shown.term)}, but ${monthLease(shortest)} costs the same`
                              : `Rent shown is for ${monthLease(shown.term)}`
                          }
                        >
                          {shown.term} mo
                          {leaseTerm === null && shortest !== null && shortest < shown.term ? "*" : ""}
                        </span>
                      ) : (
                        <span className="muted" title={missing(publishes, "leaseLength").cell}>
                          —
                        </span>
                      )}
                      {atCompare !== null && (
                        <span className="lease-compare" title={`Rent for ${monthLease(compareTerm)}`}>
                          {compareTerm} mo {money(atCompare)}
                        </span>
                      )}
                      {termCount > 1 && atCompare === null && (
                        <span className="lease-compare">{termCount} terms</span>
                      )}
                    </td>
                    <td
                      className="movein-col"
                      title={mi.kind === "unknown" ? missing(publishes, "moveInDate").cell : mi.title}
                    >
                      {mi.kind === "now" ? (
                        <span className="badge now">Now</span>
                      ) : mi.kind === "future" ? (
                        mi.label
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {dateChange && (
                        <span
                          className="lease-compare"
                          title="The move-in date changed since the previous scrape"
                        >
                          was {dateChange.from ? shortDate(dateChange.from) : "not given"}
                        </span>
                      )}
                    </td>
                    <td className="num hide-sm">
                      {change && !change.notComparable && (
                        <span
                          className={change.to < change.from ? "delta-down" : "delta-up"}
                          title={`${money(change.from)} → ${money(change.to)}${
                            change.fromTerm === undefined
                              ? ""
                              : change.fromTerm === change.toTerm
                                ? ` for ${monthLease(change.fromTerm)}`
                                : ` — the rent the site advertises (it headlined ${monthLease(change.fromTerm)}, now ${change.toTerm} months)`
                          } since ${
                            change.since
                              ? `${shortDate(change.since)}, the last time this unit was priced the same way (range or single price)`
                              : "the previous scrape"
                          }${change.sourceUpdatedAt ? ` — the building set this price on ${shortDate(change.sourceUpdatedAt)}` : ""}`}
                        >
                          {change.to < change.from ? "▼" : "▲"} {money(Math.abs(change.to - change.from))}
                        </span>
                      )}
                      {change?.notComparable === "lease-term" && (
                        <span
                          className="muted"
                          title={`The site now advertises ${monthLease(change.toTerm)} instead of ${change.fromTerm} months (${money(change.from)} → ${money(change.to)}) — not a like-for-like price change`}
                        >
                          {change.fromTerm}→{change.toTerm}mo
                        </span>
                      )}
                      {change?.notComparable === "price-form" && (
                        <span
                          className="muted"
                          title={`The site switched between printing a rent range and a single price for this unit (${money(change.from)} → ${money(change.to)}). This site alternates between two pricing states for some plans, so it is not counted as a price change.`}
                        >
                          ≈ {money(change.from)}
                        </span>
                      )}
                      {first && sigmaComparable && nowAtFirstTerm !== null && nowAtFirstTerm !== first.firstPrice && (
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
                      className="num hide-sm"
                      title={first ? `first seen ${shortDate(first.firstSeen)}` : undefined}
                    >
                      {first ? `${daysSince(first.firstSeen)}d` : "—"}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail-row">
                      <td colSpan={COLS}>
                        <UnitDetail
                          u={u}
                          asOf={asOf}
                          compareTerm={compareTerm}
                          meta={first}
                          floor={floor}
                          change={change}
                          publishes={publishes}
                          recorded={recorded}
                          dateChange={dateChange}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(noTerm > 0 || noDate > 0) && (
        <div className="table-footnote">
          {noTerm > 0 &&
            (publishes?.leaseLength === false
              ? noTerm === units.length
                ? "Lease “—”: this leasing site does not publish lease lengths. "
                : `Lease “—”: the site publishes no lease length for ${noTerm} of these listings. `
              : `Lease “—”: no lease length was recorded for ${noTerm === units.length ? "these listings" : `${noTerm} of these listings`} in this snapshot. `)}
          {noDate > 0 &&
            (publishes?.moveInDate === false
              ? noDate === units.length
                ? "Move-in “—”: the site publishes no move-in dates."
                : `Move-in “—”: no date published for ${noDate} of these listings.`
              : `Move-in “—”: no move-in date was recorded for ${noDate === units.length ? "these listings" : `${noDate} of these listings`} in this snapshot — the leasing site may show one.`)}
        </div>
      )}
      <AlsoListedBlock rows={alsoListed} asOf={asOf} newKeys={newAlsoKeys} />
      {delta && delta.removedUnits.length + (delta.removedAlsoListed?.length ?? 0) > 0 && (
        <div className="removed-block">
          No longer listed since the previous scrape:{" "}
          {delta.removedUnits.map((u, i) => (
            <span key={listingKey(u) || i}>
              {i > 0 && ", "}
              <s>
                {listingLabel(u)} ({u.planType ?? bedsLabel(u.beds)}, {priceLabel(u.price, u.priceMax)})
              </s>
            </span>
          ))}
          {(delta.removedAlsoListed ?? []).map((a, i) => (
            <span key={`also-${alsoListedKey(a) ?? i}`}>
              {(i > 0 || delta.removedUnits.length > 0) && ", "}
              <s>
                {a.unitNumber ? `#${a.unitNumber}` : a.floorplanName} (
                {a.price !== undefined ? priceLabel(a.price, a.priceMax) : "no price"})
              </s>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
