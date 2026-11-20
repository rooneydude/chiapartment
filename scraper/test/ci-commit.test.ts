import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The step of the refresh job that commits the day's snapshot and pushes it,
 * run for real: a bare repository standing in for GitHub, a shallow clone
 * standing in for the runner's checkout, and a second clone for "something
 * else landed on the branch meanwhile" — a merged pull request, or another
 * refresh run that was already under way.
 */
const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "commit-snapshot.sh");
const SANDBOX = mkdtempSync(join(tmpdir(), "chiapartment-commit-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

// Nothing from the machine's own git set-up (signing, hooks, URL rewrites) reaches these repositories.
const ISOLATED = {
  PATH: process.env["PATH"] ?? "",
  HOME: SANDBOX,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const SOMEONE = {
  ...ISOLATED,
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "someone@example.invalid",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "someone@example.invalid",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: SOMEONE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** A unit map the way the job writes one: indented, a line or more per fact. Units as number → the side it faces. */
const unitMap = (capturedAt: string, units: Record<string, string>): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      buildingId: "1225-old-town",
      source: { capturedAt },
      units: Object.fromEntries(Object.entries(units).map(([unit, facing]) => [unit, { facing }])),
    },
    null,
    2,
  )}\n`;

/** A remote with one snapshot already on `main`, the runner's checkout of it, and somebody else's. */
function world(
  name: string,
  seeded: { unitMap?: string; skyline?: boolean } = {},
): { origin: string; runner: string; other: string } {
  const dir = join(SANDBOX, name);
  const origin = join(dir, "origin.git");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(dir, "seed");
  git(dir, "init", "-q", "-b", "main", seed);
  write(seed, "data/snapshots/2026-11-18T22-00-13Z.json", "{}\n");
  if (seeded.skyline !== false) write(seed, "data/skyline.geojson", "{}\n");
  write(seed, "data/unitmaps/1225-old-town.json", seeded.unitMap ?? '{"capturedAt":"2026-11-18"}\n');
  write(seed, "scraper/fixtures/keep.txt", "recorded responses\n");
  write(seed, "README.md", "tracker\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", origin, "HEAD:main");
  // GitHub's checkout is shallow: one commit deep.
  const runner = join(dir, "runner");
  git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, runner);
  const other = join(dir, "other");
  git(dir, "clone", "-q", `file://${origin}`, other);
  return { origin, runner, other };
}

/** Run the step as the workflow does: `bash <script>` in the checkout, the branch in GITHUB_REF_NAME. */
function commitResults(checkout: string, env: Record<string, string> = { GITHUB_REF_NAME: "main" }) {
  const result = spawnSync("bash", [SCRIPT], { cwd: checkout, env: { ...ISOLATED, ...env }, encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const onRemote = (origin: string, path: string): boolean => {
  try {
    git(origin, "cat-file", "-e", `main:${path}`);
    return true;
  } catch {
    return false;
  }
};

describe("the refresh job's commit step", { timeout: 60_000 }, () => {
  it("is a script the workflow calls", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "refresh.yml"), "utf8");
    expect(workflow).toContain("bash .github/scripts/commit-snapshot.sh");
  });

  it("does nothing, successfully, when the scrape changed nothing", () => {
    const { origin, runner } = world("nothing");
    const before = git(origin, "rev-parse", "main");
    const run = commitResults(runner);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Nothing changed.");
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("commits the new snapshot and the rewritten unit map, and pushes them", () => {
    const { origin, runner } = world("plain");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');
    write(runner, "data/unitmaps/1225-old-town.json", '{"capturedAt":"2026-11-19"}\n');
    write(runner, "web/dist/built.js", "not data: must not be committed\n");
    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
    expect(git(origin, "show", "main:data/unitmaps/1225-old-town.json")).toContain("2026-11-19");
    expect(onRemote(origin, "web/dist/built.js")).toBe(false);
    expect(git(origin, "log", "-1", "--format=%an <%ae> | %s", "main")).toMatch(
      /^github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com> \| data: snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("commits the snapshot and the unit map where there is no skyline file to add", () => {
    // The skyline step may fail without failing the job; on a first run that
    // leaves no file. That must not cost the run its unit map as well — nor,
    // by leaving it uncommitted, block the retry after a rejected push.
    const { origin, runner, other } = world("no-skyline", { skyline: false });
    expect(existsSync(join(runner, "data", "skyline.geojson"))).toBe(false);
    write(other, "README.md", "tracker, improved\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "a merge that landed during the scrape");
    git(other, "push", "-q", "origin", "HEAD:main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');
    write(runner, "data/unitmaps/1225-old-town.json", '{"capturedAt":"2026-11-19"}\n');
    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
    expect(git(origin, "show", "main:data/unitmaps/1225-old-town.json")).toContain("2026-11-19");
    expect(git(runner, "status", "--short")).toBe("");
  });

  it("keeps the day's snapshot when a pull request is merged during the scrape", () => {
    const { origin, runner, other } = world("race");
    // The scrape has run: the runner has today's snapshot, uncommitted…
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');
    // …and meanwhile a pull request is merged, with a snapshot of its own.
    write(other, "data/snapshots/2026-11-19T15-00-00Z.json", '{"merged":true}\n');
    write(other, "README.md", "tracker, improved\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "a merge that landed during the scrape");
    git(other, "push", "-q", "origin", "HEAD:main");

    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain("Push rejected (attempt 1); rebasing onto origin/main and trying again.");
    // both snapshots are on the branch, the other change is intact, and history is a straight line
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
    expect(onRemote(origin, "data/snapshots/2026-11-19T15-00-00Z.json")).toBe(true);
    expect(git(origin, "show", "main:README.md")).toBe("tracker, improved");
    expect(git(origin, "log", "--format=%s", "main").split("\n").slice(1)).toEqual([
      "a merge that landed during the scrape",
      "seed",
    ]);
    expect(git(origin, "rev-list", "--merges", "--count", "main")).toBe("0");
  });

  it("keeps the day's snapshot, and what both runs learned, when another refresh run lands first", () => {
    // Every run rewrites the unit map (it carries the time it was captured),
    // so two runs that overlap always change the same line of the same file.
    // And a unit map accumulates: a unit's position can only be learned while
    // the unit is listed, so each run adds what it saw to what it was handed.
    // What both runs were checked out with: yesterday's unit map.
    const { origin, runner, other } = world("two-runs", {
      unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N", "2203": "E", "0704": "S" }),
    });
    // The run that was already under way saw unit 0812 newly listed and
    // placed 2203 afresh. Its snapshot and its unit map are pushed first.
    write(other, "data/snapshots/2026-11-19T22-05-00Z.json", '{"firstRun":true}\n');
    write(other, "data/unitmaps/1225-old-town.json", unitMap("2026-11-19T22:05:00Z", { "1014": "N", "2203": "W", "0704": "S", "0812": "N" }));
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "data: snapshot 2026-11-19T22:05:00Z");
    git(other, "push", "-q", "origin", "HEAD:main");
    // This run, a few minutes later: 0812 was let again and is not in its
    // list, 1503 is newly listed, and it too placed 2203 afresh.
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"secondRun":true}\n');
    write(runner, "data/unitmaps/1225-old-town.json", unitMap("2026-11-19T22:11:27Z", { "1014": "N", "2203": "SW", "0704": "S", "1503": "E" }));

    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain("Push rejected (attempt 1)");
    // both runs' snapshots are on the branch…
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-05-00Z.json")).toBe(true);
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
    // …and the unit map holds what both learned: the first run's 0812 is not
    // lost (neither "this run's file" nor a line-by-line merge gives this),
    // this run's 1503 is there, 2203 is as this, the later, run placed it,
    // and the file says it was captured when this run captured it.
    expect(`${git(origin, "show", "main:data/unitmaps/1225-old-town.json")}\n`).toBe(
      unitMap("2026-11-19T22:11:27Z", { "1014": "N", "2203": "SW", "0704": "S", "0812": "N", "1503": "E" }),
    );
    // …on a straight line of history, with nothing left half-done in the checkout.
    expect(git(origin, "log", "--format=%s", "main").split("\n").slice(1)).toEqual(["data: snapshot 2026-11-19T22:05:00Z", "seed"]);
    expect(git(origin, "rev-list", "--merges", "--count", "main")).toBe("0");
    expect(git(runner, "status", "--short")).toBe("");
    expect(existsSync(join(runner, ".git", "rebase-merge"))).toBe(false);
  });

  it("takes this run's skyline whole when both runs regenerated it", () => {
    const { origin, runner, other } = world("two-skylines");
    write(other, "data/snapshots/2026-11-19T22-05-00Z.json", '{"firstRun":true}\n');
    write(other, "data/skyline.geojson", '{"generated":"22:05","features":[1,2,3]}\n');
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "data: snapshot 2026-11-19T22:05:00Z");
    git(other, "push", "-q", "origin", "HEAD:main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"secondRun":true}\n');
    write(runner, "data/skyline.geojson", '{"generated":"22:11","features":[1,2]}\n');

    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(git(origin, "show", "main:data/skyline.geojson")).toBe('{"generated":"22:11","features":[1,2]}');
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-05-00Z.json")).toBe(true);
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
  });

  it("leaves alone what only the other side changed", () => {
    // A pull request that corrects the unit map and the skyline is merged
    // during a run whose unit-map and skyline steps wrote nothing.
    const { origin, runner, other } = world("theirs-only", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
    const corrected = unitMap("2026-11-18T22:00:13Z", { "1014": "E" });
    write(other, "data/unitmaps/1225-old-town.json", corrected);
    write(other, "data/skyline.geojson", '{"corrected":true}\n');
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "correct the unit map");
    git(other, "push", "-q", "origin", "HEAD:main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');

    const run = commitResults(runner);
    expect(run.code, run.output).toBe(0);
    expect(`${git(origin, "show", "main:data/unitmaps/1225-old-town.json")}\n`).toBe(corrected);
    expect(git(origin, "show", "main:data/skyline.geojson")).toBe('{"corrected":true}');
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(true);
  });

  it("stops, pushing nothing, when the unit map that landed cannot be read", () => {
    const { origin, runner, other } = world("unreadable", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
    write(other, "data/unitmaps/1225-old-town.json", '{"units": {"1014": \n');
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "a broken edit");
    git(other, "push", "-q", "origin", "HEAD:main");
    const landed = git(origin, "rev-parse", "main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');
    write(runner, "data/unitmaps/1225-old-town.json", unitMap("2026-11-19T22:11:27Z", { "1014": "N", "1503": "E" }));

    const run = commitResults(runner);
    expect(run.code).toBe(1);
    expect(run.output).toContain("merge-unitmap: the file on the branch is not JSON");
    expect(run.output).toContain("::error::Today's snapshot could not be put on top of what landed on main during the scrape");
    expect(git(origin, "rev-parse", "main")).toBe(landed);
    expect(git(runner, "status", "--short")).toBe("");
  });

  it("stops, pushing nothing, when what landed cannot be put together with this run's files", () => {
    // Not something the refresh job does to itself: a pull request that
    // removes the unit map lands while this run has just rewritten it.
    const { origin, runner, other } = world("cannot-combine");
    git(other, "rm", "-q", "data/unitmaps/1225-old-town.json");
    git(other, "commit", "-q", "-m", "unit maps move elsewhere");
    git(other, "push", "-q", "origin", "HEAD:main");
    const landed = git(origin, "rev-parse", "main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');
    write(runner, "data/unitmaps/1225-old-town.json", '{"capturedAt":"2026-11-19"}\n');

    const run = commitResults(runner);
    expect(run.code).toBe(1);
    expect(run.output).toContain("::error::Today's snapshot could not be put on top of what landed on main during the scrape");
    expect(git(origin, "rev-parse", "main")).toBe(landed); // nothing half-merged was pushed
    expect(onRemote(origin, "data/snapshots/2026-11-19T22-11-27Z.json")).toBe(false);
    // the checkout is left as it was before the retry: this run's commit, nothing half-done
    expect(git(runner, "log", "-1", "--format=%s")).toMatch(/^data: snapshot /);
    expect(existsSync(join(runner, ".git", "rebase-merge"))).toBe(false);
    expect(git(runner, "status", "--short")).toBe("");
  });

  it("fails loudly, with the snapshot still committed locally, when the remote keeps refusing", () => {
    const { origin, runner } = world("refused");
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'this remote takes no pushes' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const before = git(origin, "rev-parse", "main");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", '{"today":true}\n');

    const run = commitResults(runner);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Push rejected (attempt 3)");
    expect(run.output).toContain("::error::Could not push today's snapshot after 3 attempts.");
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(git(runner, "log", "-1", "--format=%s")).toMatch(/^data: snapshot /);
  });

  it("refuses to guess the branch", () => {
    const { runner } = world("no-branch");
    write(runner, "data/snapshots/2026-11-19T22-11-27Z.json", "{}\n");
    const run = commitResults(runner, {});
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("GITHUB_REF_NAME must name the branch to push to");
    expect(git(runner, "status", "--short")).toContain("data/snapshots/2026-11-19T22-11-27Z.json");
  });
});
