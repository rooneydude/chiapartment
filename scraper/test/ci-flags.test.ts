import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFlags, flagOutputs, refreshArgs, resolveRefreshFlags } from "../src/ci-flags";

const KNOWN = ["1225-old-town", "old-town-park-1", "the-leo", "stead-220"];
const ROOT = join(__dirname, "..", "..");

describe("what the refresh job is asked to do", () => {
  it("scrapes everything on a scheduled run — the case the old shell check rejected", () => {
    // 17 Nov 2026: an empty list of buildings failed the job before it
    // scraped anything. Empty is the normal case and means "all".
    const flags = resolveRefreshFlags({ event: "schedule", inputs: { buildings: "", capture: "", skyline: "" }, triggerText: null }, KNOWN);
    expect(flags).toEqual({ capture: false, skyline: false, buildings: [] });
    expect(refreshArgs(flags)).toBe("");
    expect(flagOutputs(flags)).toBe("capture=false\nskyline=false\nbuildings=\nrefresh_args=\n");
  });

  it("scrapes everything when the trigger file carries only comments — as the committed one does", () => {
    const committed = readFileSync(join(ROOT, ".github", "refresh-trigger"), "utf8");
    const flags = resolveRefreshFlags({ event: "push", triggerText: committed }, KNOWN);
    expect(flags).toEqual({ capture: false, skyline: false, buildings: [] });
  });

  it("reads the trigger file's words as flags, on a push only", () => {
    const text = "# retry the two that failed\ncapture skyline buildings=the-leo,stead-220\n";
    expect(resolveRefreshFlags({ event: "push", triggerText: text }, KNOWN)).toEqual({
      capture: true,
      skyline: true,
      buildings: ["the-leo", "stead-220"],
    });
    // each word is its own flag
    expect(resolveRefreshFlags({ event: "push", triggerText: "capture\n" }, KNOWN)).toEqual({ capture: true, skyline: false, buildings: [] });
    expect(resolveRefreshFlags({ event: "push", triggerText: "skyline\n" }, KNOWN)).toEqual({ capture: false, skyline: true, buildings: [] });
    // a scheduled or manual run must not inherit what somebody left in the file
    for (const event of ["schedule", "workflow_dispatch", ""]) {
      expect(resolveRefreshFlags({ event, triggerText: text }, KNOWN)).toEqual({
        capture: false,
        skyline: false,
        buildings: [],
      });
    }
  });

  it("matches flags as whole words", () => {
    const text = "recapture the skylines later; nobuildings=the-leo is not a flag either… but buildings=stead-220 is";
    const flags = resolveRefreshFlags({ event: "push", triggerText: text }, KNOWN);
    expect(flags.capture).toBe(false);
    expect(flags.skyline).toBe(false);
    // the first "buildings=…" wins, wherever it stands — as the shell's grep did
    expect(flags.buildings).toEqual(["the-leo"]);
  });

  it("takes a manual run's typed-in inputs, and lets them override the trigger file", () => {
    expect(
      resolveRefreshFlags(
        { event: "workflow_dispatch", inputs: { buildings: " the-leo, stead-220 ,the-leo,", capture: "true", skyline: "false" }, triggerText: null },
        KNOWN,
      ),
    ).toEqual({ capture: true, skyline: false, buildings: ["the-leo", "stead-220"] });
    expect(
      resolveRefreshFlags({ event: "workflow_dispatch", inputs: { buildings: "", capture: "false", skyline: "true" }, triggerText: null }, KNOWN),
    ).toEqual({ capture: false, skyline: true, buildings: [] });
    expect(
      resolveRefreshFlags({ event: "push", inputs: { buildings: "the-leo" }, triggerText: "buildings=stead-220" }, KNOWN).buildings,
    ).toEqual(["the-leo"]);
  });

  it("refuses a list that is not a list of building ids — whatever it is", () => {
    for (const bad of ["the-leo; rm -rf /", "The-Leo", "the leo", "$(id)", "a\nthe-leo", "the-leo\nx; y", "--capture", "-", "a--b", "../x"]) {
      expect(() => resolveRefreshFlags({ event: "workflow_dispatch", inputs: { buildings: bad }, triggerText: null })).toThrow(
        /not a list of building ids/,
      );
    }
  });

  it("refuses a building that does not exist, by name", () => {
    expect(() =>
      resolveRefreshFlags({ event: "workflow_dispatch", inputs: { buildings: "the-leo,the-loe" }, triggerText: null }, KNOWN),
    ).toThrow(/There is no building "the-loe". Known buildings: 1225-old-town, /);
    // without the list of known ids (it could not be read) the shape check still applies
    expect(resolveRefreshFlags({ event: "workflow_dispatch", inputs: { buildings: "the-loe" }, triggerText: null }).buildings).toEqual(["the-loe"]);
  });

  it("hands the scraper arguments that cannot be anything but its own flags", () => {
    const flags = resolveRefreshFlags(
      { event: "workflow_dispatch", inputs: { buildings: "the-leo,stead-220", capture: "true" }, triggerText: null },
      KNOWN,
    );
    expect(refreshArgs(flags)).toBe("--buildings=the-leo,stead-220 --capture");
    expect(flagOutputs(flags)).toBe(
      "capture=true\nskyline=false\nbuildings=the-leo,stead-220\nrefresh_args=--buildings=the-leo,stead-220 --capture\n",
    );
    // every output is one line: nothing typed in can add an output of its own
    for (const line of flagOutputs(flags).trimEnd().split("\n")) expect(line).toMatch(/^[a-z_]+=[a-z0-9,=\- ]*$/);
  });

  it("says in the log what it decided and from what", () => {
    const scheduled = { event: "schedule", triggerText: null };
    expect(describeFlags(scheduled, resolveRefreshFlags(scheduled))).toBe(
      "Refresh requested by a schedule run (no inputs): all buildings.",
    );
    const manual = { event: "workflow_dispatch", inputs: { buildings: "the-leo", capture: "true", skyline: "true" }, triggerText: null };
    expect(describeFlags(manual, resolveRefreshFlags(manual))).toBe(
      "Refresh requested by the typed-in inputs: buildings the-leo, saving raw responses, regenerating the skyline.",
    );
  });
});

describe("the workflow and the code it calls agree", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "refresh.yml"), "utf8");
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

  it("the workflow calls scripts that exist", () => {
    const called = [...workflow.matchAll(/npm run (?:-s )?([a-z:.-]+)/g)].map((m) => m[1]!);
    expect(called.length).toBeGreaterThan(3);
    for (const name of called) expect(scripts, `npm run ${name}`).toHaveProperty(name);
  });

  it("the workflow reads only outputs the flags step writes", () => {
    const written = flagOutputs({ capture: false, skyline: false, buildings: [] })
      .trimEnd()
      .split("\n")
      .map((line) => line.split("=")[0]);
    const read = [...workflow.matchAll(/steps\.flags\.outputs\.([a-z_]+)/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(written).toContain(name);
  });
});
