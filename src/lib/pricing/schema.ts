import { z } from "zod";

/**
 * What a listed rent actually costs.
 *
 * Advertised rent is not comparable across buildings. The Leo quotes rent and
 * bills a separate bundled-utility fee that scales with unit type ($50 studio
 * → $115 two-bed) plus $65 internet; Old Town Park bills utilities through a
 * RUBS split and charges $375 parking and a $12 liability waiver; Stead 220
 * quotes an "all in" number with utilities already inside it. Comparing the
 * headline numbers compares three different things.
 *
 * So every cost a building can levy is modelled as a Charge, and the all-in
 * monthly figure is computed rather than scraped.
 */

export const CHARGE_KINDS = [
  "utilities",   // bundled gas/water/sewer/trash, or a RUBS allocation
  "electric",    // billed by the utility directly, resident's own account
  "internet",
  "parking",
  "storage",
  "amenity",
  "pet",
  "insurance",   // renter's insurance or a liability waiver
  "application",
  "admin",
  "move_in",
  "other",
] as const;
export const ChargeKindSchema = z.enum(CHARGE_KINDS);
export type ChargeKind = z.infer<typeof ChargeKindSchema>;

export const CADENCES = [
  "monthly",
  "one_time",
  "per_person_one_time",
  "variable", // metered or RUBS — real but not a fixed number
] as const;
export const CadenceSchema = z.enum(CADENCES);
export type Cadence = z.infer<typeof CadenceSchema>;

export const REQUIREMENTS = [
  "required",    // every resident pays it
  "optional",    // only if you take the parking space / storage unit
  "conditional", // only if it applies to you (pets, EV)
] as const;
export const RequirementSchema = z.enum(REQUIREMENTS);
export type Requirement = z.infer<typeof RequirementSchema>;

export const ChargeSourceSchema = z.object({
  kind: z.enum(["fee-sheet", "email", "website", "manual"]).default("manual"),
  /** Filename, URL, or the agent's name — whatever makes it traceable. */
  ref: z.string().optional(),
  /** ISO date the fact was observed. Fees change; this dates them. */
  observedAt: z.string().optional(),
});

export const ChargeSchema = z.object({
  kind: ChargeKindSchema,
  /** Human label exactly as the building words it. */
  label: z.string().min(1),
  /** Dollars. Null when the charge is real but not a fixed amount (RUBS). */
  amount: z.number().nullable().default(null),
  cadence: CadenceSchema.default("monthly"),
  requirement: RequirementSchema.default("required"),
  /**
   * Bedroom count this charge applies to. Null means every unit. The Leo's
   * bundled utility fee is the canonical case: one charge per unit type.
   */
  appliesToBedrooms: z.number().nullable().default(null),
  /**
   * Plan/unit-type name this charge is scoped to. Needed because bedroom count
   * alone cannot separate "1 Bedroom" from "1 Bedroom + Den" — they share a
   * bedroom count but sit in different fee tiers.
   */
  appliesToPlanName: z.string().nullable().default(null),
  /** What the charge covers, for the "what's included" readout. */
  includes: z.array(z.string()).default([]),
  note: z.string().optional(),
  source: ChargeSourceSchema.default({ kind: "manual" }),
});
export type Charge = z.infer<typeof ChargeSchema>;

/** Which optional charges to include when totalling. */
export const CostOptionsSchema = z.object({
  parking: z.boolean().default(false),
  storage: z.boolean().default(false),
  pets: z.number().min(0).default(0),
  /** Count internet as required when the building is the only supplier. */
  internet: z.boolean().default(true),
  /** Occupants, for per-person application fees. */
  occupants: z.number().min(1).default(1),
  leaseMonths: z.number().min(1).default(12),
});
export type CostOptions = z.infer<typeof CostOptionsSchema>;

export interface CostLine {
  label: string;
  kind: ChargeKind;
  /** Dollars per month, or null when variable. */
  monthly: number | null;
  requirement: Requirement;
  variable: boolean;
  note?: string;
}

export interface CostBreakdown {
  baseRent: number | null;
  /** Charges every resident of this unit pays. */
  required: CostLine[];
  /** Charges included only because the caller opted into them. */
  optional: CostLine[];
  /** One-time charges, in dollars. */
  oneTime: Array<{ label: string; kind: ChargeKind; amount: number }>;

  /** Base rent + required monthly charges. Comparable across buildings. */
  allInMonthly: number | null;
  /** All-in plus selected options. */
  withOptionsMonthly: number | null;
  /** With one-time costs spread over the lease term. */
  effectiveMonthly: number | null;
  oneTimeTotal: number;

  /** True when some required cost is real but unquantified (RUBS, metered). */
  hasVariableCharges: boolean;
  /** Everything the required charges cover, deduplicated. */
  includes: string[];
  /** Costs the resident bears that the building does not bill. */
  excluded: string[];
}
