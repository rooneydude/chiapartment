import { useEffect, useState } from "react";
import { listingKey } from "../../../shared/src/delta";
import { omittedAsListings } from "../../../shared/src/listing";
import type {
  BuildingHistory,
  BuildingsConfig,
  SkylineCollection,
  UnitMapSidecar,
} from "../../../shared/src/types";

const BASE = import.meta.env.BASE_URL;
const cache = new Map<string, Promise<unknown>>();

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Why a fetched file cannot be used, or null when it has the expected shape. */
type ShapeCheck = (body: unknown) => string | null;

const configShape: ShapeCheck = (x) =>
  isObject(x) && Array.isArray(x["buildings"]) ? null : "it has no list of buildings";

const historyShape: ShapeCheck = (x) => {
  if (!isObject(x)) return "it is not a building record";
  if (typeof x["buildingId"] !== "string") return "it names no building";
  if (!Array.isArray(x["runs"])) return "it has no list of runs";
  if (!isObject(x["perUnit"]) || !isObject(x["perFloorplan"])) return "it has no price history";
  return null;
};

function fetchJson<T>(path: string, shape?: ShapeCheck, prepare?: (body: T) => T): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    // "no-cache": always ask the server whether its copy is newer. The data
    // changes once a day and a tab can stay open for days.
    const request: Promise<unknown> = fetch(`${BASE}data/${path}`, { cache: "no-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new Error(`${path} is not a data file`);
        }
        const problem = shape?.(body) ?? null;
        if (problem) throw new Error(`${path} cannot be read: ${problem}`);
        return prepare ? prepare(body as T) : body;
      })
      .catch((err: unknown) => {
        // A failure is never kept: the next attempt asks again.
        if (cache.get(path) === request) cache.delete(path);
        throw err;
      });
    p = request;
    cache.set(path, p);
  }
  return p as Promise<T>;
}

export const loadConfig = (): Promise<BuildingsConfig> => fetchJson("config.json", configShape);

/**
 * A snapshot taken by the scraper of before 15 Nov 2026 keeps the apartments
 * it left out of its list under `omitted`. They are listed on the site all
 * the same, so every view gets them as ordinary listings (at the rent the
 * site advertised); `omitted` stays, for the views that explain it.
 */
function listEveryUnit(h: BuildingHistory): BuildingHistory {
  if (!h.latest || !h.omitted || h.omitted.length === 0) return h;
  const listed = new Set(h.latest.units.map(listingKey));
  const leftOut = omittedAsListings(h.omitted).filter((u) => !listed.has(listingKey(u)));
  if (leftOut.length === 0) return h;
  return { ...h, latest: { ...h.latest, units: [...h.latest.units, ...leftOut] } };
}

export const loadHistory = (buildingId: string): Promise<BuildingHistory> =>
  fetchJson<BuildingHistory>(`buildings/${buildingId}.json`, historyShape, listEveryUnit);

export async function loadSkyline(): Promise<SkylineCollection | null> {
  try {
    return await fetchJson<SkylineCollection>("skyline.geojson");
  } catch {
    return null; // not generated yet — 3D falls back to boxes
  }
}

export async function loadUnitMap(buildingId: string): Promise<UnitMapSidecar | null> {
  try {
    return await fetchJson<UnitMapSidecar>(`unitmaps/${buildingId}.json`);
  } catch {
    return null; // no floorplate sidecar for this building
  }
}

// ---- a tab left open ----

/** Data in memory older than this is fetched again when the tab is looked at. */
const REFRESH_AFTER_MS = 30 * 60 * 1000;
let loadedAt = Date.now();
const listeners = new Set<() => void>();

function refreshIfOld(): void {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - loadedAt < REFRESH_AFTER_MS) return;
  loadedAt = Date.now();
  cache.clear();
  for (const notify of listeners) notify();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", refreshIfOld);
  window.addEventListener("focus", refreshIfOld);
}

/**
 * A number that goes up when the data in memory has been dropped because it
 * was old (the tab came back into view after 30 minutes or more). Pages list
 * it as an effect dependency so they load again — and keep showing what they
 * have until the fresh copy arrives, so "these prices are 3 days old" is only
 * ever said about data the server still serves.
 */
export function useDataEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const notify = () => setEpoch((n) => n + 1);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return epoch;
}
