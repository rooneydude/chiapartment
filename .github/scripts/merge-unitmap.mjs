#!/usr/bin/env node
// Puts two versions of a unit map (data/unitmaps/<building>.json) together.
//
// Used by commit-snapshot.sh as git's merge driver for those files:
//
//   node merge-unitmap.mjs <base> <landed> <mine> [<name of the file>]
//
//   base    the file as both sides started from it (empty: neither had one)
//   landed  what is on the branch now — the result is written back to this file
//   mine    what this run wrote
//
// A unit map is not regenerated each run: it accumulates. A unit's position
// can only be learned while that unit is listed, so every run keeps the
// positions it was handed and adds what it saw (scraper/src/unitmap.ts). Two
// runs that overlap have each added to the same starting file, and the
// result has to hold what both learned:
//
//   - a unit only one side added or changed: that side's entry;
//   - a unit both changed: this run's (it is the later capture);
//   - a unit one side removed and the other left alone: removed — no run
//     does that, so it was done on purpose;
//   - everything else in the file (when and from what it was captured, the
//     fit): this run's.
//
// Where the two cannot be merged — one of them is not a readable unit map,
// they are for different buildings, or in different versions of the format —
// nothing is guessed at and nothing is held up: the file that landed is
// left exactly as it is, this run's version of it is dropped, and a warning
// for the run's page says so. Positions are a bonus; the day's prices are in
// another file, and this program does not stand in their way. (The exit
// status is 0 in that case too: to git a non-zero status is a conflict, and
// a conflict stops the commit.) The warning says what this program did and
// no more — whether the prices were pushed is for the commit step to say.
//
// Only a wrong call, or a file that cannot be read from disk at all, ends
// with a non-zero status.
//
// A program and nothing else: it has no exports, so that there is no way to
// start it that does not do the merge. scraper/test/ci-unitmap-merge.test.ts
// runs it as git does.
import { readFileSync, writeFileSync } from "node:fs";

const isRecord = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/** Why two unit maps cannot be merged. Not a failure of the program. */
class CannotMerge extends Error {}

function parseUnitMap(text, what) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CannotMerge(`${what} is not JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.units)) throw new CannotMerge(`${what} is not a unit map (it has no "units")`);
  return parsed;
}

/** @param base null when neither side started from a file */
function mergeUnitMaps(base, landed, mine) {
  if (has(landed, "buildingId") && has(mine, "buildingId") && landed.buildingId !== mine.buildingId) {
    throw new CannotMerge(`the two files are for different buildings (${JSON.stringify(landed.buildingId)}, ${JSON.stringify(mine.buildingId)})`);
  }
  // Entries of two formats in one file, under one version number, would be a file no program wrote.
  if (!same(landed.schemaVersion, mine.schemaVersion)) {
    throw new CannotMerge(
      `the two files are in different versions of the format (${JSON.stringify(landed.schemaVersion)}, ${JSON.stringify(mine.schemaVersion)})`,
    );
  }
  const before = base === null ? {} : base.units;
  // No prototype: a unit called "__proto__" is a unit like any other.
  const units = Object.create(null);
  // The order the file already has on the branch, then what only this run has.
  for (const unit of [...Object.keys(landed.units), ...Object.keys(mine.units).filter((u) => !has(landed.units, u))]) {
    const was = has(before, unit) ? before[unit] : undefined;
    const theirs = has(landed.units, unit) ? landed.units[unit] : undefined;
    const ours = has(mine.units, unit) ? mine.units[unit] : undefined;
    const value = !same(ours, was) ? ours : !same(theirs, was) ? theirs : was;
    if (value !== undefined) units[unit] = value;
  }
  return { ...mine, units };
}

try {
  const [basePath, landedPath, minePath, name] = process.argv.slice(2);
  if (!basePath || !landedPath || !minePath) throw new Error("usage: merge-unitmap.mjs <base> <landed> <mine> [<name of the file>]");
  // Everything is read before anything is written.
  const baseText = readFileSync(basePath, "utf8");
  const landedText = readFileSync(landedPath, "utf8");
  const mineText = readFileSync(minePath, "utf8");
  try {
    const base = baseText.trim() === "" ? null : parseUnitMap(baseText, "the file both sides started from");
    const landed = parseUnitMap(landedText, "the file on the branch");
    const mine = parseUnitMap(mineText, "this run's file");
    // What the generator writes: two-space JSON and a final newline.
    writeFileSync(landedPath, `${JSON.stringify(mergeUnitMaps(base, landed, mine), null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof CannotMerge)) throw error;
    // One line, whatever the files and the name hold: GitHub reads it as an
    // annotation for the run's page, and would read a second line starting
    // with "::" as a command of its own.
    const said = `The unit map ${name || "(unnamed)"} was left as it landed; this run's version of it is dropped: ${error.message}.`;
    console.log(`::warning::${said.replace(/[\r\n]+/g, " ")}`);
  }
} catch (error) {
  console.error(`merge-unitmap: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
