/**
 * What the "Refresh prices" job is being asked to do, worked out from how it
 * was started.
 *
 * This used to be a dozen lines of shell inside the workflow. One of them
 * rejected the normal case — no list of buildings — so on 17 Nov 2026 the job
 * stopped before scraping anything, and every scheduled run would have too.
 * Nothing tested that shell. It lives here instead: typed, covered by
 * `npm test`, and the workflow step that calls it is a single command.
 *
 * The rules, unchanged:
 * - A manual run takes its typed-in inputs.
 * - A run started by committing a change to `.github/refresh-trigger` takes
 *   that file's words as flags: `capture`, `skyline`, `buildings=a,b`.
 *   Only a push run reads the file — a scheduled or manual run must not
 *   inherit flags somebody left in it.
 * - No list of buildings means all of them.
 */

export interface RefreshRequest {
  /** How the job was started: GitHub's event name ("push", "schedule", "workflow_dispatch"). */
  event: string;
  /** What was typed into a manual run. Absent or empty otherwise. */
  inputs?: {
    buildings?: string | undefined;
    capture?: string | undefined;
    skyline?: string | undefined;
  };
  /** The text of `.github/refresh-trigger`, or null when there is no such file. */
  triggerText: string | null;
}

export interface RefreshFlags {
  /** Save the raw responses as fixtures. */
  capture: boolean;
  /** Regenerate the skyline. */
  skyline: boolean;
  /** Buildings to scrape; empty = all of them. */
  buildings: string[];
}

/** A building id as the config writes them: lower-case letters, digits and dashes. */
const BUILDING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const hasWord = (text: string, word: string): boolean => new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`).test(text);

/**
 * @param knownIds the ids in buildings.json. When given, a building that is
 *   not one of them is refused here, by name, rather than silently scraping
 *   nothing.
 * @throws when the list of buildings is not a list of building ids.
 */
export function resolveRefreshFlags(req: RefreshRequest, knownIds?: readonly string[]): RefreshFlags {
  const trigger = req.event === "push" ? (req.triggerText ?? "") : "";
  const typed = (req.inputs?.buildings ?? "").trim();
  // The first `buildings=…` in the trigger file, when nothing was typed in.
  const fromTrigger = /buildings=([a-z0-9,-]+)/.exec(trigger)?.[1] ?? "";
  const raw = typed !== "" ? typed : fromTrigger;

  const buildings: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "") continue; // "a,,b" and a trailing comma are just untidy
    if (!BUILDING_ID.test(id)) {
      throw new Error(
        `The list of buildings is not a list of building ids: ${JSON.stringify(part)}. Ids are lower-case letters, digits and dashes, separated by commas.`,
      );
    }
    if (knownIds && !knownIds.includes(id)) {
      throw new Error(`There is no building "${id}". Known buildings: ${knownIds.join(", ")}.`);
    }
    if (!buildings.includes(id)) buildings.push(id);
  }

  return {
    capture: req.inputs?.capture === "true" || hasWord(trigger, "capture"),
    skyline: req.inputs?.skyline === "true" || hasWord(trigger, "skyline"),
    buildings,
  };
}

/** The arguments `npm run refresh --` gets for these flags; "" for a plain scrape of everything. */
export function refreshArgs(flags: RefreshFlags): string {
  return [
    ...(flags.buildings.length > 0 ? [`--buildings=${flags.buildings.join(",")}`] : []),
    ...(flags.capture ? ["--capture"] : []),
  ].join(" ");
}

/** The step outputs the workflow reads, one `name=value` per line. */
export function flagOutputs(flags: RefreshFlags): string {
  return [
    `capture=${flags.capture}`,
    `skyline=${flags.skyline}`,
    `buildings=${flags.buildings.join(",")}`,
    `refresh_args=${refreshArgs(flags)}`,
    "",
  ].join("\n");
}

/** One line for the job's log saying what was decided, and from what. */
export function describeFlags(req: RefreshRequest, flags: RefreshFlags): string {
  const source =
    req.event === "push"
      ? "the trigger file"
      : req.event === "workflow_dispatch"
        ? "the typed-in inputs"
        : `a ${req.event || "local"} run (no inputs)`;
  return `Refresh requested by ${source}: ${
    flags.buildings.length > 0 ? `buildings ${flags.buildings.join(", ")}` : "all buildings"
  }${flags.capture ? ", saving raw responses" : ""}${flags.skyline ? ", regenerating the skyline" : ""}.`;
}
