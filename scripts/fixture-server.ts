#!/usr/bin/env tsx
/**
 * Run the stand-in leasing site by hand, for exercising the scraper CLI.
 *
 *   npm run fixture -- --port 4310 --round 1
 *   npm run scrape  -- --add http://127.0.0.1:4310/
 *   npm run scrape  -- 127-0-0-1
 *
 * Restart with `--round 2` and scrape again to watch the refresh path: prices
 * move, some units lease, and the price history and type rollups both grow.
 * The same site backs tests/workflow.test.ts.
 */
import { startFixtureSite } from "../src/lib/testing/fixture-site";

const argv = process.argv.slice(2);
const at = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const port = Number(at("--port") ?? 4310);
const round = Number(at("--round") ?? 1);

const site = await startFixtureSite({ port, round });
console.log(`fixture site on ${site.url} (round ${round})`);
console.log("register it with:  npm run scrape -- --add " + site.url);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void site.close().then(() => process.exit(0));
  });
}
