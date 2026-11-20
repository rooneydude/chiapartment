import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(readJob("refresh.yml", "scrape").keys).toEqual({ "runs-on": "ubuntu-latest", outputs: "", steps: "" });
    // The site is rebuilt after every scrape, by the deploy workflow.
    expect(readJob("refresh.yml", "deploy").keys).toEqual({ needs: "scrape", uses: "./.github/workflows/deploy.yml", permissions: "" });
    expect(readJob("refresh.yml", "health").keys).toEqual({
      needs: "scrape",
      if: "needs.scrape.outputs.ok == '0'",
      "runs-on": "ubuntu-latest",
      steps: "",
    });
  });

  it("the site is built by one command, whose first half this file runs", () => {
    expect(jobSteps("deploy.yml", "build").filter((s) => s.run !== null).map((s) => s.run)).toEqual(["npm ci", "npm run build"]);
    expect(scripts["build"]).toBe("npm run build:data && npm run -w web build");
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
