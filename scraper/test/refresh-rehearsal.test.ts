import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SnapshotSchema, type BuildingHistory, type CompiledConfig, type Snapshot } from "../../shared/src/types";
import { runAlerts } from "../src/alerts";
import { buildData } from "../src/build-data";
import { flagOutputs, refreshArgs, resolveRefreshFlags } from "../src/ci-flags";
import { describeRun, loadConfig, refresh } from "../src/run";

/**
 * The whole "Refresh prices" job, rehearsed offline: the same code the
 * workflow's steps call, in the same order, against the recorded responses
 * instead of the live sites, in a throwaway copy of the project.
 *
 * Each piece has its own tests. This one exists because the pieces had never
 * been run together before a merge: a change that would stop the daily
 * refresh fails here, on the pull request, not at the next scheduled run.
 */
const REPO = join(__dirname, "..", "..");
const ROOT = mkdtempSync(join(tmpdir(), "chiapartment-rehearsal-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const compiled = <T>(path: string): T =>
  JSON.parse(readFileSync(join(ROOT, "web", "public", "data", path), "utf8")) as T;

describe("the refresh job, rehearsed offline from start to finish", { timeout: 180_000 }, () => {
  it("works out what to do, reads every building, alerts on a real change and compiles the site's data", async () => {
    // What the runner's checkout holds, as far as the job reads it.
    copyFileSync(join(REPO, "buildings.json"), join(ROOT, "buildings.json"));
    mkdirSync(join(ROOT, "scraper"), { recursive: true });
    symlinkSync(join(REPO, "scraper", "fixtures"), join(ROOT, "scraper", "fixtures"), "dir");
    mkdirSync(join(ROOT, "data", "snapshots"), { recursive: true });
    const ids = loadConfig(ROOT).buildings.map((b) => b.id);
    expect(ids).toHaveLength(6);

    // Step "Resolve flags": a scheduled run asks for everything.
    const flags = resolveRefreshFlags({ event: "schedule", inputs: { buildings: "", capture: "", skyline: "" }, triggerText: null }, ids);
    expect(flagOutputs(flags)).toBe("capture=false\nskyline=false\nbuildings=\nrefresh_args=\n");
    expect(refreshArgs(flags)).toBe("");

    // Step "Scrape": every building, from its recorded responses.
    const file = await refresh(ROOT, {
      fixtures: true,
      capture: flags.capture,
      commit: false,
      buildings: flags.buildings.length > 0 ? flags.buildings : null,
    });
    expect(existsSync(file)).toBe(true);
    const today: Snapshot = SnapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const run = describeRun(today);
    expect({ ok: run.ok, total: run.total, failed: run.failed }).toEqual({ ok: 6, total: 6, failed: [] });
    expect(run.markdown).toContain("1225-old-town");
    const b1225 = today.buildings.find((b) => b.buildingId === "1225-old-town")!;
    expect(b1225.units.length).toBeGreaterThanOrEqual(10);
    expect(b1225.units.every((u) => (u.leaseTerms?.length ?? 0) > 1 && u.availableDate !== null)).toBe(true);
    for (const b of today.buildings) expect(b.alsoListed, b.buildingId).toBeDefined();

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
    writeFileSync(
      join(ROOT, "data", "snapshots", `${yesterday.timestamp.replaceAll(":", "-")}.json`),
      JSON.stringify(yesterday),
    );

    // Step "Price alerts": exactly that change, said the way the alert says it.
    const out = join(ROOT, "alert-out");
    mkdirSync(out);
    expect(runAlerts(ROOT, out)).toBe(true);
    const title = readFileSync(join(out, "alert-title.txt"), "utf8");
    const body = readFileSync(join(out, "alert-body.md"), "utf8");
    expect(title).toMatch(/1 drop/);
    expect(body).toContain(`#${repriced.unitNumber}`);
    expect(body).toContain("▼$100");
    expect(body).not.toContain("New listings");
    expect(body).not.toContain("Scrape problems");

    // The deploy job's "npm run build", first half: the site's data.
    buildData(ROOT);
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
    expect(existsSync(join(ROOT, "web", "public", "data", "brief.json"))).toBe(true);
    // nothing was written outside the throwaway copy's own data folders
    expect(basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
  });
});
