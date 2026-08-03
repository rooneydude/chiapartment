import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixture-backed fetch: maps requested URLs to files under
 * scraper/fixtures/<buildingId>/ via that directory's manifest.json.
 * Lets adapters run (and be tested) with zero network access.
 */

interface ManifestEntry {
  /** Substring matched against the requested URL. */
  match: string;
  file: string;
  contentType?: string;
}

export function makeFixtureFetch(fixtureDir: string): typeof fetch {
  const manifestPath = join(fixtureDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No fixture manifest at ${manifestPath}`);
  }
  const entries = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];

  return async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Longest match wins — "https://x.com/" must not shadow "https://x.com/availability".
    const entry = entries
      .filter((e) => url.includes(e.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
    if (!entry) {
      return new Response("fixture miss", { status: 404 });
    }
    const body = readFileSync(join(fixtureDir, entry.file), "utf8");
    const contentType =
      entry.contentType ?? (entry.file.endsWith(".json") ? "application/json" : "text/html");
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  };
}

/**
 * Capture recorder: persists raw payloads seen during a live scrape as
 * fixtures, so adapters can be developed offline against real data.
 */
export function makeRecorder(fixtureDir: string) {
  mkdirSync(fixtureDir, { recursive: true });
  const entries: ManifestEntry[] = [];
  let n = 0;

  return {
    record(url: string, body: string, contentType: string): void {
      const ext = contentType.includes("json") ? "json" : "html";
      const slug =
        new URL(url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) ||
        "root";
      const file = `${String(n++).padStart(2, "0")}-${slug}.${ext}`;
      writeFileSync(join(fixtureDir, file), body);
      entries.push({ match: url, file, contentType });
    },
    flush(): void {
      if (entries.length > 0) {
        writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify(entries, null, 2));
      }
    },
  };
}
