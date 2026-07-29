/**
 * Field-level parsers shared by every adapter.
 *
 * Leasing sites express the same five facts in an astonishing number of ways
 * ("$2,395", "From $2395/mo", "Starting at 2,395", "Call for pricing"), so the
 * per-field parsing lives here, is adapter-agnostic, and is unit tested.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Extract a monthly rent. Returns undefined for "call for pricing" and friends
 * rather than 0, so an unavailable price never looks like a free apartment.
 */
export function parseMoney(input: unknown): number | undefined {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : undefined;
  }
  if (typeof input !== "string") return undefined;
  const s = input.replace(/ /g, " ").trim();
  if (!s) return undefined;
  if (/call|contact|inquire|unavailable|n\/?a|tbd|—|--/i.test(s) && !/\d/.test(s)) {
    return undefined;
  }
  // Prefer an explicitly $-prefixed number; fall back to the first number that
  // looks like rent. The `$` form avoids picking up "2 Bed" or a sqft figure.
  const dollar = s.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  const raw = dollar?.[1] ?? s.match(/([\d,]{3,})(?:\.\d{2})?/)?.[1];
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Guard against sqft or phone numbers leaking in as rent.
  if (n < 200 || n > 100_000) return undefined;
  return Math.round(n);
}

/**
 * Rent ranges ("$2,395 - $2,795") appear on plan-level rows. We keep the low
 * end, which is what these sites advertise as the plan's price.
 */
export function parseMoneyRange(
  input: unknown,
): { min?: number; max?: number } {
  if (typeof input !== "string") return { min: parseMoney(input) };
  const parts = input.split(/\s*(?:-|–|—|to)\s*/i);
  if (parts.length >= 2) {
    const min = parseMoney(parts[0]);
    const max = parseMoney(parts[1]);
    if (min != null || max != null) return { min, max };
  }
  return { min: parseMoney(input) };
}

export function parseSqft(input: unknown): number | undefined {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : undefined;
  }
  if (typeof input !== "string") return undefined;
  const m =
    input.match(/([\d,]+)\s*(?:sq\.?\s*(?:ft|feet)|sf\b|ft²|square\s*feet)/i) ??
    input.match(/^\s*([\d,]{3,5})\s*$/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  // Chicago apartments run roughly 300-6000 sqft; anything outside is a
  // mis-parse (a rent, a unit number, a year).
  if (!Number.isFinite(n) || n < 150 || n > 12_000) return undefined;
  return Math.round(n);
}

export function parseBedrooms(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input !== "string") return undefined;
  const s = input.toLowerCase();
  if (/\bstudio\b|\bconvertible\b|\befficiency\b|^s$|\bs0\b/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:bed|bd|br\b|bedroom)/) ?? s.match(/^(\d)\s*b$/);
  if (m) return Number(m[1]);
  // A cell that is *only* a small number came from a column already known to
  // be the bed count — table parsing relies on this.
  const bare = s.match(/^\s*(\d(?:\.5)?)\s*$/);
  if (bare) return Number(bare[1]);
  // "2x2" is a common shorthand for 2 bed / 2 bath.
  const x = s.match(/(\d)\s*x\s*(\d)/);
  if (x) return Number(x[1]);
  return undefined;
}

export function parseBathrooms(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input !== "string") return undefined;
  const s = input.toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba\b|bathroom)/);
  if (m) return Number(m[1]);
  const x = s.match(/(\d)\s*x\s*(\d(?:\.\d)?)/);
  if (x) return Number(x[2]);
  const bare = s.match(/^\s*(\d(?:\.5)?)\s*$/);
  if (bare) return Number(bare[1]);
  return undefined;
}

/**
 * Normalize an availability date to ISO. Handles "Now", "Available 8/15/26",
 * "Aug 15, 2026", "2026-08-15" and bare "8/15".
 *
 * @param today Injected so the "Now"/rollover behaviour is testable.
 */
export function parseAvailability(
  input: unknown,
  today = new Date(),
): string | undefined {
  if (input instanceof Date) return toIso(input);
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (!s) return undefined;
  if (/\b(now|immediate(ly)?|today|available\s+now|ready)\b/i.test(s)) {
    return toIso(today);
  }

  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year: number;
    if (slash[3]) {
      year = Number(slash[3]);
      if (year < 100) year += 2000;
    } else {
      year = rolloverYear(month, day, today);
    }
    return formatIso(year, month, day);
  }

  const named = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:(?:st|nd|rd|th))?(?:,?\s*(\d{4}))?/i);
  if (named) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month) {
      const day = Number(named[2]);
      const year = named[3] ? Number(named[3]) : rolloverYear(month, day, today);
      return formatIso(year, month, day);
    }
  }
  return undefined;
}

/** A bare "8/15" means the *next* 8/15, which may be next year. */
function rolloverYear(month: number, day: number, today: Date): number {
  const y = today.getFullYear();
  const candidate = new Date(Date.UTC(y, month - 1, day));
  const cutoff = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  );
  // Allow a small backward window so "available 7/28" today isn't pushed a year out.
  return candidate.getTime() < cutoff.getTime() - 45 * 86_400_000 ? y + 1 : y;
}

function formatIso(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toIso(d: Date): string {
  return formatIso(d.getFullYear(), d.getMonth() + 1, d.getDate())!;
}

export function parseLeaseTerm(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input !== "string") return undefined;
  const m = input.match(/(\d{1,2})\s*(?:mo|month)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? n : undefined;
}

/** Collapse whitespace and strip non-breaking spaces. */
export function clean(s: string | undefined | null): string {
  return (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Absolute-ise a possibly relative URL; returns undefined if unparseable. */
export function absoluteUrl(
  href: string | undefined | null,
  base: string,
): string | undefined {
  const h = clean(href);
  if (!h || h.startsWith("data:") || h.startsWith("#")) return undefined;
  try {
    return new URL(h, base).toString();
  } catch {
    return undefined;
  }
}

/** Slugify a plan name into a stable key. */
export function planKey(name: string): string {
  return clean(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "plan";
}
