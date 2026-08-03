import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProjector, type LonLat, type Projector } from "../../shared/src/geo";
import type {
  BuildingConfig,
  SkylineCollection,
  SkylineFeature,
} from "../../shared/src/types";
import { loadConfig } from "./run";

/**
 * Fetch OSM building footprints + heights around the tracked buildings via
 * Overpass and compile them into data/skyline.geojson — coordinates in LOCAL
 * METERS around the tracked-building centroid (internal format; the frontend
 * uses it directly, projection-free).
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
/** Overpass policy: identify honestly, don't imitate a browser (406 otherwise). */
const OVERPASS_HEADERS = {
  "User-Agent": "chiapartment-skyline/0.1 (+https://github.com/rooneydude/chiapartment)",
  Accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
};
const OVERPASS_TIMEOUT_MS = 180_000;
const METERS_PER_LEVEL = 3.2;
const DEFAULT_HEIGHT_M = 10;
const SIMPLIFY_TOLERANCE_M = 0.75;
/** Buildings within this distance of each other share one Overpass bbox. */
const CLUSTER_SPAN_M = 1600;

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

interface OverpassElement {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { role: string; geometry?: { lat: number; lon: number }[] }[];
}

async function overpassQuery(bbox: [number, number, number, number], cacheDir: string) {
  const [s, w, n, e] = bbox;
  const query = `[out:json][timeout:120];
(
  way["building"](${s},${w},${n},${e});
  relation["building"](${s},${w},${n},${e});
);
out tags geom;`;

  const cacheFile = join(cacheDir, `overpass-${createHash("sha1").update(query).digest("hex").slice(0, 12)}.json`);
  if (existsSync(cacheFile)) {
    console.log(`  using cached Overpass response for bbox ${bbox.map((v) => v.toFixed(4)).join(",")}`);
    return JSON.parse(readFileSync(cacheFile, "utf8")) as { elements: OverpassElement[] };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        console.log(`  querying ${endpoint} ...`);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: OVERPASS_HEADERS,
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { elements: OverpassElement[] };
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(data));
        return data;
      } catch (err) {
        lastErr = err;
        console.warn(`  ${endpoint} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (attempt === 0) {
      console.log("  all endpoints failed; waiting 15s before one more pass");
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  throw new Error(`All Overpass endpoints failed: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

// ---------------------------------------------------------------------------
// Tag parsing
// ---------------------------------------------------------------------------

function parseLengthM(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/([\d.]+)\s*(ft|')?/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * 0.3048 : n;
}

function resolveHeights(tags: Record<string, string>): {
  height: number;
  minHeight: number;
  levels?: number;
} {
  const levels = tags["building:levels"] ? Number.parseFloat(tags["building:levels"]) : undefined;
  const height =
    parseLengthM(tags["height"]) ??
    (levels && Number.isFinite(levels) ? levels * METERS_PER_LEVEL + 1 : DEFAULT_HEIGHT_M);
  const minLevel = tags["building:min_level"] ? Number.parseFloat(tags["building:min_level"]) : undefined;
  const minHeight =
    parseLengthM(tags["min_height"]) ??
    (minLevel && Number.isFinite(minLevel) ? minLevel * METERS_PER_LEVEL : 0);
  return {
    height,
    minHeight,
    ...(levels !== undefined && Number.isFinite(levels) ? { levels } : {}),
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Pt = [number, number];

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 3) return points;
  let maxDist = 0;
  let index = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= tolerance) return [first, last];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  const closed = [...ring, ring[0]!];
  const simplified = douglasPeucker(closed, tolerance).slice(0, -1);
  return simplified.length >= 3 ? simplified : ring;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
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

function ringCentroidLL(ring: { lat: number; lon: number }[]): LonLat {
  let lat = 0;
  let lon = 0;
  for (const p of ring) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function clusterBuildings(buildings: BuildingConfig[], projector: Projector): BuildingConfig[][] {
  const clusters: BuildingConfig[][] = [];
  for (const b of buildings) {
    const [bx, by] = projector.toLocal(b.lon, b.lat);
    const cluster = clusters.find((c) =>
      c.some((other) => {
        const [ox, oy] = projector.toLocal(other.lon, other.lat);
        return Math.hypot(bx - ox, by - oy) < CLUSTER_SPAN_M;
      }),
    );
    if (cluster) cluster.push(b);
    else clusters.push([b]);
  }
  return clusters;
}

export async function generateSkyline(root: string): Promise<void> {
  const config = loadConfig(root);
  const { buildings, skyline: opts } = config;

  const origin: LonLat = {
    lat: buildings.reduce((s, b) => s + b.lat, 0) / buildings.length,
    lon: buildings.reduce((s, b) => s + b.lon, 0) / buildings.length,
  };
  const projector = makeProjector(origin);
  const cacheDir = join(root, "node_modules", ".cache", "chiapartment");

  // One bbox per building cluster, buffered by clusterRadiusM.
  const clusters = clusterBuildings(buildings, projector);
  const bboxes: [number, number, number, number][] = clusters.map((cluster) => {
    const dLat = opts.clusterRadiusM / 110540;
    const lats = cluster.map((b) => b.lat);
    const lons = cluster.map((b) => b.lon);
    const dLon = opts.clusterRadiusM / (111320 * Math.cos((origin.lat * Math.PI) / 180));
    return [
      Math.min(...lats) - dLat,
      Math.min(...lons) - dLon,
      Math.max(...lats) + dLat,
      Math.max(...lons) + dLon,
    ];
  });

  const trackedLocal = buildings.map((b) => ({
    building: b,
    xy: projector.toLocal(b.lon, b.lat) as Pt,
  }));
  const matchedTracked = new Set<string>();
  const features: SkylineFeature[] = [];
  const seenOsmIds = new Set<number>();

  for (const bbox of bboxes) {
    console.log(`Fetching OSM buildings for bbox ${bbox.map((v) => v.toFixed(4)).join(", ")}`);
    const data = await overpassQuery(bbox, cacheDir);
    console.log(`  ${data.elements.length} elements`);

    for (const el of data.elements) {
      const rings: { lat: number; lon: number }[][] = [];
      if (el.type === "way" && el.geometry && el.geometry.length >= 4) {
        rings.push(el.geometry);
      } else if (el.type === "relation" && el.members) {
        for (const m of el.members) {
          if (m.role === "outer" && m.geometry && m.geometry.length >= 4) rings.push(m.geometry);
        }
      }
      if (rings.length === 0 || seenOsmIds.has(el.id)) continue;
      seenOsmIds.add(el.id);

      const { height, minHeight, levels } = resolveHeights(el.tags ?? {});

      for (const rawRing of rings) {
        const centroid = ringCentroidLL(rawRing);
        const [cx, cy] = projector.toLocal(centroid.lon, centroid.lat);

        // Tracked-building matching: explicit osmWayId, else contains lat/lon.
        let trackedId: string | undefined;
        const localRing: Pt[] = rawRing
          .slice(0, -1)
          .map((p) => projector.toLocal(p.lon, p.lat) as Pt);
        for (const t of trackedLocal) {
          if (
            t.building.geometry.osmWayId === el.id ||
            (t.building.geometry.osmWayId === undefined && pointInRing(t.xy, localRing))
          ) {
            trackedId = t.building.id;
            matchedTracked.add(t.building.id);
            if (t.building.geometry.osmWayId === undefined) {
              console.log(
                `  auto-matched ${t.building.id} → OSM ${el.type} ${el.id} (add "osmWayId": ${el.id} to buildings.json to pin it)`,
              );
            }
            break;
          }
        }

        // Distance-tiered height filter (tracked buildings always kept).
        if (!trackedId) {
          const nearest = Math.min(
            ...trackedLocal.map((t) => Math.hypot(cx - t.xy[0], cy - t.xy[1])),
          );
          const minH = nearest <= opts.nearRadiusM ? opts.minHeightNearM : opts.minHeightFarM;
          if (height < minH) continue;
        }

        const simplified = simplifyRing(localRing, SIMPLIFY_TOLERANCE_M).map(
          (p): Pt => [round1(p[0]), round1(p[1])],
        );
        if (simplified.length < 3) continue;

        features.push({
          type: "Feature",
          properties: {
            osmId: el.id,
            height: round1(height),
            minHeight: round1(minHeight),
            ...(levels !== undefined ? { levels } : {}),
            ...(el.tags?.["name"] ? { name: el.tags["name"] } : {}),
            ...(trackedId ? { trackedId } : {}),
          },
          geometry: { type: "Polygon", coordinates: [simplified] },
        });
      }
    }
  }

  for (const b of buildings) {
    if (!matchedTracked.has(b.id)) {
      console.warn(
        `WARNING: no OSM footprint matched tracked building "${b.id}"${
          b.geometry.osmWayId ? ` (osmWayId ${b.geometry.osmWayId} not found)` : ""
        } — the 3D scene will use a fallback box`,
      );
    }
  }

  const collection: SkylineCollection = {
    type: "FeatureCollection",
    meta: { origin, generated: new Date().toISOString(), bboxes },
    features,
  };
  const outPath = join(root, "data", "skyline.geojson");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(collection));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(collection)) / 1024);
  console.log(`\nWrote ${features.length} footprints (${kb} kB) → ${outPath}`);
}
