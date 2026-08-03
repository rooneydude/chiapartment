import type { SnapshotDelta, UnitListing } from "./types";

/**
 * Diff two unit lists for one building. Units are keyed by unitNumber;
 * floorplan-only listings (unitNumber null) are excluded from unit-level
 * deltas — they have no stable identity across runs.
 */
export function computeDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
): SnapshotDelta {
  const delta: SnapshotDelta = {
    from,
    to,
    newUnits: [],
    removedUnits: [],
    priceChanges: [],
  };
  if (prevUnits === null) return delta; // first snapshot: nothing is "new"

  const prevByUnit = new Map<string, UnitListing>();
  for (const u of prevUnits) if (u.unitNumber) prevByUnit.set(u.unitNumber, u);

  const seen = new Set<string>();
  for (const u of currUnits) {
    if (!u.unitNumber) continue;
    seen.add(u.unitNumber);
    const prev = prevByUnit.get(u.unitNumber);
    if (!prev) {
      delta.newUnits.push(u);
    } else if (prev.price !== u.price) {
      delta.priceChanges.push({
        unitNumber: u.unitNumber,
        floorplanName: u.floorplanName,
        from: prev.price,
        to: u.price,
      });
    }
  }
  for (const [num, u] of prevByUnit) {
    if (!seen.has(num)) delta.removedUnits.push(u);
  }
  return delta;
}
