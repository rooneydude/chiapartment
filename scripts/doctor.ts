#!/usr/bin/env tsx
/**
 * Check that this machine can actually run chiapartment.
 *
 *   npm run doctor
 *
 * Setup fails in a handful of predictable ways — the wrong Node version, a
 * native module that never compiled, a port already in use — and each of them
 * surfaces as something unhelpful like "localhost refused to connect". This
 * checks each one directly and says which it is.
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// The project is ESM, so `require` does not exist. better-sqlite3 is a
// CommonJS native module and has to be loaded through a created require.
const require = createRequire(import.meta.url);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");

interface Check {
  name: string;
  run: () => Promise<Result> | Result;
}

interface Result {
  ok: boolean;
  /** Shown next to the check name. */
  detail: string;
  /** Shown underneath when the check fails. */
  fix?: string;
  /** A failure here makes later checks meaningless. */
  fatal?: boolean;
}

const MIN_NODE_MAJOR = 22;
const DEFAULT_PORT = 3000;

const checks: Check[] = [
  {
    name: "Node version",
    run() {
      const major = Number(process.versions.node.split(".")[0]);
      if (major >= MIN_NODE_MAJOR) {
        return { ok: true, detail: `v${process.versions.node}` };
      }
      return {
        ok: false,
        fatal: true,
        detail: `v${process.versions.node} — too old`,
        fix:
          `better-sqlite3 requires Node ${MIN_NODE_MAJOR} or newer.\n` +
          `    Install the current LTS from https://nodejs.org, then close and\n` +
          `    reopen your terminal and run:  node --version`,
      };
    },
  },
  {
    name: "Dependencies installed",
    run() {
      if (!existsSync(resolve("node_modules"))) {
        return {
          ok: false,
          fatal: true,
          detail: "node_modules is missing",
          fix: "Run:  npm install",
        };
      }
      const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
      const missing = Object.keys(pkg.dependencies ?? {}).filter(
        (d) => !existsSync(resolve("node_modules", d)),
      );
      if (missing.length) {
        return {
          ok: false,
          fatal: true,
          detail: `${missing.length} package(s) missing: ${missing.slice(0, 4).join(", ")}`,
          fix: "Run:  npm install",
        };
      }
      return { ok: true, detail: `${Object.keys(pkg.dependencies ?? {}).length} packages` };
    },
  },
  {
    name: "SQLite native module",
    run() {
      // This is the one that fails on Windows: better-sqlite3 ships compiled
      // binaries per Node version, and without a matching one npm falls back
      // to building from source, which needs Visual Studio Build Tools.
      try {
        const Database = require("better-sqlite3");
        const db = new Database(":memory:");
        db.exec("CREATE TABLE t (x INTEGER)");
        db.close();
        return { ok: true, detail: "loads and runs" };
      } catch (err) {
        const message = (err as Error).message;
        const notBuilt =
          /was compiled against a different Node|Could not locate the bindings|MODULE_NOT_FOUND|invalid ELF|not a valid Win32/i.test(
            message,
          );
        return {
          ok: false,
          fatal: true,
          detail: notBuilt ? "installed but not built for this Node" : message.split("\n")[0],
          fix:
            "Rebuild it against your Node version:\n" +
            "      npm rebuild better-sqlite3\n" +
            "    If that fails on Windows, the compiler is missing. Either:\n" +
            "      - install Node 22 LTS (which has a prebuilt binary), or\n" +
            "      - install the C++ build tools:\n" +
            "          winget install Microsoft.VisualStudio.2022.BuildTools\n" +
            "        then:  npm install --build-from-source better-sqlite3",
        };
      }
    },
  },
  {
    name: "Data directory writable",
    run() {
      const dbPath = process.env.CHIAPARTMENT_DB ?? resolve("data/chiapartment.db");
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
        const Database = require("better-sqlite3");
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        db.close();
        return { ok: true, detail: dbPath };
      } catch (err) {
        return {
          ok: false,
          detail: (err as Error).message.split("\n")[0],
          fix:
            "The app could not create or open its database file.\n" +
            "    Check you have write permission in this folder, and that the\n" +
            "    project is not inside a synced folder (OneDrive, Dropbox) that\n" +
            "    locks files.",
        };
      }
    },
  },
  {
    name: "Database has content",
    run() {
      const dbPath = process.env.CHIAPARTMENT_DB ?? resolve("data/chiapartment.db");
      try {
        const Database = require("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM buildings")
          .get() as { n: number };
        db.close();
        if (row.n === 0) {
          return {
            ok: false,
            detail: "no buildings yet",
            fix:
              "Load the demo data so there is something to look at:\n" +
              "      npm run seed:demo\n" +
              "    or add a real building:\n" +
              "      npm run scrape -- --add https://example.com/",
          };
        }
        return { ok: true, detail: `${row.n} building(s)` };
      } catch {
        return {
          ok: false,
          detail: "not created yet",
          fix: "Run:  npm run seed:demo",
        };
      }
    },
  },
  {
    name: `Port ${DEFAULT_PORT} free`,
    async run() {
      const free = await isPortFree(DEFAULT_PORT);
      if (free) return { ok: true, detail: "available" };
      return {
        ok: false,
        detail: "something is already listening",
        fix:
          `Next will start on ${DEFAULT_PORT + 1} instead, so open that instead of\n` +
          `    ${DEFAULT_PORT}. Read the "Local:" line the dev server prints — that URL\n` +
          "    is always the right one. To use a specific port:\n" +
          "      npm run dev -- --port 3005",
      };
    },
  },
  {
    name: "Next.js build tooling",
    run() {
      try {
        const version = execSync("npx next --version", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        }).trim();
        // `next --version` prints "Next.js v16.2.12"; keep one leading "v".
        return { ok: true, detail: version.replace(/^Next\.js\s*v?/i, "v") };
      } catch (err) {
        return {
          ok: false,
          detail: (err as Error).message.split("\n")[0],
          fix: "Run:  npm install",
        };
      }
    },
  },
];

async function main() {
  console.log(`\n${bold("chiapartment doctor")}`);
  console.log(dim(`  ${process.platform} ${process.arch} · node ${process.versions.node}\n`));

  const failures: Array<{ name: string; result: Result }> = [];
  let stopped = false;

  for (const check of checks) {
    if (stopped) {
      console.log(`  ${dim("·")} ${dim(check.name.padEnd(26))} ${dim("skipped")}`);
      continue;
    }
    let result: Result;
    try {
      result = await check.run();
    } catch (err) {
      result = { ok: false, detail: (err as Error).message.split("\n")[0] };
    }

    const mark = result.ok ? green("✔") : red("✖");
    const detail = result.ok ? dim(result.detail) : yellow(result.detail);
    console.log(`  ${mark} ${check.name.padEnd(26)} ${detail}`);

    if (!result.ok) {
      failures.push({ name: check.name, result });
      if (result.fatal) stopped = true;
    }
  }

  if (failures.length === 0) {
    console.log(
      `\n${green("Everything checks out.")} Start it with:\n` +
        `  ${bold("npm run dev")}\n` +
        dim("  then open the URL it prints (usually http://localhost:3000)\n"),
    );
    return;
  }

  console.log(`\n${bold("What to do")}`);
  for (const { name, result } of failures) {
    console.log(`\n  ${red("✖")} ${bold(name)}`);
    if (result.fix) console.log(`    ${result.fix}`);
  }
  console.log(
    `\n${dim("Fix the first one listed and run  npm run doctor  again.")}\n`,
  );
  process.exitCode = 1;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.once("listening", () => server.close(() => done(true)));
    server.listen(port, "127.0.0.1");
  });
}

main().catch((err) => {
  console.error(`\n${red("✖")} doctor itself failed: ${(err as Error).message}`);
  process.exit(1);
});
