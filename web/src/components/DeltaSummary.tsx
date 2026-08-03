import type { SnapshotDelta } from "../../../shared/src/types";
import { longDate } from "../lib/format";

export default function DeltaSummary({ delta }: { delta: SnapshotDelta | null }) {
  if (!delta || !delta.from) return null;
  const drops = delta.priceChanges.filter((c) => c.to < c.from).length;
  const hikes = delta.priceChanges.length - drops;
  const parts: string[] = [];
  if (delta.newUnits.length) parts.push(`${delta.newUnits.length} new`);
  if (delta.removedUnits.length) parts.push(`${delta.removedUnits.length} removed`);
  if (drops) parts.push(`${drops} price drop${drops > 1 ? "s" : ""}`);
  if (hikes) parts.push(`${hikes} increase${hikes > 1 ? "s" : ""}`);
  return (
    <div className="bldg-head" style={{ margin: 0 }}>
      <span className="meta">
        Since {longDate(delta.from)}: {parts.length ? parts.join(" · ") : "no changes"}
      </span>
    </div>
  );
}
