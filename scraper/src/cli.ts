import { buildData } from "./build-data";
import { refresh } from "./run";

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
      await refresh(root, {
        fixtures: flags.get("fixtures") === true,
        capture: flags.get("capture") === true,
        commit: flags.get("commit") === true,
        buildings:
          typeof buildingsFlag === "string" && buildingsFlag.length > 0
            ? buildingsFlag.split(",").map((s) => s.trim())
            : null,
      });
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
        `Usage: tsx scraper/src/cli.ts <refresh|build-data|skyline|unitmap> [--fixtures] [--capture] [--commit] [--buildings=a,b]`,
      );
      process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
