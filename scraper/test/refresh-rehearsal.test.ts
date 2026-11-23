import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SnapshotSchema, type BuildingHistory, type CompiledConfig, type Snapshot } from "../../shared/src/types";
import { jobNames, jobSteps, Project, readJob, REPO, stepNamed, type Ran, type Step } from "./helpers/workflow";

/**
 * The "Refresh prices" job, rehearsed offline — by running the workflow's
 * own commands. Each step's command and variables are read out of
 * `.github/workflows/refresh.yml` and run the way GitHub runs them
 * (`bash -e`, a clean environment, a fresh output file) in a throwaway copy
 * of the project, against the recorded responses instead of the live sites.
 *
 * On 17 Nov 2026 one line of shell in that workflow stopped the daily
 * refresh, and no test could have noticed: the tests called functions, the
 * job runs commands. Here the commands themselves run, so a workflow line,
 * an npm script, a variable name or the program's entry point that would
 * stop (or quietly redirect) the unattended run fails on the pull request.
 *
 * What is run: the browser check, "Resolve flags", "Scrape" (kept offline),
 * the whole alert step, the alarm for a day when nothing could be read, and
 * the data half of the site's build. What is not: installing dependencies
 * and the browser, and the two steps that ask outside services (skyline,
 * unit map) — for those only the command line is pinned. The first test
 * lists every step and job, so one that is added, removed or made
 * conditional has to be looked at here before the tests pass again.
 */

const SCRAPE_JOB = jobSteps("refresh.yml", "scrape");
const BROWSER = "Does any building need a browser?";
const FLAGS = "Resolve flags (inputs or trigger file)";
const SCRAPE = "Scrape";
const COMMIT = "Commit results";
const ALERTS = "Price alerts (GitHub issue → phone push via the GitHub app)";
/** The deploy workflow's two steps of our own. */
const BUILT = "Note what was built";
const LIVE = "The site serves what was deployed";

/** What a stand-in site was asked: the path, the rest of the address, a header the check sends, and when. */
interface Asked {
  url: string;
  close: () => Promise<void>;
  /** The paths asked for, in order. */
  asked: string[];
  /** The `checked` value of each request's address. */
  checked: (string | null)[];
  /** Each request's cache-control header. */
  cacheControl: (string | undefined)[];
  /** When each request arrived (ms). */
  at: number[];
}

/**
 * A stand-in for the live site: the data folder of a throwaway project,
 * served under /tracker/data/ the way GitHub Pages serves the real one.
 * `instead` answers one file differently (a copy of the site from before),
 * for the first `times` requests only when that is given: a deployment that
 * takes a moment to arrive. Anything under /moved/ is redirected to the same
 * path under /tracker/.
 */
function serveData(dataDir: string, instead: Record<string, string> = {}, times = Number.POSITIVE_INFINITY): Promise<Asked> {
  const asked: string[] = [];
  const checked: (string | null)[] = [];
  const cacheControl: (string | undefined)[] = [];
  const at: number[] = [];
  let answeredInstead = 0;
  const server: Server = createServer((req, res) => {
    const address = new URL(req.url ?? "/", "http://localhost");
    const path = address.pathname;
    if (path.startsWith("/moved/")) {
      res.writeHead(301, { location: `/tracker/${path.slice("/moved/".length)}${address.search}` }).end();
      return;
    }
    asked.push(path);
    checked.push(address.searchParams.get("checked"));
    cacheControl.push(req.headers["cache-control"]);
    at.push(performance.now());
    const rel = path.startsWith("/tracker/data/") ? path.slice("/tracker/data/".length) : null;
    const file = rel === null ? null : normalize(join(dataDir, rel));
    if (rel !== null && instead[rel] !== undefined && answeredInstead < times) {
      answeredInstead++;
      res.writeHead(200, { "content-type": "application/json" }).end(instead[rel]);
    } else if (file === null || !file.startsWith(dataDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(file));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const close = () => new Promise<void>((done) => server.close(() => done()));
      resolve({ url: `http://127.0.0.1:${port}/tracker/`, close, asked, checked, cacheControl, at });
    });
  });
}

/** A stand-in for a site that takes the call and never says a word. */
function serveSilence(): Promise<{ url: string; close: () => Promise<void>; asked: string[] }> {
  const asked: string[] = [];
  const server: Server = createServer((req) => {
    asked.push(new URL(req.url ?? "/", "http://localhost").pathname);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const close = () =>
        new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
      resolve({ url: `http://127.0.0.1:${port}/tracker/`, close, asked });
    });
  });
}

const projects: Project[] = [];
const project = (name: string, opts: { trigger?: string } = {}): Project => {
  const p = new Project(name, opts);
  projects.push(p);
  return p;
};
afterAll(() => {
  for (const p of projects) p.remove();
});

/** What was typed into a manual run. GitHub hands a checkbox over as "true" or "false". */
interface Typed {
  buildings: string;
  capture: "true" | "false";
  skyline: "true" | "false";
}
/** `${{ inputs.… }}` on this run: empty unless it was started by hand. */
const inputs = (typed?: Typed): Record<string, string> => ({
  "inputs.buildings": typed?.buildings ?? "",
  "inputs.capture": typed?.capture ?? "",
  "inputs.skyline": typed?.skyline ?? "",
});
/** `${{ steps.flags.outputs.… }}` for the steps after "Resolve flags". */
const flagOutputs = (flags: Ran): Record<string, string> =>
  Object.fromEntries(Object.entries(flags.outputs).map(([name, value]) => [`steps.flags.outputs.${name}`, value]));

const EVERYTHING = "capture=false\nskyline=false\nbuildings=\nrefresh_args=\n";
const snapshots = (p: Project): string[] => readdirSync(join(p.root, "data", "snapshots")).sort();
const readSnapshot = (p: Project, file: string): Snapshot =>
  SnapshotSchema.parse(JSON.parse(readFileSync(join(p.root, "data", "snapshots", file), "utf8")));

/** The scrape step, kept offline. Its command is pinned first: nothing else is ever run with `--fixtures` added. */
async function scrapeOffline(p: Project, event: string, flags: Ran): Promise<Ran> {
  const step = stepNamed(SCRAPE_JOB, SCRAPE);
  expect(step.run).toBe("npm run refresh -- $REFRESH_ARGS");
  return p.run(step, event, flagOutputs(flags), { append: " --fixtures" });
}

/** A stand-in for the `gh` program that only writes down how it was called. */
function standInForGh(p: Project): { path: string; called: string } {
  const bin = join(p.root, ".stand-in");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\n{ printf "token=%s\\n" "$GH_TOKEN"; printf "%s\\n" "$@"; } > "$GH_CALLED"\n');
  chmodSync(join(bin, "gh"), 0o755);
  return { path: bin, called: join(p.temp, "gh-called.txt") };
}

describe("the refresh workflow keeps no logic of its own", () => {
  const scripts = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const SKYLINE = "Generate skyline (when missing or requested)";
  const UNITMAP = "Update unit-position maps";

  it("every step of the job is run by a test, or is named here with the reason it is not", () => {
    const how: Record<string, string> = {
      "actions/checkout@v4": "GitHub's own: the checkout",
      "actions/setup-node@v4": "GitHub's own: Node",
      "npm ci": "not run: installs the dependencies these tests are already running on",
      [BROWSER]: "run below",
      "Cache Playwright browser": "GitHub's own: a cache, and only when a building needs a browser",
      "Install Playwright Chromium": "not run: downloads a browser, and only when a building needs one",
      [FLAGS]: "run below, started every way the job can start",
      [SKYLINE]: "not run: asks OpenStreetMap; allowed to fail without failing the job",
      [SCRAPE]: "run below, against the recorded responses",
      [UNITMAP]: "not run: reads the leasing site's floor plate; allowed to fail without failing the job",
      [COMMIT]: "ci-commit.test.ts runs the script it calls against real repositories",
      [ALERTS]: "run below, with a stand-in for gh",
    };
    // A step added, removed or reordered has to be put right here — and so
    // be thought about — before this passes again.
    expect(SCRAPE_JOB.map((s) => s.name)).toEqual(Object.keys(how));

    // The steps that are one command each, word for word.
    expect(stepNamed(SCRAPE_JOB, FLAGS).run).toBe("npm run -s ci:flags");
    expect(stepNamed(SCRAPE_JOB, SCRAPE).run).toBe("npm run refresh -- $REFRESH_ARGS");
    expect(stepNamed(SCRAPE_JOB, COMMIT).run).toBe("bash .github/scripts/commit-snapshot.sh");
    expect(existsSync(join(REPO, ".github", "scripts", "commit-snapshot.sh"))).toBe(true);
    expect(existsSync(join(REPO, ".github", "scripts", "merge-unitmap.mjs"))).toBe(true);

    // The steps a test runs always run on GitHub too, and exactly as written:
    // none is conditional, and none has a setting beyond these. (The reader
    // refuses `shell`, `working-directory` and the like outright.)
    expect(stepNamed(SCRAPE_JOB, BROWSER).keys).toEqual({ name: BROWSER, id: "browser" });
    expect(stepNamed(SCRAPE_JOB, FLAGS).keys).toEqual({ name: FLAGS, id: "flags" });
    expect(stepNamed(SCRAPE_JOB, SCRAPE).keys).toEqual({ name: SCRAPE, id: "scrape" });
    expect(stepNamed(SCRAPE_JOB, COMMIT).keys).toEqual({ name: COMMIT });
    // Alerting may fail; the snapshot is committed before it runs.
    expect(stepNamed(SCRAPE_JOB, ALERTS).keys).toEqual({ name: ALERTS, "continue-on-error": "true" });

    // The steps no test runs: the command, its npm script and the program's
    // subcommand are pinned, each may fail without failing the job, and the
    // conditions name outputs that the steps run here do write.
    expect(stepNamed(SCRAPE_JOB, SKYLINE).run).toBe("npm run skyline");
    expect(stepNamed(SCRAPE_JOB, UNITMAP).run).toBe("npm run unitmap");
    const cli = readFileSync(join(REPO, "scraper", "src", "cli.ts"), "utf8");
    for (const name of ["skyline", "unitmap"]) {
      expect(scripts[name]).toBe(`tsx scraper/src/cli.ts ${name}`);
      expect(cli).toContain(`case "${name}": {`);
    }
    expect(stepNamed(SCRAPE_JOB, SKYLINE).keys).toEqual({
      name: SKYLINE,
      if: "steps.flags.outputs.skyline == 'true' || hashFiles('data/skyline.geojson') == ''",
      "continue-on-error": "true",
    });
    expect(stepNamed(SCRAPE_JOB, UNITMAP).keys).toEqual({ name: UNITMAP, "continue-on-error": "true" });
    for (const name of ["Cache Playwright browser", "Install Playwright Chromium"]) {
      expect(stepNamed(SCRAPE_JOB, name).keys["if"], name).toBe("steps.browser.outputs.needed == 'true'");
    }
  });

  it("has three jobs, none conditional but the alarm", () => {
    expect(jobNames("refresh.yml")).toEqual(["scrape", "deploy", "health"]);
    // The scrape always runs, on a plain runner; its outputs feed the alarm.
    expect(readJob("refresh.yml", "scrape").keys).toEqual({ "runs-on": "ubuntu-latest", concurrency: "", outputs: "", steps: "" });
    // One scrape at a time, never cut short, and the queue is the scrape's
    // alone: a refresh does not wait for another's deployment or its check.
    const refreshText = readFileSync(join(REPO, ".github", "workflows", "refresh.yml"), "utf8");
    expect(refreshText).toMatch(/\n  scrape:\n    runs-on: ubuntu-latest\n(?:    #.*\n)*    concurrency:\n      group: refresh\n    outputs:\n/);
    expect(refreshText).not.toMatch(/^concurrency:/m);
    expect(refreshText).not.toContain("cancel-in-progress");
    // The site is rebuilt after every scrape, by the deploy workflow.
    expect(readJob("refresh.yml", "deploy").keys).toEqual({ needs: "scrape", uses: "./.github/workflows/deploy.yml", permissions: "" });
    expect(readJob("refresh.yml", "health").keys).toEqual({
      needs: "scrape",
      if: "needs.scrape.outputs.ok == '0'",
      "runs-on": "ubuntu-latest",
      steps: "",
    });
  });

  /** deploy.yml as text, and the part of it that is one job (from its name to the next job's, comments included). */
  const deployText = (): string => readFileSync(join(REPO, ".github", "workflows", "deploy.yml"), "utf8");
  const jobText = (job: string): string => {
    const text = deployText();
    const start = text.indexOf(`\n  ${job}:\n`);
    expect(start, `deploy.yml has a job "${job}"`).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
    return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
  };

  it("the site is built by one command, whose first half this file runs, and then looked at", () => {
    expect(jobNames("deploy.yml")).toEqual(["publish", "verify"]);
    // Started three ways: by a push to the published branch, by hand, and by the refresh.
    expect(deployText()).toMatch(/^on:\n  push:\n    branches: \[claude\/repo-reset-4my0gv, main\]\n  workflow_dispatch:\n  workflow_call:/m);

    const publish = readJob("deploy.yml", "publish");
    const verify = readJob("deploy.yml", "verify");
    expect(publish.keys).toEqual({ "runs-on": "ubuntu-latest", concurrency: "", environment: "", outputs: "", steps: "" });
    expect(verify.keys).toEqual({ needs: "publish", "runs-on": "ubuntu-latest", steps: "" });
    // Every step of both jobs, in order: one added, removed or moved has to be
    // put right here, and so be thought about, before this passes again. (A
    // second checkout after the first would put the tree back to the commit
    // the run started from, and the page would be built without the snapshot
    // the refresh had just pushed.) The note of what was built comes after
    // the build and before the publishing.
    const what = (job: typeof publish): string[] => job.steps.map((s) => s.keys["uses"] ?? s.run ?? "");
    expect(what(publish)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci",
      "npm run build",
      "npm run -s ci:built-at",
      "actions/configure-pages@v5",
      "actions/upload-pages-artifact@v3",
      "actions/deploy-pages@v4",
    ]);
    expect(what(verify)).toEqual(["actions/checkout@v4", "actions/setup-node@v4", "npm ci", "npm run -s ci:verify-live"]);
    // None of them conditional, none allowed to fail quietly: a page that is behind turns the run red.
    for (const step of [...publish.steps, ...verify.steps]) {
      expect(Object.keys(step.keys).filter((key) => key === "if" || key === "continue-on-error"), step.name).toEqual([]);
    }
    expect(stepNamed(publish.steps, BUILT).keys).toEqual({ name: BUILT, id: "built" });
    expect(scripts["build"]).toBe("npm run build:data && npm run -w web build");

    // What is published is the built site, and the check is handed where it went and what was built.
    const text = jobText("publish");
    expect(text).toContain("      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: web/dist\n");
    expect(text).toContain("      - id: deployment\n        uses: actions/deploy-pages@v4\n");
    expect(text).toContain("      built_at: ${{ steps.built.outputs.built_at }}\n");
    expect(text).toContain("      page_url: ${{ steps.deployment.outputs.page_url }}\n");
    const look = stepNamed(verify.steps, LIVE);
    expect(look.keys).toEqual({ name: LIVE });
    expect(look.env).toEqual({ SITE_URL: "${{ needs.publish.outputs.page_url }}", BUILT_AT: "${{ needs.publish.outputs.built_at }}" });
  });

  it("deployments wait for one another; none is cancelled while it publishes, and none waits for another's check", () => {
    // Not something a test here can run: it is GitHub's own scheduling. What
    // can be held is the setting, and the reason for it (see deploy.yml): on
    // 23 Nov 2026 a deployment cancelled mid-publish left the site a
    // snapshot behind while the run that replaced it reported success.
    const publish = jobText("publish");
    expect(publish).toMatch(/\n    concurrency:\n      group: pages\n(?:      #.*\n)*      cancel-in-progress: false\n/);
    // The queue is the publishing job's alone. Held by the whole workflow, it
    // would also be held while a failing check looks for twelve minutes, and
    // the deployment that would put the page right would wait behind it.
    expect(deployText()).not.toMatch(/^concurrency:/m);
    expect(jobText("verify")).not.toContain("concurrency");

    // The build — inside the queue — checks out the branch, not the commit
    // that started the run: the refresh's own deployment has to carry the
    // snapshot it has just pushed. This is asked of the publishing job's own
    // text: another job's checkout must not be able to stand in for it.
    expect(publish).toMatch(/\n      - uses: actions\/checkout@v4\n        with:\n(?:          #.*\n)*          ref: \$\{\{ github\.ref_name \}\}\n/);
    // The check reads the branch too, for the newest snapshot on it: the
    // page has to show that one, whichever commit the run started from. Each
    // job's text is asked on its own, so neither checkout can stand in for
    // the other (as the check's once did for the build's).
    expect(jobText("verify")).toMatch(/\n      - uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github\.ref_name \}\}\n/);
  });
});

describe("step “Resolve flags”, started every way the job can start", () => {
  const LEFT_IN_THE_FILE = "capture skyline buildings=the-leo\n";
  const starts: {
    title: string;
    event: string;
    typed?: Typed;
    /** The trigger file in the checkout; left out = the one committed in this repository. */
    trigger?: string;
    writes?: string;
    refuses?: RegExp;
  }[] = [
    {
      title: "the scheduled run scrapes everything — whatever somebody left in the trigger file",
      event: "schedule",
      trigger: LEFT_IN_THE_FILE,
      writes: EVERYTHING,
    },
    {
      title: "the push that lands the trigger file committed here scrapes everything",
      event: "push",
      writes: EVERYTHING,
    },
    {
      title: "a push whose trigger file names flags gets them",
      event: "push",
      trigger: "# the two that failed this morning\ncapture skyline buildings=the-leo,stead-220\n",
      writes: "capture=true\nskyline=true\nbuildings=the-leo,stead-220\nrefresh_args=--buildings=the-leo,stead-220 --capture\n",
    },
    {
      title: "a manual run with nothing typed scrapes everything",
      event: "workflow_dispatch",
      typed: { buildings: "", capture: "false", skyline: "false" },
      trigger: LEFT_IN_THE_FILE,
      writes: EVERYTHING,
    },
    {
      title: "a manual run gets what was typed",
      event: "workflow_dispatch",
      typed: { buildings: "the-leo, stead-220", capture: "true", skyline: "false" },
      writes: "capture=true\nskyline=false\nbuildings=the-leo,stead-220\nrefresh_args=--buildings=the-leo,stead-220 --capture\n",
    },
    {
      title: "a manual run's two boxes are two different things",
      event: "workflow_dispatch",
      typed: { buildings: "", capture: "false", skyline: "true" },
      writes: "capture=false\nskyline=true\nbuildings=\nrefresh_args=\n",
    },
    {
      title: "a push whose trigger file asks only for the skyline does not save raw responses",
      event: "push",
      trigger: "skyline\n",
      writes: "capture=false\nskyline=true\nbuildings=\nrefresh_args=\n",
    },
    {
      title: "a list that is not building ids stops the job before it scrapes, and says why",
      event: "workflow_dispatch",
      typed: { buildings: "the-leo; echo injected", capture: "false", skyline: "false" },
      refuses: /^::error::The list of buildings is not a list of building ids/m,
    },
    {
      title: "a building that does not exist stops the job, by name",
      event: "workflow_dispatch",
      typed: { buildings: "the-leo,the-loe", capture: "false", skyline: "false" },
      refuses: /^::error::There is no building "the-loe"\. Known buildings: 1225-old-town, /m,
    },
  ];

  for (const start of starts) {
    it.concurrent(start.title, { timeout: 120_000 }, async () => {
      const p = project("flags", start.trigger === undefined ? {} : { trigger: start.trigger });
      const ran = await p.run(stepNamed(SCRAPE_JOB, FLAGS), start.event, inputs(start.typed));
      if (start.refuses) {
        expect(ran.code).toBe(1);
        expect(ran.stderr).toMatch(start.refuses);
        expect(ran.written).toBe(""); // nothing for the later steps to act on
      } else {
        expect(ran.code, ran.stderr).toBe(0);
        expect(ran.written).toBe(start.writes);
        expect(ran.stdout).toMatch(/^Refresh requested by /m);
      }
    });
  }
});

describe("the job from start to compiled data, command by command", { timeout: 300_000 }, () => {
  it("a scheduled run reads every building, raises one alert for one real change, and compiles the site's data", async () => {
    const p = project("scheduled");

    // Step "Does any building need a browser?" — shell written in the workflow; today the answer is no.
    const browser = await p.run(stepNamed(SCRAPE_JOB, BROWSER), "schedule", {});
    expect(browser.code, browser.stderr).toBe(0);
    expect(browser.written).toBe("needed=false\n");

    // Step "Resolve flags".
    const flags = await p.run(stepNamed(SCRAPE_JOB, FLAGS), "schedule", inputs());
    expect(flags.code, flags.stderr).toBe(0);
    expect(flags.written).toBe(EVERYTHING);

    // Step "Scrape": every building, and the outputs and summary the rest of the workflow reads.
    const scrape = await scrapeOffline(p, "schedule", flags);
    expect(scrape.code, scrape.stderr).toBe(0);
    expect(scrape.written).toBe("ok=6\ntotal=6\nfailed=\n");
    const workflow = readFileSync(join(REPO, ".github", "workflows", "refresh.yml"), "utf8");
    const read = [...workflow.matchAll(/steps\.scrape\.outputs\.([a-z_]+)/g)].map((m) => m[1]!);
    expect(read.sort()).toEqual(Object.keys(scrape.outputs).sort()); // the job's own outputs, and the "nothing could be read" alarm
    const summary = readFileSync(p.summary, "utf8");
    expect(summary).toMatch(/6\/6 buildings ok/);
    expect(snapshots(p)).toHaveLength(1);
    const todayFile = snapshots(p)[0]!;
    expect(todayFile).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
    const today = readSnapshot(p, todayFile);
    const ids = today.buildings.map((b) => b.buildingId);
    expect(ids).toHaveLength(6);
    for (const b of today.buildings) {
      expect(b.status, b.buildingId).toBe("ok");
      expect(b.alsoListed, b.buildingId).toBeDefined();
      expect(summary).toContain(`| ${b.buildingId} | ok |`);
    }
    const b1225 = today.buildings.find((b) => b.buildingId === "1225-old-town")!;
    expect(b1225.units.length).toBeGreaterThanOrEqual(10);
    expect(b1225.units.every((u) => (u.leaseTerms?.length ?? 0) > 1 && u.availableDate !== null)).toBe(true);

    // Yesterday's run, so the next steps have something to compare with: the
    // same listings, except one studio or two-bedroom that cost $100 more.
    const yesterday: Snapshot = structuredClone(today);
    yesterday.timestamp = new Date(Date.parse(today.timestamp) - 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const repriced = yesterday.buildings
      .find((b) => b.buildingId === "old-town-park-1")!
      .units.find((u) => u.unitNumber !== null && (u.beds === 0 || u.beds === 2))!;
    repriced.price += 100;
    if (repriced.priceMax !== undefined) repriced.priceMax += 100;
    SnapshotSchema.parse(yesterday);
    writeFileSync(join(p.root, "data", "snapshots", `${yesterday.timestamp.replaceAll(":", "-")}.json`), JSON.stringify(yesterday));

    // Step "Price alerts", all of it: the alert is worked out, and `gh` is
    // asked to open exactly one issue with that title and body.
    const gh = standInForGh(p);
    const alerts = await p.run(stepNamed(SCRAPE_JOB, ALERTS), "schedule", { "github.token": "stand-in-token" }, {
      path: gh.path,
      env: { GH_CALLED: gh.called },
    });
    expect(alerts.code, alerts.stderr).toBe(0);
    const title = readFileSync(join(p.temp, "alert-title.txt"), "utf8");
    const body = readFileSync(join(p.temp, "alert-body.md"), "utf8");
    expect(title).toMatch(/1 drop/);
    expect(body).toContain(`#${repriced.unitNumber}`);
    expect(body).toContain("▼$100");
    expect(body).not.toContain("New listings");
    expect(body).not.toContain("Scrape problems");
    expect(readFileSync(gh.called, "utf8").trimEnd().split("\n")).toEqual([
      "token=stand-in-token",
      "issue",
      "create",
      "--title",
      title.trimEnd(),
      "--body-file",
      join(p.temp, "alert-body.md"),
      "--repo",
      "example/tracker",
    ]);

    // The deploy job's "npm run build", first half: the site's data.
    const build = await p.run({ name: "build:data", run: "npm run -s build:data", env: {}, keys: {} } satisfies Step, "schedule", {});
    expect(build.code, build.stderr).toBe(0);
    const compiled = <T>(path: string): T => JSON.parse(readFileSync(join(p.root, "web", "public", "data", path), "utf8")) as T;
    const config = compiled<CompiledConfig>("config.json");
    expect(config.health?.snapshots).toBe(2);
    expect(config.health?.skippedSnapshots).toBeUndefined();
    for (const id of ids) {
      const history = compiled<BuildingHistory>(`buildings/${id}.json`);
      expect(history.latest?.timestamp, id).toBe(today.timestamp);
      expect(history.lastAttempt?.status, id).toBe("ok");
      expect(history.warnings, id).toEqual([]);
    }
    const otp1 = compiled<BuildingHistory>("buildings/old-town-park-1.json");
    expect(otp1.delta?.priceChanges.map((c) => [c.unitNumber, c.from - c.to])).toEqual([[repriced.unitNumber, 100]]);
    expect(otp1.delta?.newUnits).toEqual([]);
    expect(otp1.delta?.removedUnits).toEqual([]);
    expect(existsSync(join(p.root, "web", "public", "data", "brief.json"))).toBe(true);
    expect(config.health?.latestSnapshot).toBe(today.timestamp);

    const builtAt = config.health!.generated;
    expect(Number.isNaN(Date.parse(builtAt))).toBe(false);

    // The deploy workflow's own two steps. "Note what was built" hands the last job the time this copy was built…
    const deployBuild = jobSteps("deploy.yml", "publish");
    const built = await p.run(stepNamed(deployBuild, BUILT), "schedule", {});
    expect(built.code, built.stderr).toBe(0);
    expect(built.written).toBe(`built_at=${builtAt}\n`);
    expect(built.stdout).toContain(`The site's data was built at ${builtAt}, from the snapshot of ${today.timestamp}.`);

    // …and "The site serves what was deployed" looks for that copy on the site.
    // Here the site is this project's compiled data, served the way Pages serves it.
    const look = stepNamed(jobSteps("deploy.yml", "verify"), LIVE);
    expect(look.run).toBe("npm run -s ci:verify-live");
    const site = await serveData(join(p.root, "web", "public", "data"));
    try {
      const handed = { "needs.publish.outputs.page_url": site.url, "needs.publish.outputs.built_at": built.outputs["built_at"]! };
      // First with two quick looks, so that a check which no longer knows its
      // own copy fails here in a second, not after twelve minutes of looking…
      const quick = await p.run(look, "schedule", handed, { append: " -- --attempts=2 --wait-ms=20" });
      expect(quick.code, quick.stderr).toBe(0);
      expect(quick.stdout).toContain(`The site serves a copy built at ${builtAt}, from the snapshot of ${today.timestamp} (look 1).`);
      // …then exactly as the workflow writes it.
      const fresh = await p.run(look, "schedule", handed);
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain(`The site serves a copy built at ${builtAt}, from the snapshot of ${today.timestamp} (look 1).`);
      expect(site.asked).toEqual(["/tracker/data/config.json", "/tracker/data/config.json"]);
      // Each look asks for an address of its own, and asks not to be given a kept copy.
      expect(site.checked[0]).toMatch(/^\d{13}-1$/);
      expect(site.checked[1]).toMatch(/^\d{13}-1$/);
      expect(site.checked[1]).not.toBe(site.checked[0]);
      expect(site.cacheControl).toEqual(["no-cache", "no-cache"]);
      // An address that has moved is followed to where the site is.
      const moved = await p.run(look, "schedule", { ...handed, "needs.publish.outputs.page_url": site.url.replace("/tracker/", "/moved/") }, { append: " -- --attempts=1" });
      expect(moved.code, moved.stderr).toBe(0);
      expect(moved.stdout).toContain(`The site serves a copy built at ${builtAt}, from the snapshot of ${today.timestamp} (look 1).`);
    } finally {
      await site.close();
    }

    // The case of 23 Nov: the deployment reports success and the site still
    // serves the copy from before, built from yesterday's snapshot. The run has to go red.
    const earlier = new Date(Date.parse(builtAt) - 4 * 60_000).toISOString();
    const before = JSON.stringify({ ...config, health: { ...config.health, generated: earlier, snapshots: 1, latestSnapshot: yesterday.timestamp } });
    const behind = await serveData(join(p.root, "web", "public", "data"), { "config.json": before });
    try {
      const handed = { "needs.publish.outputs.page_url": behind.url, "needs.publish.outputs.built_at": builtAt };
      const stale = await p.run(look, "schedule", handed, { append: " -- --attempts=3 --wait-ms=20" });
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain(
        `::error::The site does not serve what this run deployed. This run's copy was built at ${builtAt}; after 3 looks at ${behind.url} the site serves a copy built at ${earlier}, from the snapshot of ${yesterday.timestamp}.`,
      );
      expect(behind.asked).toHaveLength(3);

      // Told nothing, the check does not pass: an empty hand-over means the
      // workflow's wiring is broken, and a check that passed then would pass for ever.
      const untold = await p.run(look, "schedule", { "needs.publish.outputs.page_url": behind.url, "needs.publish.outputs.built_at": "" });
      expect(untold.code).toBe(1);
      expect(untold.stderr).toContain("::error::The build did not say when the site's copy was built (BUILT_AT is empty)");
      const nowhere = await p.run(look, "schedule", { "needs.publish.outputs.page_url": "", "needs.publish.outputs.built_at": builtAt });
      expect(nowhere.code).toBe(1);
      expect(nowhere.stderr).toContain("::error::The deployment did not say where the site is (SITE_URL is empty)");
      // Handed something, but not what it should be: refused by name, with what came.
      const noScheme = await p.run(look, "schedule", { "needs.publish.outputs.page_url": "example.github.io/tracker/", "needs.publish.outputs.built_at": builtAt });
      expect(noScheme.code).toBe(1);
      expect(noScheme.stderr).toContain('::error::The deployment handed over something that is not a web address (SITE_URL is "example.github.io/tracker/")');
      const notATime = await p.run(look, "schedule", { "needs.publish.outputs.page_url": behind.url, "needs.publish.outputs.built_at": "1" });
      expect(notATime.code).toBe(1);
      expect(notATime.stderr).toContain('::error::The build handed over something that is not a build time (BUILT_AT is "1")');
      expect(behind.asked).toHaveLength(3); // none of the four looked anywhere
      // …and the failure said the page is behind, because an older copy was read from it.
      expect(stale.stderr).toContain("the page is behind, and the next deployment should bring it up to date.");
    } finally {
      await behind.close();
    }

    // A deployment that takes a moment to arrive: the copy from before on the
    // first look, this run's on the second. The check waits between the two —
    // for real, by its own clock — and passes.
    const late = await serveData(join(p.root, "web", "public", "data"), { "config.json": before }, 1);
    try {
      const handed = { "needs.publish.outputs.page_url": late.url, "needs.publish.outputs.built_at": builtAt };
      const arrived = await p.run(look, "schedule", handed, { append: " -- --attempts=3 --wait-ms=700" });
      expect(arrived.code, arrived.stderr).toBe(0);
      expect(arrived.stdout).toContain(`Look 1 of 3: the site serves a copy built at ${earlier}, from the snapshot of ${yesterday.timestamp};`);
      expect(arrived.stdout).toContain(`The site serves a copy built at ${builtAt}, from the snapshot of ${today.timestamp} (look 2).`);
      expect(late.asked).toHaveLength(2);
      expect(late.at[1]! - late.at[0]!).toBeGreaterThanOrEqual(650);
      expect(late.checked[1]).toMatch(/^\d{13}-2$/);
    } finally {
      await late.close();
    }

    // Built from the wrong commit: the stamp is this run's, the data is
    // yesterday's. (What a checkout of the commit the run started from, in
    // place of the branch, would publish every day.) The stamp alone would
    // pass it; the newest snapshot on the branch does not.
    const withoutToday = JSON.stringify({ ...config, health: { ...config.health, snapshots: 1, latestSnapshot: yesterday.timestamp } });
    const wrongCommit = await serveData(join(p.root, "web", "public", "data"), { "config.json": withoutToday });
    try {
      const handed = { "needs.publish.outputs.page_url": wrongCommit.url, "needs.publish.outputs.built_at": builtAt };
      const lacking = await p.run(look, "schedule", handed, { append: " -- --attempts=2 --wait-ms=20" });
      expect(lacking.code).toBe(1);
      expect(lacking.stdout).toContain(`The newest snapshot on the branch is that of ${today.timestamp}.`);
      expect(lacking.stderr).toContain(
        `after 2 looks at ${wrongCommit.url} the site serves a copy built at ${builtAt}, from the snapshot of ${yesterday.timestamp}, which does not hold the newest snapshot on the branch (${today.timestamp}).`,
      );
      expect(lacking.stderr).toContain("the page is behind, and the next deployment should bring it up to date.");
    } finally {
      await wrongCommit.close();
    }

    // A deployment that changes only the code — same snapshot, new build — is
    // held to the same test: the copy from before is still the copy from before.
    const sameData = JSON.stringify({ ...config, health: { ...config.health, generated: earlier } });
    const codeBehind = await serveData(join(p.root, "web", "public", "data"), { "config.json": sameData });
    try {
      const handed = { "needs.publish.outputs.page_url": codeBehind.url, "needs.publish.outputs.built_at": builtAt };
      const stale = await p.run(look, "schedule", handed, { append: " -- --attempts=1" });
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain(`after one look at ${codeBehind.url} the site serves a copy built at ${earlier}, from the snapshot of ${today.timestamp}.`);
    } finally {
      await codeBehind.close();
    }
  });

  it("a project with no snapshot yet builds, says so, and its site is checked like any other", async () => {
    const p = project("empty");
    const build = await p.run({ name: "build:data", run: "npm run -s build:data", env: {}, keys: {} } satisfies Step, "push", {});
    expect(build.code, build.stderr).toBe(0);
    const builtAt = (JSON.parse(readFileSync(join(p.root, "web", "public", "data", "config.json"), "utf8")) as CompiledConfig).health!.generated;
    const built = await p.run(stepNamed(jobSteps("deploy.yml", "publish"), BUILT), "push", {});
    expect(built.code, built.stderr).toBe(0);
    expect(built.written).toBe(`built_at=${builtAt}\n`);
    expect(built.stdout).toContain(`The site's data was built at ${builtAt}, with no snapshot in it yet.`);
    const look = stepNamed(jobSteps("deploy.yml", "verify"), LIVE);
    const site = await serveData(join(p.root, "web", "public", "data"));
    try {
      const handed = { "needs.publish.outputs.page_url": site.url, "needs.publish.outputs.built_at": built.outputs["built_at"]! };
      const ran = await p.run(look, "push", handed, { append: " -- --attempts=2 --wait-ms=20" });
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toContain(`The site serves a copy built at ${builtAt} (look 1).`);
    } finally {
      await site.close();
    }
  });

  it("a site that says nothing does not hold the run, and a mistyped flag is refused rather than ignored", async () => {
    const p = project("silent");
    const look = stepNamed(jobSteps("deploy.yml", "verify"), LIVE);
    const site = await serveSilence();
    try {
      const handed = { "needs.publish.outputs.page_url": site.url, "needs.publish.outputs.built_at": "2026-11-23T10:29:25.000Z" };
      const started = Date.now();
      const silent = await p.run(look, "schedule", handed, { append: " -- --attempts=2 --wait-ms=10 --timeout-ms=300" });
      expect(silent.code).toBe(1);
      expect(silent.stdout).toContain("Look 1 of 2: the site did not answer within 0.3 s;");
      expect(silent.stderr).toContain(`after 2 looks at ${site.url} the site did not answer within 0.3 s.`);
      expect(silent.stderr).toContain("but the site's data could not be read, so whether the page is behind is not known.");
      expect(silent.stderr).not.toContain("the page is behind, and");
      expect(site.asked).toEqual(["/tracker/data/config.json", "/tracker/data/config.json"]);
      expect(Date.now() - started).toBeLessThan(60_000); // not the minutes a look with no limit would take

      // `--wait-ms 10` is not `--wait-ms=10`. Taken as "no flag", it would
      // quietly mean the default: a quarter of a minute between looks.
      const spaced = await p.run(look, "schedule", handed, { append: " -- --attempts=1 --wait-ms 10 --timeout-ms=300" });
      expect(spaced.code).toBe(1);
      expect(spaced.stderr).toContain("::error::--wait-ms takes a whole number from 0 to 600000, written like this: --wait-ms=30000");
      const worded = await p.run(look, "schedule", handed, { append: " -- --attempts=two --wait-ms=10 --timeout-ms=300" });
      expect(worded.code).toBe(1);
      expect(worded.stderr).toContain("::error::--attempts takes a whole number from 1 to 500, written like this: --attempts=25");
      const bare = await p.run(look, "schedule", handed, { append: " -- --attempts=1 --timeout-ms" });
      expect(bare.code).toBe(1);
      expect(bare.stderr).toContain("::error::--timeout-ms takes a whole number from 1 to 120000, written like this: --timeout-ms=20000");
      // A number, but not one that makes sense: no looks at all, a wait of a month, a look with no end in sight.
      for (const [name, value, range] of [
        ["attempts", "0", "from 1 to 500"],
        ["attempts", "501", "from 1 to 500"],
        ["wait-ms", "3000000000", "from 0 to 600000"],
        ["timeout-ms", "0", "from 1 to 120000"],
        ["timeout-ms", "4294967296", "from 1 to 120000"],
      ] as const) {
        const given = { attempts: "1", "wait-ms": "10", "timeout-ms": "300", [name]: value };
        const typed = Object.entries(given)
          .map(([flag, n]) => `--${flag}=${n}`)
          .join(" ");
        const outOfRange = await p.run(look, "schedule", handed, { append: ` -- ${typed}` });
        expect(outOfRange.code, typed).toBe(1);
        expect(outOfRange.stderr, typed).toContain(`::error::--${name} takes a whole number ${range}`);
      }
      const misspelt = await p.run(look, "schedule", handed, { append: " -- --atempts=1 --attempts=1 --wait-ms=10 --timeout-ms=300" });
      expect(misspelt.code).toBe(1);
      expect(misspelt.stderr).toContain("::error::verify-live does not know --atempts. It takes --attempts=…, --wait-ms=…, --timeout-ms=….");
      expect(site.asked).toHaveLength(2); // none of these looked anywhere
    } finally {
      await site.close();
    }
  });

  it("a manual run for two buildings scrapes exactly those two, and with nothing to report opens no issue", async () => {
    const p = project("manual");
    const typed: Typed = { buildings: "the-leo,stead-220", capture: "false", skyline: "false" };
    const flags = await p.run(stepNamed(SCRAPE_JOB, FLAGS), "workflow_dispatch", inputs(typed));
    expect(flags.code, flags.stderr).toBe(0);
    expect(flags.outputs["refresh_args"]).toBe("--buildings=the-leo,stead-220");

    const scrape = await scrapeOffline(p, "workflow_dispatch", flags);
    expect(scrape.code, scrape.stderr).toBe(0);
    expect(scrape.written).toBe("ok=2\ntotal=2\nfailed=\n");
    expect(snapshots(p)).toHaveLength(1);
    expect(readSnapshot(p, snapshots(p)[0]!).buildings.map((b) => b.buildingId).sort()).toEqual(["stead-220", "the-leo"]);

    // A first snapshot has nothing to be compared with: no alert, and `gh` is never started.
    const gh = standInForGh(p);
    const alerts = await p.run(stepNamed(SCRAPE_JOB, ALERTS), "workflow_dispatch", { "github.token": "stand-in-token" }, {
      path: gh.path,
      env: { GH_CALLED: gh.called },
    });
    expect(alerts.code, alerts.stderr).toBe(0);
    expect(existsSync(join(p.temp, "alert-body.md"))).toBe(false);
    expect(existsSync(gh.called)).toBe(false);
  });

  it("turns the run red, with the reason, on a day when no building could be read", async () => {
    // The scrape job still commits the snapshot (with its errors) and the site
    // is rebuilt; this separate job exists so that such a day does not look quiet.
    const p = project("alarm");
    const [alarm] = jobSteps("refresh.yml", "health");
    const ran = await p.run(alarm!, "schedule", {
      "needs.scrape.outputs.total": "6",
      "needs.scrape.outputs.failed": "1225-old-town,the-leo",
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("::error::None of the 6 buildings could be scraped (1225-old-town,the-leo). See the scrape job's summary.");
  });

  it("says a browser is needed once a building is configured to be read with one", async () => {
    const p = project("browser");
    const config = JSON.parse(readFileSync(join(p.root, "buildings.json"), "utf8")) as { buildings: { adapter: string }[] };
    config.buildings[0]!.adapter = "playwright-generic";
    writeFileSync(join(p.root, "buildings.json"), JSON.stringify(config, null, 2));
    const browser = await p.run(stepNamed(SCRAPE_JOB, BROWSER), "schedule", {});
    expect(browser.code, browser.stderr).toBe(0);
    expect(browser.written).toBe("needed=true\n");
  });
});
