import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The step of the refresh job that commits the day's snapshot and pushes it,
 * run for real: a bare repository standing in for GitHub, a shallow clone
 * standing in for the runner's checkout, and a second clone for "something
 * else landed on the branch meanwhile" — a merged pull request, or another
 * refresh run that was already under way.
 *
 * The checkout holds the step's two scripts, as the real one does, and the
 * step is started the way the workflow starts it: `bash
 * .github/scripts/commit-snapshot.sh` from the checkout's root. So what
 * lands can change the very files the step is running — and some cases do.
 */
const ROOT = join(__dirname, "..", "..");
const SCRIPTS = ["commit-snapshot.sh", "merge-unitmap.mjs"];
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

const TODAY = "data/snapshots/2026-11-19T22-11-27Z.json";
const EARLIER = "data/snapshots/2026-11-19T22-05-00Z.json";
const MAP = "data/unitmaps/1225-old-town.json";

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
  mkdirSync(join(seed, ".github", "scripts"), { recursive: true });
  for (const script of SCRIPTS) copyFileSync(join(ROOT, ".github", "scripts", script), join(seed, ".github", "scripts", script));
  write(seed, "data/snapshots/2026-11-18T22-00-13Z.json", "{}\n");
  if (seeded.skyline !== false) write(seed, "data/skyline.geojson", "{}\n");
  write(seed, MAP, seeded.unitMap ?? '{"capturedAt":"2026-11-18"}\n');
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

/** Somebody else's change lands on the branch. */
function lands(other: string, message: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(other, path));
    else write(other, path, text);
  }
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "HEAD:main");
}

/** Run the step as the workflow does: from the checkout's root, the branch in GITHUB_REF_NAME. */
function commitResults(checkout: string, env: Record<string, string> = { GITHUB_REF_NAME: "main" }) {
  const result = spawnSync("bash", [".github/scripts/commit-snapshot.sh"], { cwd: checkout, env: { ...ISOLATED, ...env }, encoding: "utf8" });
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
const remoteFile = (origin: string, path: string): string => `${git(origin, "show", `main:${path}`)}\n`;
const subjects = (origin: string): string[] => git(origin, "log", "--format=%s", "main").split("\n");
/** Nothing half-done in the checkout: no change uncommitted, no rebase under way, no merge leftovers. */
function expectTidy(runner: string): void {
  expect(git(runner, "status", "--short")).toBe("");
  expect(existsSync(join(runner, ".git", "rebase-merge"))).toBe(false);
  expect(existsSync(join(runner, ".git", "rebase-apply"))).toBe(false);
}

describe("the refresh job's commit step", { timeout: 60_000 }, () => {
  it("is the script the workflow calls, with its merge program beside it", () => {
    for (const script of SCRIPTS) expect(existsSync(join(ROOT, ".github", "scripts", script)), script).toBe(true);
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "refresh.yml"), "utf8");
    expect(workflow).toContain("run: bash .github/scripts/commit-snapshot.sh");
  });

  describe("an ordinary run, nothing else landing", () => {
    it("does nothing, successfully, when the scrape changed nothing", () => {
      const { origin, runner } = world("nothing");
      const before = git(origin, "rev-parse", "main");
      const run = commitResults(runner);
      expect(run.code).toBe(0);
      expect(run.output).toContain("Nothing changed.");
      expect(git(origin, "rev-parse", "main")).toBe(before);
    });

    it("commits the new snapshot, the rewritten unit map and a newly recorded response, and pushes them", () => {
      const { origin, runner } = world("plain");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');
      write(runner, "scraper/fixtures/the-leo/page.html", "<html>captured</html>\n");
      write(runner, "web/dist/built.js", "not data: must not be committed\n");
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(remoteFile(origin, MAP)).toContain("2026-11-19");
      expect(remoteFile(origin, "scraper/fixtures/the-leo/page.html")).toBe("<html>captured</html>\n");
      expect(onRemote(origin, "web/dist/built.js")).toBe(false);
      expect(git(origin, "log", "-1", "--format=%an <%ae> | %s", "main")).toMatch(
        /^github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com> \| data: snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(run.output).not.toContain("::warning::");
    });

    it("pushes the snapshot even when the merging of unit maps cannot be set up", () => {
      // What is set up before the push only matters when something else lands
      // first. It must never be the reason an ordinary run commits nothing.
      const { origin, runner } = world("no-setup");
      rmSync(join(runner, ".git", "info"), { recursive: true, force: true });
      writeFileSync(join(runner, ".git", "info"), "in the way: a file where git keeps a folder\n");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(run.output).toContain("::warning::The merging of unit maps could not be set up.");
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(remoteFile(origin, MAP)).toContain("2026-11-19");
    });

    it("commits a file the run removed as removed", () => {
      const { origin, runner } = world("removed");
      rmSync(join(runner, "data", "skyline.geojson"));
      write(runner, TODAY, '{"today":true}\n');
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(onRemote(origin, "data/skyline.geojson")).toBe(false);
      expectTidy(runner);
    });

    it("refuses to guess the branch", () => {
      const { runner } = world("no-branch");
      write(runner, TODAY, "{}\n");
      const run = commitResults(runner, {});
      expect(run.code).not.toBe(0);
      expect(run.output).toContain("GITHUB_REF_NAME must name the branch to push to");
      expect(git(runner, "status", "--short")).toContain(TODAY);
    });
  });

  describe("something else landed during the scrape, and goes together with this run's files", () => {
    it("keeps the day's snapshot when a pull request is merged", () => {
      const { origin, runner, other } = world("race");
      write(runner, TODAY, '{"today":true}\n');
      lands(other, "a merge that landed during the scrape", { "data/snapshots/2026-11-19T15-00-00Z.json": '{"merged":true}\n', "README.md": "tracker, improved\n" });

      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(run.output).toContain("Push rejected (attempt 1); rebasing onto origin/main and trying again.");
      // both snapshots are on the branch, the other change is intact, and history is a straight line
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(onRemote(origin, "data/snapshots/2026-11-19T15-00-00Z.json")).toBe(true);
      expect(remoteFile(origin, "README.md")).toBe("tracker, improved\n");
      expect(subjects(origin).slice(1)).toEqual(["a merge that landed during the scrape", "seed"]);
      expect(git(origin, "rev-list", "--merges", "--count", "main")).toBe("0");
      expect(run.output).not.toContain("::warning::");
    });

    it("commits the snapshot and the unit map where there is no skyline file to add", () => {
      // The skyline step may fail without failing the job; on a first run that
      // leaves no file. That must not cost the run its unit map as well — nor,
      // by leaving it uncommitted, block the retry after a rejected push.
      const { origin, runner, other } = world("no-skyline", { skyline: false });
      expect(existsSync(join(runner, "data", "skyline.geojson"))).toBe(false);
      lands(other, "a merge that landed during the scrape", { "README.md": "tracker, improved\n" });
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(remoteFile(origin, MAP)).toContain("2026-11-19");
      expectTidy(runner);
    });

    it("keeps what both runs learned when another refresh run lands first", () => {
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
      lands(other, "data: snapshot 2026-11-19T22:05:00Z", {
        [EARLIER]: '{"firstRun":true}\n',
        [MAP]: unitMap("2026-11-19T22:05:00Z", { "1014": "N", "2203": "W", "0704": "S", "0812": "N" }),
      });
      // This run, a few minutes later: 0812 was let again and is not in its
      // list, 0915 and 1503 are newly listed, and it too placed 2203 afresh.
      write(runner, TODAY, '{"secondRun":true}\n');
      write(runner, MAP, unitMap("2026-11-19T22:11:27Z", { "1014": "N", "2203": "SW", "0704": "S", "0915": "W", "1503": "E" }));

      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(run.output).toContain("Push rejected (attempt 1)");
      expect(run.output).not.toContain("::warning::");
      // both runs' snapshots are on the branch…
      expect(onRemote(origin, EARLIER)).toBe(true);
      expect(onRemote(origin, TODAY)).toBe(true);
      // …and the unit map holds what both learned: the first run's 0812 is not
      // lost (neither "this run's file" nor a line-by-line merge gives this),
      // this run's 0915 and 1503 are there, 2203 is as this, the later, run
      // placed it, and the file says it was captured when this run captured
      // it. Byte for byte, in the order the generator would leave them: the
      // units the branch already had, then this run's new ones.
      expect(remoteFile(origin, MAP)).toBe(
        unitMap("2026-11-19T22:11:27Z", { "1014": "N", "2203": "SW", "0704": "S", "0812": "N", "0915": "W", "1503": "E" }),
      );
      expect(Object.keys((JSON.parse(remoteFile(origin, MAP)) as { units: object }).units)).toEqual(["1014", "1503", "2203", "0704", "0812", "0915"]);
      // …on a straight line of history, with nothing left half-done in the checkout.
      expect(subjects(origin).slice(1)).toEqual(["data: snapshot 2026-11-19T22:05:00Z", "seed"]);
      expect(git(origin, "rev-list", "--merges", "--count", "main")).toBe("0");
      expectTidy(runner);
    });

    it("still merges when what landed removed the merge program and replaced this very script", () => {
      // The retry checks out what landed while this script is running. It is
      // this run's copy of both that has to finish the job.
      const { origin, runner, other } = world("scripts-replaced", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
      lands(other, "data: snapshot 2026-11-19T22:05:00Z, and the scripts rewritten", {
        [EARLIER]: '{"firstRun":true}\n',
        [MAP]: unitMap("2026-11-19T22:05:00Z", { "1014": "N", "0812": "N" }),
        ".github/scripts/merge-unitmap.mjs": null,
        ".github/scripts/commit-snapshot.sh": `${"echo SOMETHING ELSE ENTIRELY; exit 42\n".repeat(300)}`,
      });
      write(runner, TODAY, '{"secondRun":true}\n');
      write(runner, MAP, unitMap("2026-11-19T22:11:27Z", { "1014": "N", "1503": "E" }));

      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(run.output).not.toContain("SOMETHING ELSE ENTIRELY");
      expect(remoteFile(origin, MAP)).toBe(unitMap("2026-11-19T22:11:27Z", { "1014": "N", "0812": "N", "1503": "E" }));
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(onRemote(origin, ".github/scripts/merge-unitmap.mjs")).toBe(false); // what landed stays as it landed
    });

    it("merges in a checkout whose path holds a space and a per-cent sign", () => {
      const { origin, runner, other } = world("odd pct%Apath", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
      lands(other, "data: snapshot 2026-11-19T22:05:00Z", { [EARLIER]: '{"firstRun":true}\n', [MAP]: unitMap("2026-11-19T22:05:00Z", { "1014": "N", "0812": "N" }) });
      write(runner, TODAY, '{"secondRun":true}\n');
      write(runner, MAP, unitMap("2026-11-19T22:11:27Z", { "1014": "N", "1503": "E" }));
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(remoteFile(origin, MAP)).toBe(unitMap("2026-11-19T22:11:27Z", { "1014": "N", "0812": "N", "1503": "E" }));
    });

    it("merges where the checkout is a linked worktree, whose settings git keeps elsewhere", () => {
      const { origin, other } = world("worktree", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
      const dir = dirname(origin);
      git(dir, "clone", "-q", `file://${origin}`, join(dir, "main-checkout"));
      const runner = join(dir, "job");
      git(join(dir, "main-checkout"), "worktree", "add", "-q", "-b", "job", runner, "origin/main");
      lands(other, "data: snapshot 2026-11-19T22:05:00Z", { [EARLIER]: '{"firstRun":true}\n', [MAP]: unitMap("2026-11-19T22:05:00Z", { "1014": "N", "0812": "N" }) });
      write(runner, TODAY, '{"secondRun":true}\n');
      write(runner, MAP, unitMap("2026-11-19T22:11:27Z", { "1014": "N", "1503": "E" }));
      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(run.output).not.toContain("::warning::");
      expect(remoteFile(origin, MAP)).toBe(unitMap("2026-11-19T22:11:27Z", { "1014": "N", "0812": "N", "1503": "E" }));
    });

    it("takes this run's skyline whole when both runs regenerated it", () => {
      const { origin, runner, other } = world("two-skylines");
      lands(other, "data: snapshot 2026-11-19T22:05:00Z", { [EARLIER]: '{"firstRun":true}\n', "data/skyline.geojson": '{"generated":"22:05","features":[1,2,3]}\n' });
      write(runner, TODAY, '{"secondRun":true}\n');
      write(runner, "data/skyline.geojson", '{"generated":"22:11","features":[1,2]}\n');

      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(remoteFile(origin, "data/skyline.geojson")).toBe('{"generated":"22:11","features":[1,2]}\n');
      expect(onRemote(origin, EARLIER)).toBe(true);
      expect(onRemote(origin, TODAY)).toBe(true);
    });

    it("leaves alone what only the other side changed", () => {
      // A pull request that corrects the unit map and the skyline is merged
      // during a run whose unit-map and skyline steps wrote nothing.
      const { origin, runner, other } = world("theirs-only", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N" }) });
      const corrected = unitMap("2026-11-18T22:00:13Z", { "1014": "E" });
      lands(other, "correct the unit map", { [MAP]: corrected, "data/skyline.geojson": '{"corrected":true}\n' });
      write(runner, TODAY, '{"today":true}\n');

      const run = commitResults(runner);
      expect(run.code, run.output).toBe(0);
      expect(remoteFile(origin, MAP)).toBe(corrected);
      expect(remoteFile(origin, "data/skyline.geojson")).toBe('{"corrected":true}\n');
      expect(onRemote(origin, TODAY)).toBe(true);
    });
  });

  describe("what landed does not go together with this run's other files: the prices are pushed on their own", () => {
    /** The day's snapshot is on the branch, on top of what landed, and the run's page says what was left out. */
    function expectPricesAlone(run: { code: number | null; output: string }, origin: string, runner: string, landed: string, leftOut: string): void {
      expect(run.code, run.output).toBe(0);
      expect(run.output).toContain(`::warning::Today's prices are being pushed on their own. This run's other files (${leftOut}) could not be put together`);
      // built straight on what landed: the push after it goes through, no second round
      expect(run.output.match(/Push rejected/g)).toHaveLength(1);
      expect(onRemote(origin, TODAY)).toBe(true);
      expect(subjects(origin)[0]).toMatch(/^data: snapshot /);
      expect(git(origin, "rev-parse", "main~1")).toBe(landed);
      // the commit that went on top adds the snapshot and touches nothing else
      expect(git(origin, "diff", "--name-status", "main~1", "main")).toBe(`A\t${TODAY}`);
      expectTidy(runner);
    }

    it("when the unit map that landed cannot be read", () => {
      // A hand edit with a stray comma. git's own line-by-line merge would
      // have gone through (the two changes are far apart) and kept a file no
      // program can read; nothing is gained by joining this run's map to it.
      const { origin, runner, other } = world("unreadable", { unitMap: unitMap("2026-11-18T22:00:13Z", { "1014": "N", "2203": "E", "0704": "S" }) });
      const broken = unitMap("2026-11-18T22:00:13Z", { "1014": "N", "2203": "E", "0704": "S" }).replace('"facing": "N"', '"facing": "N",,');
      lands(other, "a broken edit", { [MAP]: broken });
      const landed = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, unitMap("2026-11-19T22:11:27Z", { "1014": "N", "2203": "E", "0704": "S", "1503": "E" }));

      const run = commitResults(runner);
      expect(run.output).toContain("merge-unitmap: the file on the branch is not JSON");
      expectPricesAlone(run, origin, runner, landed, MAP);
      expect(remoteFile(origin, MAP)).toBe(broken); // as it landed: not this run's to repair
    });

    it("when a pull request removed the unit map this run rewrote", () => {
      const { origin, runner, other } = world("removed-by-them");
      lands(other, "unit maps move elsewhere", { [MAP]: null });
      const landed = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');

      const run = commitResults(runner);
      expectPricesAlone(run, origin, runner, landed, MAP);
      expect(onRemote(origin, MAP)).toBe(false); // stays removed
    });

    it("when a recorded response was changed on both sides", () => {
      const { origin, runner, other } = world("fixture-both");
      lands(other, "new recorded responses", { "scraper/fixtures/keep.txt": "recorded responses, re-recorded by a pull request\n" });
      const landed = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, "scraper/fixtures/keep.txt", "recorded responses, captured by this run\n");
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');

      const run = commitResults(runner);
      // all of this run's other files are left out together, the unit map included: one commit, or the snapshot alone
      expectPricesAlone(run, origin, runner, landed, `${MAP} scraper/fixtures/keep.txt`);
      expect(remoteFile(origin, "scraper/fixtures/keep.txt")).toBe("recorded responses, re-recorded by a pull request\n");
      expect(remoteFile(origin, MAP)).toContain("2026-11-18");
    });
  });

  describe("the snapshot itself cannot go on top: the step fails, having pushed nothing", () => {
    it("when a snapshot of the same name is already on the branch — one is never rewritten", () => {
      const { origin, runner, other } = world("same-name");
      lands(other, "data: snapshot 2026-11-19T22:11:27Z", { [TODAY]: '{"theirs":true}\n' });
      const landed = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"mine":true}\n');

      const run = commitResults(runner);
      expect(run.code).toBe(1);
      expect(run.output).toContain("::error::Today's snapshot could not be put on top of what landed on main during the scrape");
      expect(run.output).toContain("Start a new run");
      expect(git(origin, "rev-parse", "main")).toBe(landed);
      expect(remoteFile(origin, TODAY)).toBe('{"theirs":true}\n');
      // the checkout is left with this run's commit, for whoever looks
      expect(git(runner, "log", "-1", "--format=%s")).toMatch(/^data: snapshot /);
      expect(git(runner, "show", `HEAD:${TODAY}`)).toBe('{"mine":true}');
      expectTidy(runner);
    });

    it("when the commit of the snapshot alone cannot be made — and leaves this run's own commit in the checkout", () => {
      const { origin, runner, other } = world("no-second-commit");
      lands(other, "unit maps move elsewhere", { [MAP]: null });
      const landed = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"today":true}\n');
      write(runner, MAP, '{"capturedAt":"2026-11-19"}\n');
      // a checkout in which a first commit can be made and a second cannot
      const hook = join(runner, ".git", "hooks", "pre-commit");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, '#!/bin/sh\nif [ -e "$(git rev-parse --git-dir)/one-commit-made" ]; then echo "no second commit here" >&2; exit 1; fi\ntouch "$(git rev-parse --git-dir)/one-commit-made"\n');
      chmodSync(hook, 0o755);

      const run = commitResults(runner);
      expect(run.code).toBe(1);
      expect(run.output).toContain("no second commit here");
      expect(run.output).toContain("::error::Today's snapshot could not be put on top of what landed on main during the scrape");
      expect(git(origin, "rev-parse", "main")).toBe(landed);
      expect(git(runner, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([TODAY, MAP].sort());
      expectTidy(runner);
    });

    it("when the remote keeps refusing", () => {
      const { origin, runner } = world("refused");
      const hook = join(origin, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho 'this remote takes no pushes' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      const before = git(origin, "rev-parse", "main");
      write(runner, TODAY, '{"today":true}\n');

      const run = commitResults(runner);
      expect(run.code).toBe(1);
      expect(run.output).toContain("Push rejected (attempt 2); rebasing");
      expect(run.output).toContain("Push rejected (attempt 3).");
      expect(run.output).toContain("::error::Could not push today's snapshot after 3 attempts.");
      expect(git(origin, "rev-parse", "main")).toBe(before);
      expect(git(runner, "log", "-1", "--format=%s")).toMatch(/^data: snapshot /);
    });
  });
});
