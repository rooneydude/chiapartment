import { appendFileSync, readFileSync } from "node:fs";
import { SnapshotSchema } from "../../shared/src/types";
import { buildData } from "./build-data";
import { describeRun, refresh } from "./run";

/**
 * Tell the CI run what happened, where a person will see it: a per-building
 * table on the run's summary page, and step outputs (`ok`, `total`,
 * `failed`) the workflow uses to fail loudly when nothing could be scraped.
 * A no-op outside GitHub Actions.
 */
function reportRun(snapshotFile: string): void {
  const snap = SnapshotSchema.parse(JSON.parse(readFileSync(snapshotFile, "utf8")));
  const run = describeRun(snap);
  if (process.env["GITHUB_OUTPUT"]) {
    appendFileSync(
      process.env["GITHUB_OUTPUT"],
      `ok=${run.ok}\ntotal=${run.total}\nfailed=${run.failed.join(",")}\n`,
    );
  }
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], run.markdown);
  }
  if (run.ok === 0) console.error(`No building could be scraped (${run.failed.join(", ")}).`);
}

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const root = process.cwd();

try {
  switch (command) {
    case "refresh": {
      const buildingsFlag = flags.get("buildings");
      const file = await refresh(root, {
        fixtures: flags.get("fixtures") === true,
        capture: flags.get("capture") === true,
        commit: flags.get("commit") === true,
        buildings:
          typeof buildingsFlag === "string" && buildingsFlag.length > 0
            ? buildingsFlag.split(",").map((s) => s.trim())
            : null,
      });
      reportRun(file);
      break;
    }
    case "build-data":
      buildData(root);
      break;
    case "skyline": {
      const { generateSkyline } = await import("./skyline");
      await generateSkyline(root);
      break;
    }
    case "alerts": {
      const { runAlerts } = await import("./alerts");
      const outFlag = flags.get("out");
      const hasAlerts = runAlerts(root, typeof outFlag === "string" ? outFlag : root);
      // Exit 0 either way; the workflow checks for the body file.
      if (!hasAlerts) process.exit(0);
      break;
    }
    case "unitmap": {
      const { generateUnitmaps } = await import("./unitmap");
      const buildingsFlag = flags.get("buildings");
      await generateUnitmaps(root, {
        fixtures: flags.get("fixtures") === true,
        buildings:
          typeof buildingsFlag === "string" && buildingsFlag.length > 0
            ? buildingsFlag.split(",").map((s) => s.trim())
            : null,
      });
      break;
    }
    default:
      console.error(
        `Usage: tsx scraper/src/cli.ts <refresh|build-data|skyline|unitmap|alerts> [--fixtures] [--capture] [--commit] [--buildings=a,b] [--out=dir]`,
      );
      process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
