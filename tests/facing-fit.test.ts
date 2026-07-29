import { describe, expect, it } from "vitest";
import { arcFacing, inferBuilding, type InferUnitInput } from "@/lib/massing/infer";
import { resolveUnitPlacement } from "@/lib/units/placement";
import { angleDeltaDeg } from "@/lib/geo";

/**
 * The line arrangement decides every unit's compass exposure, and without
 * evidence it is pure convention. These tests check that stated facings —
 * the kind a leasing agent gives in a tour follow-up — actually override the
 * convention rather than being decoration.
 */

const LINES = ["01", "02", "03", "04", "05", "06", "07", "08"];

function tower(sqftByLine: Record<string, number> = {}): InferUnitInput[] {
  const units: InferUnitInput[] = [];
  for (let floor = 5; floor <= 30; floor++) {
    for (const line of LINES) {
      units.push({
        unitCode: `${floor}${line}`,
        floor,
        line,
        sqft: sqftByLine[line] ?? 800,
        bedrooms: 1,
      });
    }
  }
  return units;
}

/** Facing each line ends up with, for a given inference result. */
function facings(result: ReturnType<typeof inferBuilding>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stack of result.plate.stacks) {
    const p = resolveUnitPlacement(result.spec, result.plate, {
      unitCode: `20${stack.line}`,
      floor: 20,
      line: stack.line,
    })!;
    out[stack.line] = p.facingDeg;
  }
  return out;
}

describe("arcFacing", () => {
  it("returns the outward bearing of each edge of the plate", () => {
    const w = 40;
    const d = 20;
    // Parameterisation runs clockwise from the north-west corner.
    expect(arcFacing(w, d, 1, 10)).toBeCloseTo(0, 5); // north edge
    expect(arcFacing(w, d, 45, 55)).toBeCloseTo(90, 5); // east edge
    expect(arcFacing(w, d, 65, 90)).toBeCloseTo(180, 5); // south edge
    expect(arcFacing(w, d, 105, 115)).toBeCloseTo(270, 5); // west edge
  });

  it("gives a corner-wrapping arc a diagonal bearing", () => {
    const w = 40;
    const d = 20;
    // An arc straddling the north-east corner in equal measure.
    const bearing = arcFacing(w, d, w - 5, w + 5);
    expect(Math.abs(angleDeltaDeg(bearing, 45))).toBeLessThan(1);
  });

  it("handles an arc that wraps past the parameter origin", () => {
    const w = 40;
    const d = 20;
    const P = 2 * (w + d);
    // Straddling the north-west corner: west edge into north edge.
    const bearing = arcFacing(w, d, P - 5, P + 5);
    expect(Math.abs(angleDeltaDeg(bearing, 315))).toBeLessThan(1);
  });
});

describe("fitting line positions to stated facings", () => {
  it("falls back to the clockwise convention with no observations", () => {
    const result = inferBuilding({ slug: "t", name: "T", units: tower() });
    expect(result.spec.provenance.notes.join(" ")).toMatch(/unverified/i);
    // Every line still lands somewhere sensible.
    expect(Object.keys(facings(result))).toHaveLength(8);
  });

  it("recovers an arrangement it was told about", () => {
    // Take the unobserved layout, read off what line 05 actually faces, then
    // assert that stating a *different* facing for it moves the whole ring.
    const baseline = inferBuilding({ slug: "t", name: "T", units: tower() });
    const baselineFacings = facings(baseline);

    const target = (baselineFacings["05"] + 180) % 360;
    const fitted = inferBuilding({
      slug: "t",
      name: "T",
      units: tower(),
      facingObservations: [{ line: "05", bearingDeg: target }],
    });

    const got = facings(fitted)["05"];
    // Eight equal lines around a rectangle can't hit every bearing exactly,
    // but the fit must land far closer to the stated facing than the default.
    expect(Math.abs(angleDeltaDeg(got, target))).toBeLessThan(
      Math.abs(angleDeltaDeg(baselineFacings["05"], target)),
    );
    expect(fitted.spec.provenance.notes.join(" ")).toMatch(/fitted to 1 stated facing/i);
  });

  it("reproduces a full arrangement from several observations", () => {
    // Generate a layout, harvest every line's facing from it, then feed those
    // back in. The fitter must return to the same arrangement.
    const original = inferBuilding({ slug: "t", name: "T", units: tower() });
    const truth = facings(original);

    const refit = inferBuilding({
      slug: "t",
      name: "T",
      units: tower(),
      facingObservations: Object.entries(truth).map(([line, bearingDeg]) => ({
        line,
        bearingDeg,
      })),
    });

    for (const [line, bearing] of Object.entries(truth)) {
      expect(Math.abs(angleDeltaDeg(facings(refit)[line], bearing))).toBeLessThan(1);
    }
  });

  it("can run the numbering counter-clockwise when that fits better", () => {
    const baseline = inferBuilding({ slug: "t", name: "T", units: tower() });
    const truth = facings(baseline);

    // Mirror every observation about north: a layout numbered the other way
    // round the plate. The fitter should pick the reversed direction.
    const mirrored = Object.entries(truth).map(([line, bearingDeg]) => ({
      line,
      bearingDeg: (360 - bearingDeg) % 360,
    }));

    const refit = inferBuilding({
      slug: "t",
      name: "T",
      units: tower(),
      facingObservations: mirrored,
    });

    const got = facings(refit);
    let totalError = 0;
    for (const { line, bearingDeg } of mirrored) {
      totalError += Math.abs(angleDeltaDeg(got[line], bearingDeg));
    }
    // A mirrored ring is exactly representable, so the fit should be tight.
    expect(totalError / mirrored.length).toBeLessThan(25);
  });

  it("reports a poor fit rather than presenting it as solved", () => {
    // Contradictory observations: three lines all claiming to face north.
    const result = inferBuilding({
      slug: "t",
      name: "T",
      units: tower(),
      facingObservations: [
        { line: "01", bearingDeg: 0 },
        { line: "04", bearingDeg: 0 },
        { line: "07", bearingDeg: 0 },
      ],
    });
    const notes = result.spec.provenance.notes.join(" ");
    expect(notes).toMatch(/fitted to 3 stated facing/i);
    expect(notes).toMatch(/poor/i);
  });

  it("ignores observations for lines the building does not have", () => {
    const result = inferBuilding({
      slug: "t",
      name: "T",
      units: tower(),
      facingObservations: [{ line: "99", bearingDeg: 180 }],
    });
    expect(result.spec.provenance.notes.join(" ")).toMatch(/unverified/i);
  });
});

describe("The Leo, from the tour email", () => {
  /**
   * The agent stated three facings for The Leo: tier 07 south-west, tier 10
   * west, tier 09 north. The building has ten tiers. This checks the fitter
   * uses them rather than defaulting.
   */
  const leoLines = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];

  const units: InferUnitInput[] = [];
  for (let floor = 4; floor <= 20; floor++) {
    for (const line of leoLines) {
      units.push({
        unitCode: `${floor}${line}`,
        floor,
        line,
        sqft: line === "07" ? 1052 : line === "10" ? 971 : 700,
        bedrooms: line === "07" ? 2 : 1,
      });
    }
  }

  const result = inferBuilding({
    slug: "the-leo",
    name: "The Leo",
    units,
    facingObservations: [
      { line: "07", bearingDeg: 225, source: "tour email" }, // South-West
      { line: "10", bearingDeg: 270, source: "tour email" }, // West
    ],
  });

  it("records that the arrangement was fitted, not assumed", () => {
    expect(result.spec.provenance.notes.join(" ")).toMatch(/fitted to 2 stated facing/i);
  });

  it("puts tier 07 on a westerly-to-southerly wall", () => {
    const p = resolveUnitPlacement(result.spec, result.plate, {
      unitCode: "707",
      floor: 7,
      line: "07",
    })!;
    // The stated facing is 225°; with ten lines on a rectangle the achievable
    // bearings are coarse, so allow a wall either side of it.
    expect(Math.abs(angleDeltaDeg(p.facingDeg, 225))).toBeLessThanOrEqual(90);
  });

  it("keeps 07 and 10 adjacent on the plate, as their numbering implies", () => {
    const p07 = resolveUnitPlacement(result.spec, result.plate, {
      unitCode: "707",
      floor: 7,
      line: "07",
    })!;
    const p10 = resolveUnitPlacement(result.spec, result.plate, {
      unitCode: "710",
      floor: 7,
      line: "10",
    })!;
    // Both were stated as westerly; they must not end up on opposite walls.
    expect(Math.abs(angleDeltaDeg(p07.facingDeg, p10.facingDeg))).toBeLessThanOrEqual(135);
  });
});
