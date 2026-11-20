import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotSchema } from "../../shared/src/types";
import { buildData } from "./build-data";
import { describeFlags, flagOutputs, resolveRefreshFlags, type RefreshRequest } from "./ci-flags";
import { describeRun, loadConfig, refresh } from "./run";

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
    // The "Refresh prices" job's first step: what was this run asked to do?
    // Prints it, and writes the step outputs the workflow reads.
    case "ci-flags": {
      const triggerFile = join(root, ".github", "refresh-trigger");
      const request: RefreshRequest = {
        event: process.env["GITHUB_EVENT_NAME"] ?? "",
        inputs: {
          buildings: process.env["INPUT_BUILDINGS"],
          capture: process.env["INPUT_CAPTURE"],
          skyline: process.env["INPUT_SKYLINE"],
        },
        triggerText: existsSync(triggerFile) ? readFileSync(triggerFile, "utf8") : null,
      };
      const resolved = resolveRefreshFlags(
        request,
        loadConfig(root).buildings.map((b) => b.id),
      );
      console.log(describeFlags(request, resolved));
      if (process.env["GITHUB_OUTPUT"]) appendFileSync(process.env["GITHUB_OUTPUT"], flagOutputs(resolved));
      else process.stdout.write(flagOutputs(resolved));
      break;
    }
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
        `Usage: tsx scraper/src/cli.ts <refresh|build-data|skyline|unitmap|alerts|ci-flags> [--fixtures] [--capture] [--commit] [--buildings=a,b] [--out=dir]`,
      );
      process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // On GitHub the reason shows on the run's summary page, not only deep in a step's log.
  console.error(process.env["GITHUB_ACTIONS"] ? `::error::${message.replace(/\r?\n/g, " ")}` : message);
  process.exit(1);
}
