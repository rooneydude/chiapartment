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

/**
 * A whole number given as `--name=12`; the fallback when the flag is not
 * given at all. A flag that is given but is not a whole number (`--name 12`,
 * `--name=soon`) is refused: a mistyped flag must not quietly mean the default.
 */
function numberFlag(name: string, fallback: number): number {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`--${name} takes a whole number, written like this: --${name}=${fallback}`);
}

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
    // The deploy workflow, after `npm run build`: when was this copy of the
    // site's data built? Handed on to the check that follows the deployment.
    case "built-at": {
      const { builtCopy } = await import("./verify-live");
      const copy = builtCopy(root);
      console.log(`The site's data was built at ${copy.builtAt}, ${copy.latestSnapshot === null ? "with no snapshot in it yet" : `from the snapshot of ${copy.latestSnapshot}`}.`);
      const line = `built_at=${copy.builtAt}\n`;
      if (process.env["GITHUB_OUTPUT"]) appendFileSync(process.env["GITHUB_OUTPUT"], line);
      else process.stdout.write(line);
      break;
    }
    // The deploy workflow's last job: does the site serve what was just deployed?
    case "verify-live": {
      const { DEFAULT_ATTEMPTS, DEFAULT_TIMEOUT_MS, DEFAULT_WAIT_MS, describeCopy, staleSiteMessage, verifyLive } = await import("./verify-live");
      const known = ["attempts", "wait-ms", "timeout-ms"];
      for (const name of flags.keys()) {
        if (!known.includes(name)) throw new Error(`verify-live does not know --${name}. It takes ${known.map((k) => `--${k}=…`).join(", ")}.`);
      }
      const siteUrl = (process.env["SITE_URL"] ?? "").trim();
      const builtAt = (process.env["BUILT_AT"] ?? "").trim();
      // Nothing handed over is not "nothing to check": a check that passes
      // because it was told nothing would pass for ever.
      if (builtAt === "") throw new Error("The build did not say when the site's copy was built (BUILT_AT is empty), so the site could not be checked.");
      if (siteUrl === "") throw new Error("The deployment did not say where the site is (SITE_URL is empty), so the site could not be checked.");
      const attempts = numberFlag("attempts", DEFAULT_ATTEMPTS);
      const waitMs = numberFlag("wait-ms", DEFAULT_WAIT_MS);
      const timeoutMs = numberFlag("timeout-ms", DEFAULT_TIMEOUT_MS);
      const result = await verifyLive({ siteUrl, builtAt, attempts, waitMs, timeoutMs, log: (line) => console.log(line) });
      if (!result.ok) throw new Error(staleSiteMessage({ siteUrl, builtAt }, result, waitMs));
      console.log(`The site serves ${describeCopy(result.served)} (look ${result.attempts}).`);
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
        `Usage: tsx scraper/src/cli.ts <refresh|build-data|skyline|unitmap|alerts|ci-flags|built-at|verify-live> [--fixtures] [--capture] [--commit] [--buildings=a,b] [--out=dir] [--attempts=n] [--wait-ms=n] [--timeout-ms=n]`,
      );
      process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // On GitHub the reason shows on the run's summary page, not only deep in a step's log.
  console.error(process.env["GITHUB_ACTIONS"] ? `::error::${message.replace(/\r?\n/g, " ")}` : message);
  process.exit(1);
}
