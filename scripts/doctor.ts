#!/usr/bin/env tsx
/**
 * Check that this machine can actually run chiapartment.
 *
 *   npm run doctor
 *
 * Setup fails in a handful of predictable ways, and each surfaces as something
 * unhelpful — "localhost refused to connect", or on Windows a console that
 * simply goes quiet. This checks each one directly and says which it is.
 *
 * The important case is `better-sqlite3`. Its prebuilt binaries target
 * Node-API 10, which exists only in Node >=22.14 and >=23.6. On anything older
 * `require()` *succeeds* and the process is then killed by a segmentation
 * fault the moment a database is opened — an uncatchable signal, not a
 * throwable error. So the addon is probed in a child process: a crash there is
 * an exit code to report rather than the end of this one.
 */
import { execSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

/**
 * Node-API version the shipped better-sqlite3 binaries were built against.
 * `process.versions.napi` reports what the running Node supports.
 */
const REQUIRED_NAPI = 10;
const NODE_ADVICE =
  "Install Node 22.14 or newer from https://nodejs.org (the current LTS is\n" +
  "    fine), then close and reopen your terminal and check:  node --version";

const DEFAULT_PORT = 3000;

const checks: Check[] = [
  {
    name: "Node version",
    run() {
      const napi = Number(process.versions.napi ?? 0);
      const version = process.versions.node;

      if (napi >= REQUIRED_NAPI) {
        return { ok: true, detail: `v${version}` };
      }
      return {
        ok: false,
        fatal: true,
        detail: `v${version} — too old (Node-API ${napi}, need ${REQUIRED_NAPI})`,
        fix:
          "This Node is too old for the SQLite driver, and the failure is a\n" +
          "    silent crash rather than an error message — which is why this\n" +
          "    check exists.\n\n" +
          `    ${NODE_ADVICE}\n\n` +
          "    Note that Node 22.0 through 22.13 are affected, including some\n" +
          "    installers labelled 22 LTS. You need 22.14 or newer specifically.",
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
    name: "SQLite driver",
    run() {
      // Deliberately out-of-process: a Node-API mismatch kills the runtime with
      // a signal, which no try/catch can intercept. In a child it is just an
      // exit status.
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          "const D = require('better-sqlite3');" +
            "const d = new D(':memory:');" +
            "d.exec('CREATE TABLE t (x INTEGER)');" +
            "d.prepare('INSERT INTO t VALUES (1)').run();" +
            "d.close();",
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
      );

      if (probe.status === 0) return { ok: true, detail: "loads and runs" };

      // POSIX reports the signal; Windows reports 0xC0000005 as a status.
      const crashed =
        probe.signal === "SIGSEGV" ||
        probe.signal === "SIGABRT" ||
        probe.status === 3221225477 ||
        probe.status === 139;

      if (crashed) {
        return {
          ok: false,
          fatal: true,
          detail: "crashes on load — Node is too old for this binary",
          fix:
            "The SQLite driver's prebuilt binary needs Node-API " +
            `${REQUIRED_NAPI}, which requires Node 22.14 or newer.\n` +
            `    You are on v${process.versions.node} (Node-API ${process.versions.napi}).\n\n` +
            `    ${NODE_ADVICE}`,
        };
      }

      if (process.platform === "win32" && process.arch === "ia32") {
        return {
          ok: false,
          fatal: true,
          detail: "no binary for 32-bit Windows",
          fix:
            "There is no prebuilt SQLite binary for 32-bit Node.\n" +
            "    Install the 64-bit (x64 or arm64) Node 22 LTS build from\n" +
            "    https://nodejs.org and run  npm install  again.",
        };
      }

      const message = (probe.stderr || probe.error?.message || "").trim();
      return {
        ok: false,
        fatal: true,
        detail: message.split("\n")[0] || `exited ${probe.status}`,
        fix:
          "The SQLite driver did not load. Reinstall it:\n" +
          "      npm install --force better-sqlite3\n" +
          "    If that does not help, install Node 22.14 or newer from\n" +
          "    https://nodejs.org and run  npm install  again.",
      };
    },
  },
  {
    name: "Data directory writable",
    run() {
      const dbPath = process.env.CHIAPARTMENT_DB ?? resolve("data/chiapartment.db");
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
      } catch (err) {
        return {
          ok: false,
          detail: (err as Error).message.split("\n")[0],
          fix:
            "Could not create the data folder. Check you have write permission\n" +
            "    here, and that the project is not inside a synced folder\n" +
            "    (OneDrive, Dropbox) that locks files.",
        };
      }

      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          "const D = require('better-sqlite3');" +
            "const d = new D(process.argv[1]);" +
            "d.pragma('journal_mode = WAL');" +
            "d.close();",
          dbPath,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
      );
      if (probe.status === 0) return { ok: true, detail: dbPath };

      return {
        ok: false,
        detail: (probe.stderr || "could not open the database").trim().split("\n")[0],
        fix:
          "The app could not create or open its database file.\n" +
          "    Check write permission, and avoid OneDrive/Dropbox folders —\n" +
          "    their file locking interferes with SQLite.",
      };
    },
  },
  {
    name: "Database has content",
    run() {
      const dbPath = process.env.CHIAPARTMENT_DB ?? resolve("data/chiapartment.db");
      if (!existsSync(dbPath)) {
        return { ok: false, detail: "not created yet", fix: "Run:  npm run seed:demo" };
      }
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          "const D = require('better-sqlite3');" +
            "const d = new D(process.argv[1], { readonly: true, fileMustExist: true });" +
            "process.stdout.write(String(d.prepare('SELECT COUNT(*) AS n FROM buildings').get().n));" +
            "d.close();",
          dbPath,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
      );

      if (probe.status !== 0) {
        return { ok: false, detail: "not readable yet", fix: "Run:  npm run seed:demo" };
      }
      const count = Number(probe.stdout.trim());
      if (!Number.isFinite(count) || count === 0) {
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
      return { ok: true, detail: `${count} building(s)` };
    },
  },
  {
    name: `Port ${DEFAULT_PORT} free`,
    async run() {
      const status = await probePort(DEFAULT_PORT);
      if (status === "free") return { ok: true, detail: "available" };

      if (status === "EACCES") {
        return {
          ok: false,
          detail: "blocked by the OS",
          fix:
            `Permission denied binding port ${DEFAULT_PORT}. Use another one:\n` +
            "      npm run dev -- --port 3005",
        };
      }
      return {
        ok: false,
        detail: "something is already listening",
        fix:
          `Next will start on ${DEFAULT_PORT + 1} instead, so open that rather than\n` +
          `    ${DEFAULT_PORT}. The dev server prints a "Local:" line — that URL is\n` +
          "    always the right one. To pick a port yourself:\n" +
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
          timeout: 120_000,
        }).trim();
        // `next --version` prints "Next.js v16.2.12"; keep exactly one "v".
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
  console.log(
    dim(
      `  ${process.platform} ${process.arch} · node ${process.versions.node} ` +
        `(Node-API ${process.versions.napi})\n`,
    ),
  );

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
  console.log(`\n${dim("Fix the first one listed and run  npm run doctor  again.")}\n`);
  process.exitCode = 1;
}

type PortStatus = "free" | "EADDRINUSE" | "EACCES" | "other";

/**
 * Probe the port the way the dev server binds it — the wildcard address, not
 * loopback — so the check and the server can't disagree about availability.
 */
function probePort(port: number): Promise<PortStatus> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      done(
        err.code === "EADDRINUSE"
          ? "EADDRINUSE"
          : err.code === "EACCES"
            ? "EACCES"
            : "other",
      );
    });
    server.once("listening", () => server.close(() => done("free")));
    server.listen(port);
  });
}

main().catch((err) => {
  console.error(`\n${red("✖")} doctor itself failed: ${(err as Error).message}`);
  process.exit(1);
});
