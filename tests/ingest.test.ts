import { describe, expect, it } from "vitest";
import { parseAgentEmail, parseCharges, parseFacing } from "@/lib/ingest/email";
import { computeCost, describeInclusions } from "@/lib/pricing/effective";
import { ChargeSchema } from "@/lib/pricing/schema";

/**
 * Fixtures are the real tour follow-up emails and fee sheet, retyped verbatim.
 * They are the only ground truth available for orientation, so the parser is
 * held to them exactly.
 */

const STEAD_EMAIL = `
Hello Jonathan,

It was great to meet you.

As we discussed, I've attached the floor plans and details we reviewed:

  1509 Medium Two Bedroom
    Southeast facing view
    Base rent : $4,490
    All in (base rent + utilities ) : $4,690
    Lease available now through October 1st
  1312 Large Two Bedroom
    Southwest facing view
    Base rent : $5,140
    All in (base rent + utilities ) : $5,340
    Lease available now through October 1st
  808 Large Studio
    East facing view
    Base rent : $2,520
    All in (base rent + utilities ) : $2,670
    Lease available now through October 1st

I've also included our fee sheet outlining additional costs.
`;

const LEO_EMAIL = `
Below you will find the details regarding the units we discussed today:

The Leo | Two Bedroom | Tier 07
  Unit: 707
  Move-in date: 8/19- 9/03 (Flexible)
  Price: $5,050/month
  Size: 1052 sq ft
  View: South-West facing

The Leo | One Bedroom + Den | Tier 10 (Large bedroom, 1.5 baths!)
  Unit: 1310
  Available for move-in: 9/6 - 9/20 (Flexible)
  Price: $4,225
  Size: 971 sq ft
  Lease Length: 12 months
  View: West-facing

The Leo | Studio | Tier 09
  Unit: 1709
  Available for move-in: Now - 7/29 (Flexible)
  Price: $2,445/month
  Lease Length: 12 months
  View: North-facing
`;

const LEO_FEE_SHEET = `
GENERAL FEES
Application Fee*: $75 / Person
Administrative Fee*: $500

BUNDLED UTILITY SERVICES
Bundled utility services fee includes the cost of natural gas, water, trash
removal, recycling, and sewer. Residents are responsible for establishing an
account with ComEd to pay for general electricity consumption within the
residence, plus renter's insurance.

  Studio: $50
  Jr 1 Bed: $65
  1 Bedroom: $90
  1 Bedroom + Den: $105
  2 Bedroom: $115

INTERNET
1,000 Mbps (1 GB) of high-speed Internet is provided through Zentro for a fee
of $65 per month.

STORAGE & PARKING
Reserved Parking in Secure On-Site Garage: $395 / Month
Reserved EV Parking Stations: $450 / Month
Small Storage: $50 / Month
Large Storage: $75 / Month
`;

const OTP_EMAIL = `
Hello Jonathan,

Thank you for your time in providing you with a tour at Old Town Park today!

OTP2  Plan B2    2 - Bedroom Unit#:  3508 :  Views Facing South virtual tour taken of unit# 1208 :  https://my.matterport.com/show/?m=2xEbotsUMrY

OTP3 Plan S4 Convertible Unit#:  3604 :     Views Facing North - virtual tour taken of unit# 2504 : https://my.matterport.com/show/?m=85VsvhC86nv

Just to recap some information:
  Application Fees: $500 admin fee and $75.00 application fee
  Utilities: Billed on a RUBS system (resident utility billing). Water, sewer, trash,
  and gas are billed through the building as a whole and then divided into each unit
  based on square footage and occupancy. Electric, you would set up yourself with ComEd.
  Renter's Insurance: Old Town Park does not require renter's insurance as all residents
  pay a $12.00/month fee for the resident liability waiver.
  Parking: $375/month through the lease term.
  Internet service provider AT&T bundle at OTP3 : $70.00
`;

describe("parseFacing", () => {
  it("prefers compound directions over their components", () => {
    expect(parseFacing("South-West facing")?.deg).toBe(225);
    expect(parseFacing("Southeast facing view")?.deg).toBe(135);
    expect(parseFacing("Views Facing North")?.deg).toBe(0);
    expect(parseFacing("West-facing")?.deg).toBe(270);
    expect(parseFacing("East facing view")?.deg).toBe(90);
  });

  it("returns null when there is no direction", () => {
    expect(parseFacing("Lease available now")).toBeNull();
  });
});

describe("Stead 220 tour email", () => {
  const result = parseAgentEmail(STEAD_EMAIL, { today: new Date(2026, 6, 29) });

  it("finds all three units", () => {
    expect(result.units.map((u) => u.unitCode).sort()).toEqual(["1312", "1509", "808"]);
  });

  it("reads base rent and the all-in figure separately", () => {
    const u = result.units.find((x) => x.unitCode === "1509")!;
    expect(u.rent).toBe(4490);
    expect(u.allInRent).toBe(4690);
  });

  it("captures the orientation the agent stated", () => {
    const byUnit = Object.fromEntries(result.units.map((u) => [u.unitCode, u.facingDeg]));
    expect(byUnit["1509"]).toBe(135); // Southeast
    expect(byUnit["1312"]).toBe(225); // Southwest
    expect(byUnit["808"]).toBe(90); // East
  });

  it("implies the utility charge from the base/all-in gap", () => {
    const u = result.units.find((x) => x.unitCode === "808")!;
    expect(u.allInRent! - u.rent!).toBe(150);
  });
});

describe("The Leo tour email", () => {
  const result = parseAgentEmail(LEO_EMAIL, { today: new Date(2026, 6, 29) });

  it("reads each unit's rent, size and orientation", () => {
    const u707 = result.units.find((u) => u.unitCode === "707")!;
    expect(u707.rent).toBe(5050);
    expect(u707.sqft).toBe(1052);
    expect(u707.facingDeg).toBe(225); // South-West

    const u1310 = result.units.find((u) => u.unitCode === "1310")!;
    expect(u1310.rent).toBe(4225);
    expect(u1310.sqft).toBe(971);
    expect(u1310.facingDeg).toBe(270); // West
    expect(u1310.leaseMonths).toBe(12);

    const u1709 = result.units.find((u) => u.unitCode === "1709")!;
    expect(u1709.rent).toBe(2445);
    expect(u1709.facingDeg).toBe(0); // North
  });

  it("reads move-in ranges", () => {
    const u707 = result.units.find((u) => u.unitCode === "707")!;
    expect(u707.availableFrom).toBe("2026-08-19");
    expect(u707.availableThrough).toBe("2026-09-03");
  });

  it("takes the bed count from the heading above the unit", () => {
    // "The Leo | Two Bedroom | Tier 07" sits on the line before "Unit: 707",
    // and it is the only place the bed count appears. Without it the unit gets
    // charged the wrong bundled-utility tier.
    expect(result.units.find((u) => u.unitCode === "707")?.bedrooms).toBe(2);
    expect(result.units.find((u) => u.unitCode === "1709")?.bedrooms).toBe(0);
  });

  it("does not let a unit absorb the previous unit's heading", () => {
    const u1310 = result.units.find((u) => u.unitCode === "1310")!;
    // 1310 is the one-bed-plus-den, not the two-bed above it.
    expect(u1310.bedrooms).toBe(1);
    expect(u1310.rent).toBe(4225);
  });

  it("does not mistake a street name for an orientation", () => {
    // "741 N WELLS ST" must not read as north-facing.
    const stray = parseAgentEmail(
      "Unit: 707\nPrice: $5,050\n741 N WELLS ST, CHICAGO",
      { today: new Date(2026, 6, 29) },
    );
    expect(stray.units[0].facingDeg).toBeUndefined();
  });
});

describe("The Leo fee sheet", () => {
  const charges = parseCharges(LEO_FEE_SHEET);

  it("parses every charge into a valid Charge", () => {
    for (const c of charges) expect(() => ChargeSchema.parse(c)).not.toThrow();
  });

  it("reads the bundled utility fee per unit type", () => {
    const utilities = charges.filter((c) => c.kind === "utilities");
    // The plain bedroom tiers; "+ Den" and "Jr" are scoped by plan name and
    // share a bedroom count with them.
    const byBedrooms = Object.fromEntries(
      utilities
        .filter((c) => c.appliesToPlanName == null)
        .map((c) => [c.appliesToBedrooms, c.amount]),
    );
    expect(byBedrooms[0]).toBe(50); // Studio
    expect(byBedrooms[1]).toBe(90); // 1 Bedroom
    expect(byBedrooms[2]).toBe(115); // 2 Bedroom

    // The den tier is a separate charge, not an overwrite of the 1-bed tier.
    const den = utilities.find((c) => /den/i.test(c.appliesToPlanName ?? ""));
    expect(den?.amount).toBe(105);
  });

  it("reads one-time fees with the right cadence", () => {
    const app = charges.find((c) => c.kind === "application")!;
    expect(app.amount).toBe(75);
    expect(app.cadence).toBe("per_person_one_time");

    const admin = charges.find((c) => c.kind === "admin")!;
    expect(admin.amount).toBe(500);
    expect(admin.cadence).toBe("one_time");
  });

  it("marks parking and storage optional, internet required", () => {
    expect(charges.find((c) => c.label === "Reserved parking")).toMatchObject({
      amount: 395,
      requirement: "optional",
    });
    expect(charges.find((c) => c.label === "Small storage")).toMatchObject({
      amount: 50,
      requirement: "optional",
    });
    expect(charges.find((c) => c.kind === "internet")).toMatchObject({ amount: 65 });
  });
});

describe("Old Town Park tour email", () => {
  const result = parseAgentEmail(OTP_EMAIL, { today: new Date(2026, 6, 29) });

  it("keeps the tower designator with the unit", () => {
    const u3508 = result.units.find((u) => u.unitCode === "3508");
    expect(u3508).toBeDefined();
    expect(u3508!.wing).toBe("OTP2");
    expect(u3508!.facingDeg).toBe(180); // South
  });

  it("does not treat the virtual-tour unit number as a listing", () => {
    // "virtual tour taken of unit# 1208" is a different unit shown as a sample.
    const codes = result.units.map((u) => u.unitCode);
    expect(codes).toContain("3508");
    expect(codes).toContain("3604");
  });

  it("records a RUBS split as a required charge with no fixed amount", () => {
    const utilities = result.charges.find((c) => c.kind === "utilities")!;
    expect(utilities.amount).toBeNull();
    expect(utilities.cadence).toBe("variable");
    expect(utilities.requirement).toBe("required");
  });

  it("reads the liability waiver, parking and application fees", () => {
    const byKind = Object.fromEntries(result.charges.map((c) => [c.kind, c]));
    expect(byKind.insurance?.amount).toBe(12);
    expect(byKind.parking?.amount).toBe(375);
    expect(byKind.admin?.amount).toBe(500);
    expect(byKind.application?.amount).toBe(75);
  });
});

describe("computeCost", () => {
  const leoCharges = parseCharges(LEO_FEE_SHEET);

  it("adds only the utility tier matching the unit's bedroom count", () => {
    const studio = computeCost({ rent: 2445, bedrooms: 0, charges: leoCharges });
    const twoBed = computeCost({ rent: 5050, bedrooms: 2, charges: leoCharges });

    // Studio: 2445 + 50 utilities + 65 internet = 2560
    expect(studio.allInMonthly).toBe(2445 + 50 + 65);
    // Two bed: 5050 + 115 + 65 = 5230
    expect(twoBed.allInMonthly).toBe(5050 + 115 + 65);
  });

  it("leaves optional charges out until they are selected", () => {
    const without = computeCost({ rent: 5050, bedrooms: 2, charges: leoCharges });
    const withParking = computeCost(
      { rent: 5050, bedrooms: 2, charges: leoCharges },
      { parking: true },
    );
    expect(withParking.withOptionsMonthly! - without.withOptionsMonthly!).toBe(395);
  });

  it("amortises one-time fees across the lease", () => {
    const c = computeCost(
      { rent: 5050, bedrooms: 2, charges: leoCharges },
      { leaseMonths: 12, occupants: 2 },
    );
    // $500 admin + 2 x $75 application = $650 over 12 months.
    expect(c.oneTimeTotal).toBe(650);
    expect(c.effectiveMonthly).toBe(
      Math.round(c.withOptionsMonthly! + 650 / 12),
    );
  });

  it("never treats a variable charge as zero", () => {
    const otp = parseAgentEmail(OTP_EMAIL).charges;
    const c = computeCost({ rent: 3000, bedrooms: 2, charges: otp });
    expect(c.hasVariableCharges).toBe(true);
    // The all-in figure is a floor, not a promise — RUBS is not counted as 0.
    expect(c.allInMonthly).toBeGreaterThan(3000);
  });

  it("describes what the rent covers", () => {
    const c = computeCost({ rent: 5050, bedrooms: 2, charges: leoCharges });
    expect(describeInclusions(c)).toMatch(/gas|water|internet/i);
  });

  it("charges the den tier only when the plan name says den", () => {
    const plain = computeCost({
      rent: 4225,
      bedrooms: 1,
      charges: leoCharges,
    });
    const den = computeCost({
      rent: 4225,
      bedrooms: 1,
      planName: "1 Bedroom + Den",
      charges: leoCharges,
    });
    // Plain one-bed pays $90; the den tier pays $105.
    expect(den.allInMonthly! - plain.allInMonthly!).toBe(15);
  });

  it("reproduces The Leo's real all-in for unit 707", () => {
    // $5,050 rent + $115 two-bed utilities + $65 internet.
    const c = computeCost({ rent: 5050, bedrooms: 2, charges: leoCharges });
    expect(c.allInMonthly).toBe(5230);
    // $500 admin + $75 application for one occupant.
    expect(c.oneTimeTotal).toBe(575);
  });

  it("reconciles with the all-in figure Stead quoted", () => {
    // Stead's agent stated base $4,490 and all-in $4,690. Modelling that gap as
    // a flat utility charge must reproduce their number exactly.
    const charges = [
      ChargeSchema.parse({
        kind: "utilities",
        label: "Bundled utilities",
        amount: 200,
        cadence: "monthly",
        requirement: "required",
        includes: ["water", "gas", "trash"],
      }),
    ];
    const c = computeCost({ rent: 4490, bedrooms: 2, charges });
    expect(c.allInMonthly).toBe(4690);
  });
});
