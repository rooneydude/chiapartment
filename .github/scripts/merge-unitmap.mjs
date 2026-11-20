#!/usr/bin/env node
// Puts two versions of a unit map (data/unitmaps/<building>.json) together.
//
// Used by commit-snapshot.sh as git's merge driver for those files:
//
//   node merge-unitmap.mjs <base> <landed> <mine>
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
// Anything that is not a readable unit map ends with a non-zero exit and
// leaves the files alone. git then reports a conflict, and the commit step
// stops and pushes nothing rather than guess.
//
// A program and nothing else: it has no exports, so that there is no way to
// start it that does not do the merge. scraper/test/ci-unitmap-merge.test.ts
// runs it as git does.
import { readFileSync, writeFileSync } from "node:fs";

const isRecord = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

function parseUnitMap(text, what) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.units)) throw new Error(`${what} is not a unit map (it has no "units")`);
  return parsed;
}

/** @param base null when neither side started from a file */
function mergeUnitMaps(base, landed, mine) {
  if (has(landed, "buildingId") && has(mine, "buildingId") && landed.buildingId !== mine.buildingId) {
    throw new Error(`the two files are for different buildings (${String(landed.buildingId)}, ${String(mine.buildingId)})`);
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
  const [basePath, landedPath, minePath] = process.argv.slice(2);
  if (!basePath || !landedPath || !minePath) throw new Error("usage: merge-unitmap.mjs <base> <landed> <mine>");
  const baseText = readFileSync(basePath, "utf8");
  const base = baseText.trim() === "" ? null : parseUnitMap(baseText, "the file both sides started from");
  const landed = parseUnitMap(readFileSync(landedPath, "utf8"), "the file on the branch");
  const mine = parseUnitMap(readFileSync(minePath, "utf8"), "this run's file");
  // What the generator writes: two-space JSON and a final newline.
  writeFileSync(landedPath, `${JSON.stringify(mergeUnitMaps(base, landed, mine), null, 2)}\n`);
} catch (error) {
  console.error(`merge-unitmap: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
