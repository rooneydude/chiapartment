import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProjector } from "../../shared/src/geo";
import {
  facingFromNormal,
  normalizeRing,
  ringCentroid,
  type Vec2,
} from "../../shared/src/placement";
import {
  isBuildingFeature,
  type BuildingConfig,
  type SkylineCollection,
  type UnitMapSidecar,
  type UnitPositionEntry,
} from "../../shared/src/types";
import type { AdapterContext } from "./adapters/types";
import { fetchSightmapPayload, type SightmapPayload } from "./adapters/sightmap";
import { makeFixtureFetch } from "./fixtures";
import { httpFetch } from "./http";
import { loadConfig } from "./run";

/**
 * Convert SightMap's georeferenced floorplate map into exact per-unit
 * positions (WGS84), validated against the building's OSM footprint and
 * merged into a committed sidecar (data/unitmaps/<id>.json).
 *
 * Coverage grows run-over-run: the pricing payload only names currently
 * AVAILABLE units, so each refresh contributes whatever is joinable.
 */

// ---------------------------------------------------------------------------
// umap asset parsing
// ---------------------------------------------------------------------------

interface UmapGeoreference {
  type: "Georeference";
  latitude: number;
  longitude: number;
  zoom: number;
  bearing: number;
}

interface UmapElement {
  type: string;
  id?: string;
  uid?: string;
  shape?: { type: string; points?: string };
  elements?: UmapElement[];
  latitude?: number;
  longitude?: number;
  zoom?: number;
  bearing?: number;
}

export interface UmapAsset {
  width: number;
  height: number;
  elements: UmapElement[];
}

export interface UmapUnitShape {
  unitId: string;
  levelIndex: number;
  centroidPx: Vec2;
}

export function extractUmap(asset: UmapAsset): {
  georeference: UmapGeoreference;
  units: UmapUnitShape[];
} {
  const geo = asset.elements.find((e): e is UmapElement & UmapGeoreference => e.type === "Georeference");
  if (!geo || geo.latitude === undefined) throw new Error("umap asset has no Georeference");

  const units: UmapUnitShape[] = [];
  let levelIndex = -1;
  for (const el of asset.elements) {
    if (el.type !== "Level") continue;
    levelIndex += 1;
    const idx = levelIndex;
    (function walk(node: UmapElement): void {
      if (node.type === "Unit" && node.id && node.shape?.points) {
        const ring = node.shape.points
          .trim()
          .split(/\s+/)
          .map((pair): Vec2 => {
            const [x, y] = pair.split(",");
            return [Number.parseFloat(x!), Number.parseFloat(y!)];
          })
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (ring.length >= 3) {
          units.push({ unitId: node.id, levelIndex: idx, centroidPx: ringCentroid(ring) });
        }
      }
      for (const child of node.elements ?? []) walk(child);
    })(el);
  }
  return {
    georeference: {
      type: "Georeference",
      latitude: geo.latitude,
      longitude: geo.longitude!,
      zoom: geo.zoom!,
      bearing: geo.bearing ?? 0,
    },
    units,
  };
}

// ---------------------------------------------------------------------------
// Georeference math
// ---------------------------------------------------------------------------

/** Web-Mercator ground resolution at a latitude/zoom, meters per CSS pixel. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Transform an image-pixel point to [lon, lat], given the georeference and
 * the pixel anchor the georeference refers to.
 */
export function pixelToLonLat(
  px: Vec2,
  geo: UmapGeoreference,
  anchorPx: Vec2,
): [number, number] {
  const s = metersPerPixel(geo.latitude, geo.zoom);
  const dx = px[0] - anchorPx[0];
  const dyUp = anchorPx[1] - px[1]; // pixel y grows downward
  const b = (geo.bearing * Math.PI) / 180;
  // Screen-up points at compass bearing b: up=(sin b, cos b), right=(cos b, −sin b).
  const east = s * (dx * Math.cos(b) + dyUp * Math.sin(b));
  const north = s * (-dx * Math.sin(b) + dyUp * Math.cos(b));
  return makeProjector({ lat: geo.latitude, lon: geo.longitude }).fromLocal(east, north);
}

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

function distanceToRing(p: Vec2, ring: Vec2[]): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)));
  }
  return best;
}

export interface FitResult {
  positionsLL: Map<string, [number, number]>; // unitId → lon/lat
  metersPerPixel: number;
  scaleSource: "georeference" | "footprint-fit";
  translationCorrectionM: [number, number];
  residualM: number;
}

/**
 * Transform all unit centroids and fit them against the OSM footprint ring
 * (skyline-local meters).
 *
 * Rotation comes from the georeference bearing; translation snaps the cloud
 * centroid onto the footprint centroid (making the anchor question moot).
 * Scale is the shaky part — SightMap's `zoom` field is not always the image's
 * true georeferencing (observed 1.6× off) — so both the zoom-derived scale
 * and footprint-derived scales are tried and the best residual wins.
 */
export function fitUnitsToFootprint(
  asset: UmapAsset,
  units: UmapUnitShape[],
  geo: UmapGeoreference,
  footprintLocal: Vec2[],
  skylineOrigin: { lat: number; lon: number },
): FitResult {
  const projector = makeProjector(skylineOrigin);
  const footprint = normalizeRing(footprintLocal);
  const footCentroid = ringCentroid(footprint);

  // Pixel-cloud centroid (rotation/scale pivot).
  const cx = units.reduce((s, u) => s + u.centroidPx[0], 0) / units.length;
  const cy = units.reduce((s, u) => s + u.centroidPx[1], 0) / units.length;

  // Rotate pixel offsets into east/north at unit scale (px units).
  const b = (geo.bearing * Math.PI) / 180;
  const rotated = units.map((u) => {
    const dx = u.centroidPx[0] - cx;
    const dyUp = cy - u.centroidPx[1];
    return {
      unitId: u.unitId,
      e: dx * Math.cos(b) + dyUp * Math.sin(b),
      n: -dx * Math.sin(b) + dyUp * Math.cos(b),
    };
  });

  // Candidate scales: the georeference's claim, plus scales derived from the
  // footprint's own extents (per-axis and conservative min).
  const eExt = Math.max(...rotated.map((p) => p.e)) - Math.min(...rotated.map((p) => p.e));
  const nExt = Math.max(...rotated.map((p) => p.n)) - Math.min(...rotated.map((p) => p.n));
  const fx = footprint.map((p) => p[0]);
  const fy = footprint.map((p) => p[1]);
  const fEExt = Math.max(...fx) - Math.min(...fx);
  const fNExt = Math.max(...fy) - Math.min(...fy);
  const zoomScale = metersPerPixel(geo.latitude, geo.zoom);
  const candidates: { scale: number; source: FitResult["scaleSource"] }[] = [
    { scale: zoomScale, source: "georeference" },
  ];
  for (const s of [
    Math.min(fEExt / (eExt || 1), fNExt / (nExt || 1)),
    fNExt / (nExt || 1),
    fEExt / (eExt || 1),
  ]) {
    if (Number.isFinite(s) && s > 0) candidates.push({ scale: s, source: "footprint-fit" });
  }

  // Footprint centroid offset from the georeference point, for reporting.
  const [geoX, geoY] = projector.toLocal(geo.longitude, geo.latitude);

  let best: FitResult | null = null;
  for (const { scale, source } of candidates) {
    let residual = 0;
    const positionsLL = new Map<string, [number, number]>();
    for (const p of rotated) {
      const local: Vec2 = [footCentroid[0] + p.e * scale, footCentroid[1] + p.n * scale];
      residual = Math.max(residual, distanceToRing(local, footprint));
      positionsLL.set(p.unitId, projector.fromLocal(local[0], local[1]));
    }
    const result: FitResult = {
      positionsLL,
      metersPerPixel: Math.round(scale * 1e4) / 1e4,
      scaleSource: source,
      translationCorrectionM: [
        Math.round((footCentroid[0] - geoX) * 10) / 10,
        Math.round((footCentroid[1] - geoY) * 10) / 10,
      ],
      residualM: Math.round(residual * 10) / 10,
    };
    if (!best || result.residualM < best.residualM) best = result;
  }
  if (!best || best.residualM > 15) {
    throw new Error(
      `unitmap fit failed: best residual ${best?.residualM}m (> 15m) — georeference assumptions need review`,
    );
  }
  return best;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

async function generateForBuilding(
  root: string,
  building: BuildingConfig,
  skyline: SkylineCollection,
  fixtures: boolean,
): Promise<void> {
  const ctx: AdapterContext = {
    fetch: fixtures
      ? makeFixtureFetch(join(root, "scraper", "fixtures", building.id))
      : httpFetch,
    log: (msg) => console.log(`  [${building.id}] ${msg}`),
  };

  const payload: SightmapPayload = await fetchSightmapPayload(building, ctx);
  const assetUrl = payload.data.unit_map?.url;
  if (!assetUrl) throw new Error("payload has no unit_map.url");
  const assetRes = await ctx.fetch(assetUrl);
  if (!assetRes.ok) throw new Error(`HTTP ${assetRes.status} fetching umap asset`);
  const asset = (await assetRes.json()) as UmapAsset;

  const { georeference, units } = extractUmap(asset);
  console.log(`  ${units.length} unit shapes across levels; ${payload.data.units.length} joinable`);

  const footprint = skyline.features
    .filter(isBuildingFeature)
    .find((f) => f.properties.osmId === building.geometry.osmWayId)
    ?.geometry.coordinates[0] as Vec2[] | undefined;
  if (!footprint) {
    throw new Error(`no OSM footprint for osmWayId ${building.geometry.osmWayId} in skyline`);
  }

  const fit = fitUnitsToFootprint(asset, units, georeference, footprint, skyline.meta.origin);
  console.log(
    `  fit: scale=${fit.metersPerPixel.toFixed(4)}m/px (${fit.scaleSource}) residual=${fit.residualM}m`,
  );

  // Join unitId → unit_number (only available units are named).
  const numberById = new Map(payload.data.units.map((u) => [u.id, u.unit_number]));
  const projector = makeProjector(skyline.meta.origin);
  const footCentroid = ringCentroid(normalizeRing(footprint));

  const entries: Record<string, UnitPositionEntry> = {};
  for (const shape of units) {
    const unitNumber = numberById.get(shape.unitId);
    const ll = fit.positionsLL.get(shape.unitId);
    if (!unitNumber || !ll) continue;
    const [x, y] = projector.toLocal(ll[0], ll[1]);
    entries[unitNumber] = {
      lon: Math.round(ll[0] * 1e7) / 1e7,
      lat: Math.round(ll[1] * 1e7) / 1e7,
      facing: facingFromNormal([x - footCentroid[0], y - footCentroid[1]]),
      levelIndex: shape.levelIndex,
    };
  }

  // Merge, never overwrite: coverage accumulates across runs.
  const outPath = join(root, "data", "unitmaps", `${building.id}.json`);
  let sidecar: UnitMapSidecar = {
    schemaVersion: 1,
    buildingId: building.id,
    source: { sightmapId: payload.data.id, assetUrl, capturedAt: new Date().toISOString() },
    fit: {
      metersPerPixel: fit.metersPerPixel,
      bearingDeg: georeference.bearing,
      scaleSource: fit.scaleSource,
      translationCorrectionM: fit.translationCorrectionM,
      residualM: fit.residualM,
    },
    units: {},
  };
  if (existsSync(outPath)) {
    const prior = JSON.parse(readFileSync(outPath, "utf8")) as UnitMapSidecar;
    sidecar.units = prior.units;
  }
  Object.assign(sidecar.units, entries);

  mkdirSync(join(root, "data", "unitmaps"), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(
    `  wrote ${Object.keys(entries).length} positions this run (${Object.keys(sidecar.units).length} total) → ${outPath}`,
  );
}

export async function generateUnitmaps(
  root: string,
  opts: { fixtures: boolean; buildings: string[] | null },
): Promise<void> {
  const config = loadConfig(root);
  const skylinePath = join(root, "data", "skyline.geojson");
  if (!existsSync(skylinePath)) throw new Error("data/skyline.geojson missing — run skyline first");
  const skyline = JSON.parse(readFileSync(skylinePath, "utf8")) as SkylineCollection;

  const targets = config.buildings.filter(
    (b) =>
      b.adapter === "sightmap" &&
      (opts.buildings === null || opts.buildings.includes(b.id)),
  );
  if (targets.length === 0) {
    console.log("No sightmap-adapter buildings matched; nothing to do.");
    return;
  }
  for (const building of targets) {
    console.log(`Unit map for ${building.name}...`);
    await generateForBuilding(root, building, skyline, opts.fixtures);
  }
}
