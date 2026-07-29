#!/usr/bin/env tsx
/**
 * chiapartment scraper CLI.
 *
 *   npm run scrape -- --add https://fulbrix.com/     # probe + register a building
 *   npm run scrape -- --all                          # run every enabled source
 *   npm run scrape -- fulbrix                        # run one source
 *   npm run scrape -- fulbrix --dry-run              # parse, print, write nothing
 *   npm run scrape -- --list                         # show registered sources
 */
import * as cheerio from "cheerio";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/lib/db";
import { checkRobots, createFetcher, RobotsDisallowedError } from "../src/lib/scrape/http";
import { detectPlatform, PLATFORMS } from "../src/lib/scrape/fingerprint";
import { detectAdapter } from "../src/lib/scrape/registry";
import { fetchAndParse, runSource } from "../src/lib/scrape/runner";
import { inferForBuilding } from "../src/lib/massing/persist";

interface Args {
  add?: string;
  all: boolean;
  list: boolean;
  slug?: string;
  adapter?: string;
  dryRun: boolean;
  skipImages: boolean;
  cacheSec: number;
  quiet: boolean;
  noInfer: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    list: false,
    dryRun: false,
    skipImages: false,
    cacheSec: 0,
    quiet: false,
    noInfer: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") args.add = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--list") args.list = true;
    else if (a === "--adapter") args.adapter = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-images") args.skipImages = true;
    else if (a === "--no-infer") args.noInfer = true;
    else if (a === "--cache") args.cacheSec = Number(argv[++i] ?? 3600);
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (!a.startsWith("-")) args.slug = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const log = args.quiet ? () => {} : (m: string) => console.log(`  ${dim(m)}`);

main().catch((err) => {
  console.error(`\n${red("✖")} ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof RobotsDisallowedError) {
    console.error(
      dim("  robots.txt forbids this path. Do not work around it — contact the operator instead."),
    );
  }
  process.exit(1);
});

async function main() {
  if (args.list) return listSources();
  if (args.add) return addSource(args.add);
  if (args.all) return runAll();
  if (args.slug) return runOne(args.slug);

  console.log(
    [
      "Usage:",
      "  npm run scrape -- --add <url>        register a building and probe it",
      "  npm run scrape -- --all              run every enabled source",
      "  npm run scrape -- <source-slug>      run one source",
      "  npm run scrape -- --list             list registered sources",
      "",
      "Flags:",
      "  --adapter <id>   force an adapter instead of detecting one",
      "  --dry-run        parse and print, write nothing",
      "  --no-images      skip downloading floor plan images",
      "  --no-infer       skip re-deriving the 3D massing after the run",
      "  --cache <sec>    reuse cached pages younger than <sec>",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// --add
// ---------------------------------------------------------------------------

async function addSource(rawUrl: string) {
  const url = normalizeUrl(rawUrl);
  const slug = slugFromUrl(url);
  console.log(`\n${bold("Probing")} ${url}`);

  const robots = await checkRobots(url);
  if (!robots.allowed) {
    console.error(
      `${red("✖")} robots.txt disallows this URL. Not registering it.\n` +
        dim("  If you have permission from the operator, add an explicit Allow rule or use their API."),
    );
    process.exit(1);
  }
  console.log(
    `${green("✔")} robots.txt allows it` +
      (robots.crawlDelay ? dim(` (crawl-delay ${robots.crawlDelay}s)`) : ""),
  );

  const fetcher = createFetcher({
    crawlDelaySec: Math.max(2, robots.crawlDelay ?? 0),
    cacheMaxAgeSec: args.cacheSec,
    onLog: log,
  });
  const html = await fetcher.getText(url);

  const platform = detectPlatform(html, url);
  const detection = detectAdapter(html, url);
  console.log(
    `${green("✔")} platform: ${bold(platform?.label ?? "unrecognised")}` +
      (platform ? dim(`\n  ${platform.hint}`) : ""),
  );
  console.log(
    `${green("✔")} adapter:  ${bold(detection.adapter.id)} ${dim(`(${detection.score})`)}\n` +
      dim(`  scores → ${detection.ranked.map((r) => `${r.id}:${r.score}`).join("  ")}`),
  );

  const $ = cheerio.load(html);
  const name =
    $("title").first().text().split(/\s*[|–—-]\s*/)[0].trim() || slug;

  // Do a real parse so --add tells you whether this site will actually work.
  console.log(`\n${bold("Test parse")}`);
  const result = await fetchAndParse(url, fetcher, {
    adapterId: args.adapter ?? detection.adapter.id,
    log,
  });
  reportParse(result.units.length, result.plans.length, result.warnings);

  const db = getDb();
  db.insert(schema.buildings)
    .values({ slug, name, websiteUrl: url, platform: platform?.id ?? null })
    .onConflictDoUpdate({
      target: schema.buildings.slug,
      set: { websiteUrl: url, platform: platform?.id ?? null },
    })
    .run();

  db.insert(schema.sources)
    .values({
      slug,
      buildingSlug: slug,
      url,
      platform: platform?.id ?? null,
      adapter: args.adapter ?? detection.adapter.id,
      robotsAllowed: true,
      robotsCheckedAt: Math.floor(Date.now() / 1000),
      crawlDelaySec: Math.max(2, robots.crawlDelay ?? 0),
      notes: platform?.hint ?? null,
    })
    .onConflictDoUpdate({
      target: schema.sources.slug,
      set: {
        url,
        platform: platform?.id ?? null,
        adapter: args.adapter ?? detection.adapter.id,
        robotsAllowed: true,
        robotsCheckedAt: Math.floor(Date.now() / 1000),
      },
    })
    .run();

  console.log(
    `\n${green("✔")} registered source ${bold(slug)}\n` +
      dim(`  run it with:  npm run scrape -- ${slug}`),
  );
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async function runAll() {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.enabled, true))
    .all();

  if (rows.length === 0) {
    console.log("No sources registered. Add one with: npm run scrape -- --add <url>");
    return;
  }
  for (const row of rows) {
    await runOne(row.slug);
  }
}

async function runOne(slug: string) {
  const db = getDb();
  const source = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.slug, slug))
    .get();
  if (!source) {
    throw new Error(`No source named "${slug}". Run --list to see what's registered.`);
  }

  console.log(`\n${bold(source.slug)} ${dim(source.url)}`);
  const summary = await runSource(source, {
    adapterId: args.adapter,
    cacheMaxAgeSec: args.cacheSec,
    dryRun: args.dryRun,
    skipImages: args.skipImages,
    log,
  });

  reportParse(summary.unitsFound, summary.plansFound, summary.warnings);
  if (!args.dryRun) {
    console.log(
      `  ${summary.unitsChanged} price change(s), ${summary.unitsDelisted} delisted, ` +
        `${summary.imagesDownloaded} floor plan image(s)`,
    );
  }

  if (!args.dryRun && !args.noInfer && summary.unitsFound > 0) {
    try {
      const inferred = inferForBuilding(source.buildingSlug);
      console.log(
        `  ${green("✔")} massing derived: ${inferred.spec.topFloor} floors, ` +
          `${inferred.plate.stacks.length} lines ${dim(`(${inferred.confidence})`)}`,
      );
      for (const note of inferred.notes) console.log(dim(`     · ${note}`));
    } catch (err) {
      console.log(`  ${yellow("!")} massing not derived: ${(err as Error).message}`);
    }
  }
}

function reportParse(units: number, plans: number, warnings: string[]) {
  const mark = units > 0 ? green("✔") : yellow("!");
  console.log(`  ${mark} ${units} unit(s), ${plans} floor plan(s)`);
  for (const w of warnings) console.log(`  ${yellow("!")} ${w}`);
}

function listSources() {
  const db = getDb();
  const rows = db.select().from(schema.sources).all();
  if (rows.length === 0) {
    console.log("No sources registered.");
    return;
  }
  for (const r of rows) {
    const platform = PLATFORMS.find((p) => p.id === r.platform)?.label ?? r.platform ?? "?";
    console.log(
      `${r.enabled ? green("●") : dim("○")} ${bold(r.slug.padEnd(18))} ` +
        `${dim(platform.padEnd(22))} ${dim(r.adapter ?? "")}  ${dim(r.url)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(withScheme).toString();
}

/** `https://1225oldtown.com/` → `1225oldtown` */
function slugFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host.replace(/\.(com|net|org|co|io|us)$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");
