import type {
  BuildingHistory,
  BuildingsConfig,
  SkylineCollection,
  UnitMapSidecar,
} from "../../../shared/src/types";

const BASE = import.meta.env.BASE_URL;
const cache = new Map<string, Promise<unknown>>();

function fetchJson<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`${BASE}data/${path}`).then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
      return res.json();
    });
    cache.set(path, p);
  }
  return p as Promise<T>;
}

export const loadConfig = (): Promise<BuildingsConfig> => fetchJson("config.json");

export const loadHistory = (buildingId: string): Promise<BuildingHistory> =>
  fetchJson(`buildings/${buildingId}.json`);

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
