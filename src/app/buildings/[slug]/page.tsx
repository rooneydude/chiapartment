import Link from "next/link";
import { notFound } from "next/navigation";
import BuildingExplorer, { type ExplorerUnit } from "@/components/BuildingExplorer";
import TypePriceCards from "@/components/TypePriceCards";
import {
  getBuilding,
  listUnits,
  typeHistory,
  typeSummary,
} from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default async function BuildingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const building = getBuilding(slug);
  if (!building) notFound();

  const placed = listUnits(slug, { status: "available" });
  const summaries = typeSummary(slug);
  const histories = Object.fromEntries(
    summaries.map((s) => [s.bedrooms, typeHistory(slug, s.bedrooms, 90)]),
  );

  const explorerUnits: ExplorerUnit[] = placed
    .filter((p) => p.placement != null)
    .map((p) => ({
      id: p.unit.id,
      unitCode: p.unit.unitCode,
      placement: p.placement!,
      rent: p.unit.rent,
      bedrooms: p.unit.bedrooms,
      status: p.unit.status,
      availableOn: p.unit.availableOn,
      sqft: p.unit.sqft,
      planName: p.floorplanName,
      listingUrl: p.unit.listingUrl,
    }));

  const unplaceable = placed.length - explorerUnits.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-[12px] text-ink-500 transition-colors hover:text-ink-300"
          >
            ← All buildings
          </Link>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-100">
            {building.name}
          </h1>
          <p className="mt-1 text-[13px] text-ink-400">
            {[building.address, building.neighborhood].filter(Boolean).join(" · ") ||
              "Address not yet scraped"}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          {building.websiteUrl && (
            <a
              href={building.websiteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md border border-ink-700 px-2.5 py-1.5 text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-100"
            >
              Building site ↗
            </a>
          )}
          <span className="rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-ink-400">
            {explorerUnits.length} available
          </span>
        </div>
      </header>

      {summaries.length > 0 && (
        <TypePriceCards summaries={summaries} histories={histories} />
      )}

      {building.spec && building.plate && explorerUnits.length > 0 ? (
        <BuildingExplorer
          spec={building.spec}
          plate={building.plate}
          units={explorerUnits}
          notes={building.spec.provenance.notes}
          confidence={building.specConfidence}
        />
      ) : (
        <EmptyState
          slug={slug}
          hasGeometry={Boolean(building.spec && building.plate)}
          unitCount={placed.length}
        />
      )}

      {unplaceable > 0 && (
        <p className="text-[12px] text-ink-500">
          {unplaceable} available unit{unplaceable === 1 ? "" : "s"} could not be placed in
          the model — their labels carry no floor/line information.
        </p>
      )}
    </div>
  );
}

function EmptyState({
  slug,
  hasGeometry,
  unitCount,
}: {
  slug: string;
  hasGeometry: boolean;
  unitCount: number;
}) {
  return (
    <div className="rounded-xl border border-dashed border-ink-700 bg-ink-900 px-6 py-14 text-center">
      <p className="text-[15px] text-ink-200">
        {unitCount === 0 ? "No listings scraped yet." : "No 3D model yet."}
      </p>
      <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-ink-500">
        {unitCount === 0 ? (
          <>
            Run <code className="text-ink-300">npm run scrape -- {slug}</code> to pull
            current availability. The building&apos;s massing is derived from the unit
            numbers, so the model appears as soon as there are listings.
          </>
        ) : hasGeometry ? (
          <>
            Geometry exists but no available unit could be placed in it. Check that unit
            labels are in <code className="text-ink-300">&lt;floor&gt;&lt;line&gt;</code>{" "}
            form.
          </>
        ) : (
          <>
            Listings are in, but the massing hasn&apos;t been derived. Run{" "}
            <code className="text-ink-300">npm run infer -- {slug}</code>.
          </>
        )}
      </p>
    </div>
  );
}
