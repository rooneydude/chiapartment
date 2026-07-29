import Link from "next/link";
import Sparkline from "@/components/Sparkline";
import { bedroomLabel, compareBuildings, listBuildings, typeHistory } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const BED_OPTIONS = [0, 1, 2, 3];

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ beds?: string }>;
}) {
  const { beds } = await searchParams;
  const bedrooms = BED_OPTIONS.includes(Number(beds)) ? Number(beds) : 1;

  const rows = compareBuildings(bedrooms);
  const histories = Object.fromEntries(
    rows.map((r) => [r.buildingSlug, typeHistory(r.buildingSlug, bedrooms, 90)]),
  );
  const hasBuildings = listBuildings().length > 0;

  const best = rows.find((r) => r.medianRent != null)?.medianRent ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-100">
          Compare by unit type
        </h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Median asking rent for the same unit type across every tracked building.
        </p>
      </header>

      <nav className="flex gap-1.5" aria-label="Unit type">
        {BED_OPTIONS.map((b) => (
          <Link
            key={b}
            href={`/compare?beds=${b}`}
            className={`rounded-md border px-3 py-1.5 text-[12px] transition-colors ${
              b === bedrooms
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200"
            }`}
          >
            {bedroomLabel(b)}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-700 bg-ink-900 px-6 py-12 text-center text-[13px] text-ink-500">
          {hasBuildings
            ? `No ${bedroomLabel(bedrooms).toLowerCase()} availability recorded yet.`
            : "Nothing tracked yet — add a building first."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-4 py-2.5 font-medium">Building</th>
                <th className="px-3 py-2.5 text-right font-medium">Median</th>
                <th className="px-3 py-2.5 text-right font-medium">From</th>
                <th className="px-3 py-2.5 text-right font-medium">$/sqft</th>
                <th className="px-3 py-2.5 text-right font-medium">Avail</th>
                <th className="px-3 py-2.5 text-right font-medium">30d</th>
                <th className="px-4 py-2.5 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-850">
              {rows.map((r) => (
                <tr key={r.buildingSlug} className="transition-colors hover:bg-ink-850">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/buildings/${r.buildingSlug}`}
                      className="text-ink-100 transition-colors hover:text-accent"
                    >
                      {r.buildingName}
                    </Link>
                    {r.medianRent != null && r.medianRent === best && (
                      <span className="ml-2 rounded bg-[var(--color-down)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-down)]">
                        lowest
                      </span>
                    )}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right font-medium text-ink-100">
                    {r.medianRent != null ? `$${r.medianRent.toLocaleString()}` : "—"}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-ink-400">
                    {r.minRent != null ? `$${r.minRent.toLocaleString()}` : "—"}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-ink-400">
                    {r.medianPpsf != null ? `$${r.medianPpsf.toFixed(2)}` : "—"}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-ink-400">
                    {r.availableCount}
                  </td>
                  <td
                    className={`tnum px-3 py-2.5 text-right ${
                      r.changeVsWindow == null || r.changeVsWindow === 0
                        ? "text-ink-500"
                        : r.changeVsWindow > 0
                          ? "text-[var(--color-up)]"
                          : "text-[var(--color-down)]"
                    }`}
                  >
                    {r.changeVsWindow == null || r.changeVsWindow === 0
                      ? "—"
                      : `${r.changeVsWindow > 0 ? "+" : "−"}$${Math.abs(r.changeVsWindow).toLocaleString()}`}
                  </td>
                  <td className="px-4 py-2">
                    <Sparkline
                      values={(histories[r.buildingSlug] ?? []).map((p) => p.medianRent)}
                      width={110}
                      ariaLabel={`${r.buildingName} ${bedroomLabel(bedrooms)} trend`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
