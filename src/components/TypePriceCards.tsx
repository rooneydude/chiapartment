import Sparkline from "./Sparkline";
import type { TypePoint, TypeSummary } from "@/lib/db/queries";

/**
 * Price by unit type — the "what does a 2-bed cost here, and which way is it
 * moving" row. One card per bedroom count, each carrying the current median,
 * the spread, and the trend over the tracking window.
 */
export default function TypePriceCards({
  summaries,
  histories,
}: {
  summaries: TypeSummary[];
  histories: Record<number, TypePoint[]>;
}) {
  return (
    <section aria-label="Price by unit type">
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {summaries.map((s) => {
          const history = histories[s.bedrooms] ?? [];
          const series = history.map((p) => p.medianRent);
          const change = s.changeVsWindow;

          return (
            <article
              key={s.bedrooms}
              className="rounded-xl border border-ink-800 bg-ink-900 p-3.5"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-[13px] font-medium text-ink-200">{s.label}</h3>
                <span className="tnum text-[11px] text-ink-500">
                  {s.availableCount} avail
                </span>
              </div>

              <div className="mt-2 flex items-end justify-between gap-2">
                <div>
                  <div className="tnum text-xl font-semibold tracking-tight text-ink-100">
                    {s.medianRent != null ? `$${s.medianRent.toLocaleString()}` : "—"}
                  </div>
                  <div className="tnum mt-0.5 text-[11px] text-ink-500">
                    {s.minRent != null && `from $${s.minRent.toLocaleString()}`}
                    {s.medianPpsf != null && ` · $${s.medianPpsf.toFixed(2)}/sf`}
                  </div>
                </div>
                <Sparkline
                  values={series}
                  ariaLabel={`${s.label} median rent over the last ${s.windowDays} days`}
                />
              </div>

              <div className="mt-2.5 border-t border-ink-850 pt-2 text-[11px]">
                {change == null || change === 0 ? (
                  <span className="text-ink-500">
                    {series.length < 2
                      ? "Not enough history yet"
                      : `Flat over ${s.windowDays}d`}
                  </span>
                ) : (
                  <span
                    className={change > 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]"}
                  >
                    {change > 0 ? "▲" : "▼"} ${Math.abs(change).toLocaleString()}{" "}
                    <span className="text-ink-500">over {s.windowDays}d</span>
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
