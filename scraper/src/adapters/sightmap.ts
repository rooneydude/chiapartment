import { parseLeaseTermMonths } from "../../../shared/src/parse";
import { chicagoDate, isIsoDay } from "../../../shared/src/time";
import type { BuildingConfig, LeaseTermPrice, UnitListing } from "../../../shared/src/types";
import { dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import { clipNotice, looksLikeChallenge, throwIfRefused } from "./guard";
import { SiteBlockedError, type Adapter, type AdapterContext } from "./types";

/**
 * SightMap (Engrain) — the interactive floorplate map many leasing sites
 * embed. Its pricing API carries every available unit with real unit number,
 * price, sqft, availability date, and specials; a per-unit leasing API adds
 * the full lease-term price table. Used by 1225 Old Town.
 *
 * Every unit the API lists is recorded — at the price and lease term the site
 * itself headlines, with the whole lease-term table attached. Nothing is
 * filtered or re-priced here: choosing which lease length to look at is the
 * dashboard's job, not the scraper's.
 */

export interface SightmapUnit {
  id: string;
  unit_number: string;
  /** Other spellings of the unit's name ("0812", "APT 0812"). */
  label?: string | null;
  display_unit_number?: string | null;
  floor_id: string;
  floor_plan_id: string;
  price: number;
  area: number | null;
  /** Earliest move-in day (YYYY-MM-DD); today's date for a vacant unit. */
  available_on: string | null;
  /** "Available Now" or "Available Dec 26th". */
  display_available_on?: string | null;
  specials_description?: string | null;
  /** e.g. "18 Months" — the lease term the advertised price applies to. */
  display_lease_term?: string | null;
  /**
   * Per-unit leasing API: lease term → price for ONE move-in day, chosen with
   * a `date=YYYY-MM-DD` query parameter. Without it the API assumes today and
   * answers `{"options": []}` for any unit that is not vacant yet (and for
   * any date before the unit's first available day).
   */
  leasing_price_url?: string | null;
  /** Ascending list of valid move-in days; its first entry is the earliest. */
  leasing_start_dates_url?: string | null;
  /** [min, max] mandatory monthly charges on top of base rent. */
  total_additional_expenses?: [number, number] | null;
  /**
   * The unit's charges by kind — a list of groups, of which the one with key
   * "monthly" is what is owed every month — and, by expense id, what the site
   * says each costs: numbers, or only words ("Varies"). Typed as unknown on
   * purpose: this part of the feed changed shape overnight on 17 Nov 2026, and
   * whatever it turns into next must not be able to break the scrape.
   */
  static_expenses?: unknown;
  expense_amounts?: unknown;
  static_expense_amounts?: unknown;
}

const asRecord = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const wordsOf = (x: unknown): string => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
/** 100, "100.00", "$1,100.00" → the number; anything else → null. */
const amountOf = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  const cleaned = x.replace(/[$,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

/**
 * Required monthly charges the feed lists with no amount — only words such as
 * "Varies" or "Usage-Based" — as "Label: the site's words". On 17 Nov 2026 the
 * building's utility bundle went from "$100–$230" to "Varies": the rent the
 * site then headlines is no longer the monthly bill, and a tracker that only
 * adds up the charges with numbers on them would quietly drop that fact.
 *
 * It repeats only what the feed says. A charge is listed when the feed marks
 * it required, monthly, switched on, not already included in the rent and not
 * situational, AND gives it words in place of an amount. A charge priced as a
 * number, a percentage or a scale is priced; one the feed says nothing about
 * is left out rather than called "unpriced".
 *
 * It cannot throw: this field describes charges, and whatever shape the feed
 * takes next, it must never cost the building its day of prices.
 */
export function unpricedMonthlyCharges(u: SightmapUnit): string[] {
  const out: string[] = [];
  try {
    const groups: unknown = u.static_expenses;
    if (!Array.isArray(groups)) return out;
    const amountMaps = [asRecord(u.expense_amounts), asRecord(u.static_expense_amounts)];
    for (const rawGroup of groups) {
      const group = asRecord(rawGroup);
      if (!group || group["key"] !== "monthly" || !Array.isArray(group["expenses"])) continue;
      for (const rawExpense of group["expenses"]) {
        const expense = asRecord(rawExpense);
        if (!expense) continue;
        if (expense["is_required"] !== true) continue;
        if (expense["is_enabled"] === false || expense["is_included"] === true || expense["is_situational"] === true) continue;
        if (typeof expense["frequency"] === "string" && expense["frequency"] !== "month") continue;
        const label = wordsOf(expense["label"]);
        const id =
          typeof expense["id"] === "string" || typeof expense["id"] === "number" ? String(expense["id"]) : "";
        if (!label || !id) continue;
        const amount = asRecord(amountMaps[0]?.[id]) ?? asRecord(amountMaps[1]?.[id]);
        if (!amount) continue; // the feed says nothing about what it costs: nothing to repeat
        const priced =
          [amount["min_amount"], amount["max_amount"], amount["amount"]].some((v) => (amountOf(v) ?? 0) > 0) ||
          amountOf(amount["percentage_amount"]) !== null ||
          (Array.isArray(amount["stepped_amounts"]) && amount["stepped_amounts"].length > 0);
        if (priced) continue;
        const said = wordsOf(amount["display_amount"]) || wordsOf(amount["text_amount"]);
        if (!said) continue;
        const entry = `${label}: ${said}`;
        if (!out.includes(entry)) out.push(entry);
      }
    }
  } catch {
    return [];
  }
  return out;
}

export interface SightmapPlan {
  id: string;
  name: string;
  bedroom_count: number;
  bathroom_count: number;
  /** "Studio", "1 Bed" … null on placeholder plans such as "TEMP / Coming Soon". */
  bedroom_label?: string | null;
  filter_label?: string | null;
}

export interface SightmapPayload {
  data: {
    id: string;
    floors: { id: string; filter_short_label: string }[];
    floor_plans: SightmapPlan[];
    units: SightmapUnit[];
    unit_map?: { url?: string };
  };
}

/** Plan names are sometimes serialized JSON junk — clean or fall back. */
export function cleanPlanName(
  plan: { name: string; bedroom_count: number },
): string {
  let name = plan.name?.trim() ?? "";
  if (name.startsWith("{")) {
    try {
      const parsed = JSON.parse(name) as { name?: string };
      name = parsed.name?.trim() ?? "";
    } catch {
      name = "";
    }
  }
  name = name.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 40) {
    return plan.bedroom_count === 0 ? "Studio" : `${plan.bedroom_count} BR`;
  }
  return name;
}

async function fetchText(url: string, ctx: AdapterContext, kind: string): Promise<string> {
  const res = await ctx.fetch(url);
  const text = await res.text();
  // A refusal by the site's bot protection is recorded as such, never as a
  // parse error — and never asked again in the same run.
  throwIfRefused(`the ${kind} request`, res.status, res.headers.get("content-type"), text);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${kind} ${url}`);
  ctx.record?.(url, text, res.headers.get("content-type") ?? "text/html");
  return text;
}

/**
 * Resolve the pricing-API URL: pinned adapterOptions.sightmapApiUrl, else
 * discover the embed on the site's floorplans page, then the API path inside
 * the embed. Every hop is recorded in capture mode.
 */
export async function resolveSightmapApiUrl(
  building: BuildingConfig,
  ctx: AdapterContext,
): Promise<string> {
  const pinned = building.adapterOptions?.["sightmapApiUrl"];
  if (typeof pinned === "string" && pinned.length > 0) return pinned;

  const pageUrl = new URL("floorplans", building.url).href;
  const html = await fetchText(pageUrl, ctx, "floorplans page");
  const embed = /https:\/\/sightmap\.com\/embed\/(\w+)/.exec(html);
  if (!embed) throw new Error(`no SightMap embed found on ${pageUrl}`);

  const embedHtml = await fetchText(embed[0], ctx, "SightMap embed");
  const api = /app\/api\/v1\/\w+\/sightmaps\/\d+/.exec(embedHtml);
  if (!api) throw new Error(`no SightMap API path found in embed ${embed[0]}`);
  return `https://sightmap.com/${api[0]}`;
}

const TERM_KEY = /^(lease_)?term(_months|_length)?$|^months$|^lease_months$/i;
const PRICE_KEY = /^(price|rent|amount|rate|monthly_price|base_rent)$/i;

/**
 * Pull {term, price} pairs out of a leasing-matrix payload without assuming
 * its exact shape: any object carrying a plausible term field and a plausible
 * price field counts. Terms labeled as strings ("14 Months") work too.
 * Dedupes to the cheapest price seen per term. Fallback for payloads that do
 * not match the documented `data.options[]` shape (see parseLeaseTable).
 */
export function extractTermPrices(json: unknown): Map<number, number> {
  const best = new Map<number, number>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    let term: number | null = null;
    let price: number | null = null;
    for (const [k, v] of Object.entries(obj)) {
      if (term === null && TERM_KEY.test(k)) {
        if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 36) term = v;
        else if (typeof v === "string") term = parseLeaseTermMonths(v);
      }
      if (price === null && PRICE_KEY.test(k)) {
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string"
              ? Number.parseFloat(v.replace(/[^0-9.]/g, ""))
              : NaN;
        if (Number.isFinite(n) && n >= MIN_SANE_RENT && n <= MAX_SANE_RENT) price = Math.round(n);
      }
    }
    if (term !== null && price !== null) {
      const prev = best.get(term);
      if (prev === undefined || price < prev) best.set(term, price);
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(json);
  return best;
}

/** The leasing-API URL for one move-in day (see SightmapUnit.leasing_price_url). */
export function leasingUrlForDate(leasingUrl: string, moveInDay: string | null): string {
  if (!moveInDay || !isIsoDay(moveInDay)) return leasingUrl;
  try {
    const u = new URL(leasingUrl);
    u.searchParams.set("date", moveInDay);
    return u.href;
  } catch {
    return leasingUrl;
  }
}

export interface LeaseTable {
  terms: LeaseTermPrice[];
  /** lease term → the site's own "apply for this unit at this term" link. */
  applyUrls: Map<number, string>;
}

/**
 * Parse a leasing-API payload into a sorted lease-term table. The documented
 * shape is `{data: {options: [{lease_term, price, apply_url}]}}`; anything
 * else falls back to the shape-agnostic extractor.
 */
export function parseLeaseTable(json: unknown): LeaseTable {
  const byTerm = new Map<number, number>();
  const applyUrls = new Map<number, string>();
  const options = (json as { data?: { options?: unknown } } | null)?.data?.options;
  if (Array.isArray(options)) {
    for (const raw of options) {
      if (raw === null || typeof raw !== "object") continue;
      const opt = raw as { lease_term?: unknown; price?: unknown; apply_url?: unknown };
      const months = typeof opt.lease_term === "number" ? opt.lease_term : Number.NaN;
      const price = typeof opt.price === "number" ? opt.price : Number.NaN;
      if (!Number.isInteger(months) || months < 1 || months > 36) continue;
      // No rent ceiling here: these are the site's own quotes, and a 2-month
      // lease on a 2-bed really is quoted above $23,000.
      if (!Number.isFinite(price) || price <= 0) continue;
      byTerm.set(months, Math.round(price));
      if (typeof opt.apply_url === "string" && opt.apply_url.startsWith("https://")) {
        applyUrls.set(months, opt.apply_url);
      }
    }
  }
  const source = byTerm.size > 0 ? byTerm : extractTermPrices(json);
  const terms = [...source.entries()]
    .map(([months, price]) => ({ months, price }))
    .sort((a, b) => a.months - b.months);
  return { terms, applyUrls };
}

/**
 * Fetch a unit's lease-term table for its earliest move-in day. When the
 * table comes back empty for the payload's date (the API rejects any day
 * before the unit's first start date), ask the start-dates endpoint for the
 * real first day and try once more. Null when the unit has no leasing URL,
 * a request fails, or the table stays empty — the unit is still recorded,
 * just without the table, and the reason is logged.
 */
async function fetchLeaseTable(
  u: SightmapUnit,
  moveInDay: string | null,
  ctx: AdapterContext,
): Promise<LeaseTable | null> {
  if (!u.leasing_price_url) return null;
  const tableFor = async (day: string | null): Promise<LeaseTable> =>
    parseLeaseTable(
      JSON.parse(await fetchText(leasingUrlForDate(u.leasing_price_url!, day), ctx, "leasing matrix")),
    );
  try {
    let table = await tableFor(moveInDay);
    if (table.terms.length === 0 && u.leasing_start_dates_url) {
      await ctx.pause?.(250);
      const dates = (
        JSON.parse(await fetchText(u.leasing_start_dates_url, ctx, "lease start dates")) as {
          data?: unknown;
        }
      ).data;
      const first = Array.isArray(dates)
        ? dates.filter((d): d is string => typeof d === "string" && isIsoDay(d)).sort()[0]
        : undefined;
      if (first && first !== moveInDay) {
        await ctx.pause?.(250);
        table = await tableFor(first);
      }
    }
    if (table.terms.length === 0) {
      ctx.log(`lease terms for unit ${u.unit_number}: the site returned an empty table`);
      return null;
    }
    return table;
  } catch (err) {
    // A refusal is the caller's business: it stops asking for the other units.
    if (err instanceof SiteBlockedError) throw err;
    ctx.log(
      `lease terms for unit ${u.unit_number} unavailable (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
}

/**
 * Best-effort enrichment from the property's marketing page (same building,
 * different system): the site-wide special it announces, and the day each
 * vacant unit actually became available (SightMap only says "today"). The
 * page sits behind a WAF that sometimes refuses datacenter IPs — any failure
 * here is logged and ignored; the listing itself never depends on it.
 */
export interface MarketingExtras {
  notices: string[];
  /** SightMap unit id → ISO day the unit became available. */
  vacantSince: Map<string, string>;
  /**
   * Whether the page carried what is read from it (the floor-plan widget's
   * data, or the building's announcements). A page that answers with
   * something else — a maintenance notice — has no offers and no dates on it,
   * which is not the same as the building having none.
   */
  recognised: boolean;
}

export function parseMarketingPage(html: string): MarketingExtras {
  const notices: string[] = [];
  const vacantSince = new Map<string, string>();
  let recognised = false;

  // JSON-LD: "jonah:announcements": [{ "jonah:name": "…$1,500 Off Base Rent…", … }]
  const ldBlocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const announcements = obj["jonah:announcements"];
    if (Array.isArray(announcements)) {
      for (const a of announcements) {
        if (a === null || typeof a !== "object") continue;
        const rec = a as Record<string, unknown>;
        const name = typeof rec["jonah:name"] === "string" ? rec["jonah:name"].trim() : "";
        const desc =
          typeof rec["jonah:description"] === "string" ? rec["jonah:description"].trim() : "";
        // A long announcement (fine print added) is shortened, never dropped.
        const text = clipNotice([name, desc].filter(Boolean).join(" — "));
        if (text && !notices.includes(text)) notices.push(text);
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  for (const m of ldBlocks) {
    // the building's own vocabulary: this is its page, announcements or not
    if (m[1]!.includes('"jonah:')) recognised = true;
    try {
      visit(JSON.parse(m[1]!));
    } catch {
      // a malformed JSON-LD block is not our problem
    }
  }

  // Jonah floorplan widget: units[].id_value is the SightMap unit id,
  // available_date is unix seconds at local midnight.
  const blob = /<script[^>]*id=["']jd-fp-data-script-app["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (blob) {
    recognised = true;
    try {
      const units = (JSON.parse(blob[1]!) as { units?: unknown }).units;
      if (Array.isArray(units)) {
        for (const raw of units) {
          if (raw === null || typeof raw !== "object") continue;
          const r = raw as Record<string, unknown>;
          const id = typeof r["id_value"] === "string" ? r["id_value"] : null;
          const ts =
            typeof r["available_date"] === "number"
              ? r["available_date"]
              : typeof r["available_date"] === "string" && /^\d{9,10}$/.test(r["available_date"])
                ? Number.parseInt(r["available_date"], 10)
                : Number.NaN;
          if (id && Number.isFinite(ts) && ts > 1e9) {
            vacantSince.set(id, chicagoDate(new Date(ts * 1000)));
          }
        }
      }
    } catch {
      // ignore — enrichment only
    }
  }
  return { notices, vacantSince, recognised };
}

async function fetchMarketingExtras(
  building: BuildingConfig,
  ctx: AdapterContext,
): Promise<MarketingExtras | null> {
  const pageUrl = new URL("floorplans/", building.url).href;
  try {
    const res = await ctx.fetch(pageUrl);
    if (!res.ok) {
      ctx.log(`marketing page not available (HTTP ${res.status}) — specials and vacancy dates skipped`);
      // 401 / 403 / 429 is a refusal: said as one, and left alone.
      ctx.reportGap?.(marketingGap(looksLikeChallenge("", res.status) ? "refused" : "unread", `HTTP ${res.status}`));
      return null;
    }
    const html = await res.text();
    ctx.record?.(pageUrl, html, "text/html");
    if (looksLikeChallenge(html, res.status)) {
      ctx.log("marketing page refused the request (bot protection) — specials and vacancy dates skipped");
      ctx.reportGap?.(marketingGap("refused", "a bot-protection page"));
      return null;
    }
    const extras = parseMarketingPage(html);
    if (!extras.recognised) {
      ctx.log("marketing page answered, but not with its floor-plan page — specials and vacancy dates skipped");
      ctx.reportGap?.(marketingGap("unrecognised", ""));
    }
    return extras;
  } catch (err) {
    ctx.log(
      `marketing page not available (${err instanceof Error ? err.message : err}) — specials and vacancy dates skipped`,
    );
    ctx.reportGap?.(marketingGap("unread", "the request failed"));
    return null;
  }
}

/**
 * The sentence shown on the building's page when its own website could not
 * be read. Without it, yesterday's special offer simply vanishing reads as
 * "the offer ended" — when all that happened is that the page was not read.
 */
function marketingGap(kind: "refused" | "unread" | "unrecognised", how: string): string {
  return `The building’s own website ${
    kind === "refused"
      ? `refused the tracker this run (${how})`
      : kind === "unread"
        ? `could not be read this run (${how})`
        : "answered this run, but not with its floor-plan page"
  }. Its special offers and “vacant since” dates come from that page, so they are missing from this snapshot — the building has not necessarily withdrawn them.`;
}

export async function fetchSightmapPayload(
  building: BuildingConfig,
  ctx: AdapterContext,
): Promise<SightmapPayload> {
  const apiUrl = await resolveSightmapApiUrl(building, ctx);
  const text = await fetchText(apiUrl, ctx, "SightMap API");
  return JSON.parse(text) as SightmapPayload;
}

/** A whole number of bedrooms, as the API should give it; null for anything else. */
function bedroomCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10 ? v : null;
}

/** The unit's name: unit_number, else one of its other spellings. */
function unitName(u: SightmapUnit): string | null {
  for (const v of [u.unit_number, u.label, u.display_unit_number]) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const name = String(v).replace(/^(apt|unit|#)\.?\s*/i, "").trim();
    if (name && name.length <= 12) return name;
  }
  return null;
}

export const sightmap: Adapter = {
  id: "sightmap",
  async scrape(building, ctx) {
    const payload = await fetchSightmapPayload(building, ctx);
    const data = payload?.data;
    if (!data || !Array.isArray(data.units) || !Array.isArray(data.floor_plans)) {
      throw new Error("the SightMap API answered without a unit list — its format may have changed");
    }
    const plans = new Map(data.floor_plans.map((p) => [p.id, p]));
    const today = chicagoDate(ctx.now?.() ?? new Date());

    const extras = await fetchMarketingExtras(building, ctx);
    for (const notice of extras?.notices ?? []) ctx.reportNotice?.(notice);

    const listings: UnitListing[] = [];
    let withTerms = 0;
    let unnamed = 0;
    let alsoListedCount = 0;
    /** Once the lease-price API refuses, the remaining units are not asked for. */
    let leaseApiRefused = false;
    for (const u of data.units) {
      const unitNumber = unitName(u);
      const plan = plans.get(u.floor_plan_id);
      const availableOn = typeof u.available_on === "string" && isIsoDay(u.available_on) ? u.available_on : null;
      const saysNow = /\bnow\b/i.test(u.display_available_on ?? "");
      const availableNow = saysNow || (availableOn !== null && availableOn <= today);
      // The feed is rebuilt once a day (about 5 am Chicago) and stamps vacant
      // units with THAT day; a unit that can be moved into now is listed with
      // today's date, like everywhere else.
      const availableDate = availableNow ? today : availableOn;
      const sqft = typeof u.area === "number" && u.area > 100 ? Math.round(u.area) : null;
      const price = typeof u.price === "number" ? u.price : Number.parseFloat(String(u.price ?? ""));
      const priced = Number.isFinite(price) && price > 0;
      // A plan whose bedroom label is null and that has no bathrooms is a
      // placeholder ("TEMP / Coming Soon", bedroom_count 0) — not a studio.
      // A bedroom count that is not a whole number is no bed count at all.
      const beds = plan ? bedroomCount(plan.bedroom_count) : null;
      const bedsKnown =
        plan !== undefined && beds !== null && !(plan.bedroom_label === null && !plan.bathroom_count);

      if (unitNumber === null || !plan || !priced || !bedsKnown) {
        // On the site but not comparable: say so instead of dropping it.
        const note =
          unitNumber === null
            ? "Unit number not published"
            : !priced
              ? "No price published"
              : !plan
                ? "Floor plan not published"
                : `${plan.filter_label?.trim() || "Plan"} — bed count not published`;
        if (unitNumber === null) unnamed++;
        alsoListedCount++;
        ctx.log(`unit ${unitNumber ?? "(no number)"}: ${note.toLowerCase()} — kept in the also-listed list`);
        ctx.reportAlsoListed?.({
          unitNumber,
          floorplanName: plan ? cleanPlanName({ name: plan.name, bedroom_count: beds ?? 1 }) : "Unknown plan",
          beds: plan && bedsKnown ? beds : null,
          sqft,
          ...(priced ? { price: Math.round(price) } : {}),
          availableDate,
          ...(availableDate !== null ? { availableNow } : {}),
          note,
          url: building.url,
        });
        continue;
      }

      // The lease-term table is quoted for the unit's own earliest move-in
      // day — the feed's date for it; asking without a date returns nothing
      // for units not yet vacant.
      const term = parseLeaseTermMonths(u.display_lease_term);
      let table: LeaseTable | null = null;
      if (!leaseApiRefused) {
        await ctx.pause?.(250);
        try {
          table = await fetchLeaseTable({ ...u, unit_number: unitNumber }, availableOn ?? availableDate, ctx);
        } catch (err) {
          if (!(err instanceof SiteBlockedError)) throw err;
          leaseApiRefused = true;
          ctx.log(
            `the lease-price API refused the request for unit ${unitNumber} — not asking for the remaining units' lease tables this run`,
          );
        }
      }
      if (table) {
        withTerms++;
        const atTerm = term !== null ? table.terms.find((t) => t.months === term) : undefined;
        if (atTerm && Math.abs(atTerm.price - price) > 1) {
          ctx.log(
            `unit ${unitNumber}: site headlines $${price} @ ${term}mo but its lease table says $${atTerm.price} for that term`,
          );
        }
      }
      const applyUrl = term !== null ? table?.applyUrls.get(term) : undefined;

      const fees = u.total_additional_expenses;
      const monthlyFees =
        Array.isArray(fees) &&
        fees.length === 2 &&
        fees.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
        fees[1] > 0
          ? { min: Math.min(fees[0], fees[1]), max: Math.max(fees[0], fees[1]) }
          : undefined;
      const unpriced = unpricedMonthlyCharges(u);
      // "Convertible" plans are filed as studios by the site; keep the label.
      const planType = /convertible/i.test(`${plan.filter_label ?? ""} ${plan.name}`)
        ? "Convertible"
        : undefined;
      const since = availableNow ? extras?.vacantSince.get(u.id) : undefined;
      const baths = typeof plan.bathroom_count === "number" && plan.bathroom_count > 0 ? plan.bathroom_count : null;

      listings.push({
        unitNumber,
        floorplanName: cleanPlanName(plan),
        beds: beds!,
        ...(planType ? { planType } : {}),
        baths,
        sqft,
        price: Math.round(price),
        ...(monthlyFees ? { monthlyFees } : {}),
        ...(unpriced.length > 0 ? { monthlyFeesUnpriced: unpriced } : {}),
        leaseTermMonths: term,
        ...(table ? { leaseTerms: table.terms } : {}),
        availableDate,
        ...(availableDate !== null ? { availableNow } : {}),
        ...(since && since < today ? { vacantSince: since } : {}),
        ...(typeof u.specials_description === "string" && u.specials_description.trim()
          ? { specials: u.specials_description.trim() }
          : {}),
        url: applyUrl ?? building.url,
      });
    }

    // A feed full of units none of which can be named is a changed feed.
    if (data.units.length > 0 && unnamed === data.units.length) {
      throw new Error(
        `the SightMap API lists ${data.units.length} units but none carries a unit number — its format may have changed`,
      );
    }
    const unique = dedupeListings(listings);
    if (unique.length !== listings.length) {
      ctx.log(
        `${listings.length - unique.length} unit number(s) appear more than once in the feed — kept the first of each`,
      );
    }
    if (unique.length > 0 || alsoListedCount > 0) {
      ctx.log(
        `${data.units.length} units in the feed → ${unique.length} listed (${withTerms} with a lease-term price table), ${alsoListedCount} also listed`,
      );
    }
    return unique;
  },
};
