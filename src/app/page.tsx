import Link from "next/link";
import {
  bedroomLabel,
  listBuildings,
  listUnits,
  recentPriceChanges,
  typeHistory,
  typeSummary,
} from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const buildings = listBuildings();

  const rows = buildings.map((b) => {
    const units = listUnits(b.slug, { status: "available" });
    const summaries = typeSummary(b.slug);
    const rents = units
      .map((u) => u.unit.rent)
      .filter((r): r is number => r != null)
      .sort((a, b) => a - b);
    return {
      building: b,
      available: units.length,
      placed: units.filter((u) => u.placement != null).length,
      cheapest: rents[0] ?? null,
      summaries,
    };
  });

  const changes = recentPriceChanges(12);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-100">
            Chicago buildings
          </h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Live availability, price history, and every unit placed in its building.
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-500">
          {rows.reduce((a, r) => a + r.available, 0)} units tracked across{" "}
          {rows.length} building{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      {rows.length === 0 ? (
        <GettingStarted />
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ building, available, placed, cheapest, summaries }) => (
            <Link
              key={building.slug}
              href={`/buildings/${building.slug}`}
              className="group rounded-xl border border-ink-800 bg-ink-900 p-4 transition-colors hover:border-ink-600"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold tracking-tight text-ink-100 group-hover:text-accent">
                    {building.name}
                  </h2>
                  <p className="mt-0.5 truncate text-[12px] text-ink-500">
                    {building.neighborhood ?? building.address ?? "—"}
                  </p>
                </div>
                <span className="tnum shrink-0 rounded-md bg-ink-850 px-2 py-1 text-[11px] text-ink-400">
                  {available}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500">
                <span className="tnum">
                  {cheapest != null ? `from $${cheapest.toLocaleString()}` : "no pricing"}
                </span>
                <span>
                  {placed === available
                    ? "all units placed"
                    : `${placed}/${available} placed in 3D`}
                </span>
              </div>

              {summaries.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-ink-850 pt-3">
                  {summaries.map((s) => (
                    <span
                      key={s.bedrooms}
                      className="tnum rounded-md border border-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400"
                    >
                      {s.label}{" "}
                      <span className="text-ink-200">
                        {s.medianRent != null ? `$${s.medianRent.toLocaleString()}` : "—"}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </section>
      )}

      {changes.length > 0 && (
        <section>
          <h2 className="mb-2.5 text-[13px] font-medium uppercase tracking-wider text-ink-500">
            Recent price moves
          </h2>
          <ul className="divide-y divide-ink-850 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
            {changes.map((c) => (
              <li
                key={`${c.unitId}-${c.observedAt}`}
                className="flex items-center gap-3 px-4 py-2.5 text-[13px]"
              >
                <Link
                  href={`/buildings/${c.buildingSlug}`}
                  className="min-w-0 flex-1 truncate text-ink-300 transition-colors hover:text-accent"
                >
                  <span className="tnum font-medium text-ink-100">{c.unitCode}</span>
                  <span className="ml-2 text-ink-500">{c.buildingName}</span>
                </Link>
                <span className="text-[11px] text-ink-500">
                  {c.bedrooms != null ? bedroomLabel(c.bedrooms) : ""}
                </span>
                <span className="tnum w-24 text-right text-ink-400">
                  ${c.previousRent.toLocaleString()} →
                </span>
                <span
                  className={`tnum w-28 text-right font-medium ${
                    c.delta > 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]"
                  }`}
                >
                  ${c.rent.toLocaleString()}{" "}
                  <span className="text-[11px]">
                    ({c.delta > 0 ? "+" : ""}
                    {c.delta})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GettingStarted() {
  return (
    <div className="rounded-xl border border-dashed border-ink-700 bg-ink-900 px-6 py-14">
      <div className="mx-auto max-w-xl text-center">
        <p className="text-[15px] text-ink-200">No buildings tracked yet.</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          Register a building by pointing the scraper at its website. The platform is
          detected automatically, robots.txt is checked before anything is fetched, and
          the 3D massing is derived from the unit numbers in the listings.
        </p>
        <pre className="mt-5 overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 px-4 py-3 text-left text-[12px] leading-relaxed text-ink-300">
{`npm run scrape -- --add https://fulbrix.com/
npm run scrape -- --all
npm run seed:demo    # or load a synthetic building to look around`}
        </pre>
      </div>
    </div>
  );
}
