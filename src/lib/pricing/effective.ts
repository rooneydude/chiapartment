import {
  CostOptionsSchema,
  type Charge,
  type CostBreakdown,
  type CostLine,
  type CostOptions,
} from "./schema";

/**
 * Turn a listed rent plus a building's fee schedule into a comparable number.
 *
 * Two rules keep this honest:
 *
 *  - A charge with an unknown amount (a RUBS utility split, metered electric)
 *    is never treated as zero. It is carried as a variable line and flagged, so
 *    an all-in total is always marked as a floor rather than a promise.
 *  - Charges scoped to a bedroom count only apply to units of that type, so a
 *    studio isn't charged the two-bedroom utility fee.
 */
export function computeCost(
  input: {
    rent: number | null;
    bedrooms: number | null;
    charges: Charge[];
    /** Plan name, when known — selects between same-bedroom fee tiers. */
    planName?: string | null;
  },
  options: Partial<CostOptions> = {},
): CostBreakdown {
  const opts = CostOptionsSchema.parse(options);
  const applicable = input.charges.filter((c) =>
    appliesTo(c, input.bedrooms, input.planName ?? null),
  );

  const required: CostLine[] = [];
  const optional: CostLine[] = [];
  const oneTime: CostBreakdown["oneTime"] = [];
  const includes = new Set<string>();
  const excluded = new Set<string>();
  let hasVariable = false;

  for (const charge of applicable) {
    const variable = charge.cadence === "variable" || charge.amount == null;
    if (variable) hasVariable = true;

    // One-time charges are collected separately and amortised at the end.
    if (charge.cadence === "one_time" || charge.cadence === "per_person_one_time") {
      if (charge.amount != null) {
        const multiplier =
          charge.cadence === "per_person_one_time" ? opts.occupants : 1;
        oneTime.push({
          label: charge.label,
          kind: charge.kind,
          amount: charge.amount * multiplier,
        });
      }
      continue;
    }

    const line: CostLine = {
      label: charge.label,
      kind: charge.kind,
      monthly: variable ? null : charge.amount,
      requirement: charge.requirement,
      variable,
      note: charge.note,
    };

    if (isSelected(charge, opts)) {
      // Electric is a real monthly cost the resident pays, but it goes to the
      // utility, not the building — reported, never folded into the total.
      if (charge.kind === "electric") {
        excluded.add(charge.label);
        line.requirement = "conditional";
        optional.push(line);
        continue;
      }
      if (charge.requirement === "required") {
        required.push(line);
        for (const item of charge.includes) includes.add(item);
      } else {
        optional.push(line);
      }
    } else {
      optional.push(line);
    }
  }

  const requiredTotal = sumKnown(required);
  const optionalSelectedTotal = sumKnown(
    optional.filter((l) => l.requirement !== "conditional" && isOptionSelectedLine(l, opts)),
  );

  const allInMonthly = input.rent != null ? input.rent + requiredTotal : null;
  const withOptionsMonthly =
    allInMonthly != null ? allInMonthly + optionalSelectedTotal : null;

  const oneTimeTotal = oneTime.reduce((a, c) => a + c.amount, 0);
  const effectiveMonthly =
    withOptionsMonthly != null
      ? Math.round(withOptionsMonthly + oneTimeTotal / opts.leaseMonths)
      : null;

  return {
    baseRent: input.rent,
    required,
    optional,
    oneTime,
    allInMonthly,
    withOptionsMonthly,
    effectiveMonthly,
    oneTimeTotal,
    hasVariableCharges: hasVariable,
    includes: [...includes],
    excluded: [...excluded],
  };
}

/**
 * A charge scoped to a unit type only applies to units of that type.
 *
 * Plan-scoped charges ("1 Bedroom + Den") are stricter than bedroom-scoped
 * ones: without a matching plan name they are skipped entirely, so a plain
 * one-bedroom is never charged the den tier.
 */
function appliesTo(
  charge: Charge,
  bedrooms: number | null,
  planName: string | null,
): boolean {
  if (charge.appliesToPlanName != null) {
    if (!planName) return false;
    return normalizePlan(planName) === normalizePlan(charge.appliesToPlanName);
  }
  if (charge.appliesToBedrooms == null) return true;
  if (bedrooms == null) return false;
  return charge.appliesToBedrooms === bedrooms;
}

function normalizePlan(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Whether an optional charge was opted into. */
function isSelected(charge: Charge, opts: CostOptions): boolean {
  if (charge.requirement === "required") return true;
  switch (charge.kind) {
    case "parking":
      return opts.parking;
    case "storage":
      return opts.storage;
    case "pet":
      return opts.pets > 0;
    case "internet":
      return opts.internet;
    default:
      return false;
  }
}

function isOptionSelectedLine(line: CostLine, opts: CostOptions): boolean {
  switch (line.kind) {
    case "parking":
      return opts.parking;
    case "storage":
      return opts.storage;
    case "pet":
      return opts.pets > 0;
    case "internet":
      return opts.internet;
    default:
      return false;
  }
}

function sumKnown(lines: CostLine[]): number {
  return lines.reduce((a, l) => a + (l.monthly ?? 0), 0);
}

/**
 * One-line summary of what the quoted rent covers, for the listing card.
 */
export function describeInclusions(breakdown: CostBreakdown): string {
  if (breakdown.required.length === 0) {
    return breakdown.hasVariableCharges
      ? "Rent only — utilities billed separately, amount varies"
      : "Rent only";
  }
  const parts = breakdown.includes.length
    ? breakdown.includes.join(", ")
    : breakdown.required.map((l) => l.label).join(", ");
  const suffix = breakdown.hasVariableCharges ? " (plus metered usage)" : "";
  return `Includes ${parts}${suffix}`;
}
