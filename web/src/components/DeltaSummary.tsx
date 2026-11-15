import type { SnapshotDelta } from "../../../shared/src/types";
import { dateTime } from "../lib/format";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One-line "what changed since the previous scrape", all bed types. */
export default function DeltaSummary({ delta }: { delta: SnapshotDelta | null }) {
  if (!delta || !delta.from) return null;
  // Only like-for-like moves count as price changes; a site switching which
  // lease length it headlines is reported separately.
  const real = delta.priceChanges.filter((c) => !c.notComparable);
  const termSwitches = delta.priceChanges.length - real.length;
  const drops = real.filter((c) => c.to < c.from).length;
  const hikes = real.length - drops;
  const dates = delta.dateChanges?.length ?? 0;
  const parts: string[] = [];
  const back = delta.relistedKeys?.length ?? 0;
  const priced = delta.pricedAgain?.length ?? 0;
  const brandNew = delta.newUnits.length - back - priced + (delta.newAlsoListed?.length ?? 0);
  if (brandNew > 0) parts.push(`${brandNew} new`);
  if (back > 0) parts.push(`${back} back on the site`);
  if (priced > 0) parts.push(`${priced} with a price again`);
  const removed = delta.removedUnits.length + (delta.removedAlsoListed?.length ?? 0);
  if (removed) parts.push(`${removed} removed`);
  if (drops) parts.push(plural(drops, "price drop"));
  if (hikes) parts.push(plural(hikes, "increase"));
  if (dates) parts.push(plural(dates, "move-in date change"));
  if (termSwitches) parts.push(plural(termSwitches, "advertised lease-term switch", "advertised lease-term switches"));
  return (
    <div className="bldg-head" style={{ margin: 0 }}>
      <span className="meta">
        Since the previous scrape ({dateTime(delta.from)}), all sizes:{" "}
        {parts.length ? parts.join(" · ") : "no changes"}
      </span>
    </div>
  );
}
