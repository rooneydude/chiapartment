import { describe, expect, it } from "vitest";
import {
  parseAvailability,
  parseBathrooms,
  parseBedrooms,
  parseLeaseTerm,
  parseMoney,
  parseMoneyRange,
  parseSqft,
} from "@/lib/scrape/parse";

describe("parseMoney", () => {
  it("reads the shapes leasing sites actually use", () => {
    expect(parseMoney("$2,395")).toBe(2395);
    expect(parseMoney("From $2395/mo")).toBe(2395);
    expect(parseMoney("Starting at 2,395")).toBe(2395);
    expect(parseMoney("$2,395.00")).toBe(2395);
    expect(parseMoney(2395)).toBe(2395);
  });

  it("returns undefined rather than 0 when there is no price", () => {
    expect(parseMoney("Call for pricing")).toBeUndefined();
    expect(parseMoney("Contact us")).toBeUndefined();
    expect(parseMoney("—")).toBeUndefined();
    expect(parseMoney("")).toBeUndefined();
    expect(parseMoney(null)).toBeUndefined();
  });

  it("rejects numbers that cannot be a Chicago rent", () => {
    expect(parseMoney("$12")).toBeUndefined();
    expect(parseMoney("$250000")).toBeUndefined();
  });

  it("prefers the dollar-marked number over other digits in the string", () => {
    expect(parseMoney("2 Bed · 1100 sqft · $3,450")).toBe(3450);
  });

  it("takes the low end of a range", () => {
    expect(parseMoneyRange("$2,395 - $2,795")).toEqual({ min: 2395, max: 2795 });
    expect(parseMoneyRange("$2,395–$2,795").min).toBe(2395);
  });
});

describe("parseSqft", () => {
  it("reads labelled and bare sizes", () => {
    expect(parseSqft("1,148 sq ft")).toBe(1148);
    expect(parseSqft("706 SF")).toBe(706);
    expect(parseSqft("742")).toBe(742);
    expect(parseSqft(1148)).toBe(1148);
  });

  it("rejects values outside a plausible apartment size", () => {
    expect(parseSqft("12 sq ft")).toBeUndefined();
    expect(parseSqft("99,000 sq ft")).toBeUndefined();
  });
});

describe("parseBedrooms / parseBathrooms", () => {
  it("treats studios as zero bedrooms", () => {
    expect(parseBedrooms("Studio")).toBe(0);
    expect(parseBedrooms("Convertible")).toBe(0);
  });

  it("reads counts and the NxN shorthand", () => {
    expect(parseBedrooms("2 Bed")).toBe(2);
    expect(parseBedrooms("1 BR")).toBe(1);
    expect(parseBedrooms("2x2")).toBe(2);
    expect(parseBathrooms("2x2")).toBe(2);
    expect(parseBathrooms("1.5 Bath")).toBe(1.5);
  });
});

describe("parseAvailability", () => {
  const today = new Date(2026, 6, 29); // 29 Jul 2026, local time

  it("resolves 'now' to today", () => {
    expect(parseAvailability("Available Now", today)).toBe("2026-07-29");
    expect(parseAvailability("Immediate", today)).toBe("2026-07-29");
  });

  it("reads explicit dates in every common format", () => {
    expect(parseAvailability("2026-08-15", today)).toBe("2026-08-15");
    expect(parseAvailability("8/15/26", today)).toBe("2026-08-15");
    expect(parseAvailability("Aug 15, 2026", today)).toBe("2026-08-15");
    expect(parseAvailability("August 15th", today)).toBe("2026-08-15");
  });

  it("rolls a bare month/day forward when it is well in the past", () => {
    expect(parseAvailability("2/1", today)).toBe("2027-02-01");
  });

  it("does not roll a date that only just passed", () => {
    expect(parseAvailability("7/20", today)).toBe("2026-07-20");
  });

  it("returns undefined for unparseable text", () => {
    expect(parseAvailability("Ask leasing", today)).toBeUndefined();
  });
});

describe("parseLeaseTerm", () => {
  it("reads month counts and rejects nonsense", () => {
    expect(parseLeaseTerm("12 months")).toBe(12);
    expect(parseLeaseTerm("15 mo")).toBe(15);
    expect(parseLeaseTerm("99 months")).toBeUndefined();
  });
});
