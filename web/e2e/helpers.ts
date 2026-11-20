import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildData } from "../../scraper/src/build-data";
import {
  SnapshotSchema,
  type AlsoListed,
  type BuildingHistory,
  type CompiledConfig,
  type OmittedListing,
  type UnitListing,
} from "../../shared/src/types";

/**
 * Plumbing for the dashboard's browser tests.
 *
 * A test describes a few days of scraping in plain objects; `compileWorld`
 * writes them as snapshots and runs the REAL compiler over them, so the
 * browser is given exactly what the live site would be given for that
 * history — never a hand-written copy of the compiled format that could
 * drift from it. The built site (`web/dist`) is served as-is; only its data
 * requests are answered from the compiled world.
 */

export const REPO = join(__dirname, "..", "..");
const DIST = join(REPO, "web", "dist");

/** The script files of the built site, with their sizes. */
export const builtScripts = (): { name: string; bytes: number }[] =>
  readdirSync(join(DIST, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, bytes: statSync(join(DIST, "assets", name)).size }));
const BASE = "/chiapartment/";

/** Three evenings, as the scheduled job records them. */
export const DAY1 = "2026-11-17T22:27:39Z";
export const DAY2 = "2026-11-18T22:00:13Z";
export const DAY3 = "2026-11-19T22:11:27Z";
/** Chicago calendar day of DAY3 — "available now" on that run means this day. */
export const TODAY = "2026-11-19";
/** The moment the browser believes it is: a few hours after the last run. */
export const NOW = "2026-11-20T02:00:00Z";

// ---------------------------------------------------------------- the data

export interface BuildingDay {
  units?: UnitListing[];
  alsoListed?: AlsoListed[];
  /** Set for a run of the previous scraper: the units it left out of its list. */
  omitted?: OmittedListing[];
  notices?: string[];
  gaps?: string[];
  /** A scrape that failed. With `blocked`, the site's bot protection refused it. */
  error?: string;
  blocked?: boolean;
}
/** One run: building id → what it recorded. A building left out was not scraped by that run. */
export type Run = Record<string, BuildingDay>;

export function unit(
  unitNumber: string | null,
  beds: number,
  price: number,
  extra: Partial<UnitListing> = {},
): UnitListing {
  return {
    unitNumber,
    floorplanName: unitNumber === null ? "Plan" : `P${beds}`,
    beds,
    baths: 1,
    sqft: 500 + beds * 300,
    price,
    availableDate: null,
    ...extra,
  };
}
/** A unit the site says can be moved into on the day of the run. */
export const nowUnit = (day: string, ...args: Parameters<typeof unit>): UnitListing => ({
  ...unit(...args),
  availableDate: day,
  availableNow: true,
});

const worlds: string[] = [];
export function removeWorlds(): void {
  for (const root of worlds.splice(0)) rmSync(root, { recursive: true, force: true });
}

const SOURCE = { adapter: "test", fetchedUrl: "https://example.com/" };

/** Write the runs as snapshots, compile them with the real compiler, return the compiled data folder. */
export function compileWorld(name: string, runs: [timestamp: string, run: Run][]): string {
  const root = mkdtempSync(join(tmpdir(), `chiapartment-e2e-${name}-`));
  worlds.push(root);
  copyFileSync(join(REPO, "buildings.json"), join(root, "buildings.json"));
  mkdirSync(join(root, "data", "snapshots"), { recursive: true });
  // The 3D view's surroundings and 1225's unit positions, as committed.
  const skyline = join(REPO, "data", "skyline.geojson");
  if (existsSync(skyline)) copyFileSync(skyline, join(root, "data", "skyline.geojson"));
  const unitmaps = join(REPO, "data", "unitmaps");
  if (existsSync(unitmaps)) {
    mkdirSync(join(root, "data", "unitmaps"), { recursive: true });
    for (const f of readdirSync(unitmaps)) copyFileSync(join(unitmaps, f), join(root, "data", "unitmaps", f));
  }
  for (const [timestamp, run] of runs) {
    // Parsed before it is written: a snapshot the compiler would skip as
    // invalid must fail the test here, not quietly produce an empty page.
    const snapshot = SnapshotSchema.parse({
      schemaVersion: 1,
      timestamp,
      buildings: Object.entries(run).map(([buildingId, d]) =>
        d.error !== undefined
          ? { buildingId, status: "error", error: d.error, ...(d.blocked ? { blocked: true } : {}), source: SOURCE, units: [] }
          : {
              buildingId,
              status: "ok",
              source: SOURCE,
              units: d.units ?? [],
              // the previous scraper wrote `omitted` and never `alsoListed`
              ...(d.omitted ? { omitted: d.omitted } : { alsoListed: d.alsoListed ?? [] }),
              ...(d.notices ? { notices: d.notices } : {}),
              ...(d.gaps ? { gaps: d.gaps } : {}),
            },
      ),
    });
    writeFileSync(join(root, "data", "snapshots", `${timestamp.replaceAll(":", "-")}.json`), JSON.stringify(snapshot));
  }
  buildData(root);
  return join(root, "web", "public", "data");
}

export const compiledHistory = (dataDir: string, buildingId: string): BuildingHistory =>
  JSON.parse(readFileSync(join(dataDir, "buildings", `${buildingId}.json`), "utf8")) as BuildingHistory;
export const compiledConfig = (dataDir: string): CompiledConfig =>
  JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as CompiledConfig;

// ---------------------------------------------------------------- the site

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve the built site the way GitHub Pages does: under /chiapartment/. */
export async function serveDist(): Promise<{ origin: string; close: () => Promise<void> }> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("web/dist is missing — run `npm run build` before `npm run test:browser`.");
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const rel = path.startsWith(BASE) ? decodeURIComponent(path.slice(BASE.length)) || "index.html" : null;
    const file = rel === null ? null : normalize(join(DIST, rel));
    if (file === null || !file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------- the browser

const WEBGL_ON = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
/** A device where WebGL cannot start: what a locked-down or GPU-less browser does. */
const WEBGL_OFF = ["--disable-gpu", "--disable-3d-apis"];

/**
 * `CHROMIUM_PATH` points at a browser that is already installed, for machines
 * where Playwright's own download is not the one in use. Unset (as in CI,
 * after `npx playwright install chromium`), Playwright finds its own.
 */
export function launch(webgl: boolean): Promise<Browser> {
  const executablePath = process.env["CHROMIUM_PATH"];
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), args: webgl ? WEBGL_ON : WEBGL_OFF });
}

export interface Opened {
  page: Page;
  context: BrowserContext;
  /** Uncaught errors on the page. */
  errors: string[];
  /**
   * What the page wrote to the console as an error — where a 3D library
   * reports a shader that did not compile. Not counted: the browser's own
   * line about a missing skyline or unit-map file. Both files are optional
   * and the page is built to do without them (web/src/lib/data.ts).
   */
  consoleErrors: string[];
  /** Paths of everything the page requested. */
  requested: string[];
  /** Answer one data file differently from now on (null = back to the compiled world). */
  override: (file: string, answer: { status: number; body: string } | null) => void;
}

export async function openApp(
  browser: Browser,
  origin: string,
  dataDir: string,
  opts: {
    route?: string;
    width?: number;
    height?: number;
    /** Data files answered differently from the first request on. */
    overrides?: Record<string, { status: number; body: string }>;
  } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 1000 },
    timezoneId: "America/Chicago",
    locale: "en-US",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/\/data\/(skyline\.geojson|unitmaps\/[^/]+\.json)$/.test(m.location().url)) return;
    consoleErrors.push(m.text());
  });
  const requested: string[] = [];
  page.on("request", (r) => requested.push(new URL(r.url()).pathname));
  const overrides = new Map<string, { status: number; body: string }>(Object.entries(opts.overrides ?? {}));
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/chiapartment/data/**", (route) => {
    const rel = new URL(route.request().url()).pathname.split("/data/")[1] ?? "";
    const forced = overrides.get(rel);
    if (forced) return route.fulfill({ status: forced.status, contentType: "application/json", body: forced.body });
    const file = join(dataDir, rel);
    if (!existsSync(file)) return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    return route.fulfill({ status: 200, contentType: "application/json", body: readFileSync(file) });
  });
  await page.goto(`${origin}${BASE}#${opts.route ?? "/"}`, { waitUntil: "networkidle" });
  return {
    page,
    context,
    errors,
    consoleErrors,
    requested,
    override: (file, answer) => {
      if (answer === null) overrides.delete(file);
      else overrides.set(file, answer);
    },
  };
}

/** Everything the matching elements say, as one line. */
export async function say(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).allInnerTexts()).join(" | ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- the 3D picture

/** Everything in the 3D panel that lies over the picture: legend, compass, controls, labels. */
const OVER_THE_PICTURE = ".scene-wrap > :not(:first-child) { visibility: hidden !important; }";

/** The 3D picture as the browser shows it, without what lies over it. A PNG, base64. */
export const scenePicture = async (page: Page): Promise<string> =>
  (await page.locator(".scene-wrap").screenshot({ style: OVER_THE_PICTURE })).toString("base64");

/** The same, once it has stopped changing (a camera move or a relight takes a few frames). */
export async function scenePictureAtRest(page: Page): Promise<string> {
  let last = await scenePicture(page);
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(150);
    const next = await scenePicture(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error("The 3D picture never came to rest.");
}

/**
 * Two pictures of the same size, compared in the browser (which can read a
 * PNG; this project has no library that does): how many pixels differ by
 * more than a rendering wobble, and how bright each picture is on average
 * (0 black – 255 white).
 */
export function comparePictures(page: Page, a: string, b: string): Promise<{ changed: number; brightnessA: number; brightnessB: number }> {
  return page.evaluate(
    async ([first, second]) => {
      const pixels = async (png: string): Promise<Uint8ClampedArray> => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [p, q] = [await pixels(first!), await pixels(second!)];
      if (p.length !== q.length) throw new Error("The two pictures are not the same size.");
      const luminance = (d: Uint8ClampedArray, i: number): number => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      let changed = 0;
      let sumA = 0;
      let sumB = 0;
      for (let i = 0; i < p.length; i += 4) {
        sumA += luminance(p, i);
        sumB += luminance(q, i);
        if (Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!)) > 16) changed++;
      }
      const count = p.length / 4;
      return { changed, brightnessA: sumA / count, brightnessB: sumB / count };
    },
    [a, b],
  );
}

/** Move a slider to a value the way a person's drag ends up: the control's own setter, then the event React listens for. */
export async function setSlider(page: Page, selector: string, value: number): Promise<void> {
  await page.locator(selector).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** How far the page is wider than the screen (0 = it fits). */
export const overflowX = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
