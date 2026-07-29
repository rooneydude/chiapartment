/**
 * Identify the leasing platform behind a site.
 *
 * This is recorded separately from the adapter that ends up parsing the page.
 * Knowing that a building runs Entrata is useful even when a generic adapter
 * does the extraction — it tells you which sites will break together when a
 * vendor changes their markup, and which XHR to look for when one stops
 * returning units.
 */

export interface PlatformFingerprint {
  id: string;
  label: string;
  /** Where availability lives, for the "this stopped working" runbook. */
  hint: string;
  patterns: RegExp[];
}

export const PLATFORMS: PlatformFingerprint[] = [
  {
    id: "entrata",
    label: "Entrata",
    hint: "Availability is usually at /floorplans and served by an XHR to /floorplans/... on the same origin.",
    patterns: [/entrata\.com/i, /prospectportal\.com/i, /EntrataDataLayer/i, /entrata-/i],
  },
  {
    id: "rentcafe",
    label: "Yardi RENTCafé",
    hint: "Availability comes from rentcafeapi.aspx keyed by a numeric propertyId.",
    patterns: [/rentcafe\.com/i, /securecafe\.com/i, /RENTCafe/i, /yardi/i],
  },
  {
    id: "realpage",
    label: "RealPage / OneSite",
    hint: "Availability is rendered by a OneSite widget; look for an XHR to a realpage.com host.",
    patterns: [/realpage\.com/i, /onesite/i, /myltm/i, /rpiwidget/i],
  },
  {
    id: "funnel",
    label: "Funnel Leasing",
    hint: "Funnel front-ends fetch availability from an api.funnelleasing.com endpoint.",
    patterns: [/funnelleasing\.com/i, /nestiolistings\.com/i, /\bnestio\b/i],
  },
  {
    id: "appfolio",
    label: "AppFolio",
    hint: "Listings JSON is at <account>.appfolio.com/listings.json.",
    patterns: [/appfolio\.com/i],
  },
  {
    id: "knock",
    label: "Knock / RentPath",
    hint: "Knock-hosted sites proxy availability through a knockcrm.com API.",
    patterns: [/knockcrm\.com/i, /knock-/i],
  },
  {
    id: "next",
    label: "Bespoke (Next.js)",
    hint: "Availability is normally embedded in __NEXT_DATA__ or the RSC flight payload.",
    patterns: [/__NEXT_DATA__/, /self\.__next_f\.push/, /\/_next\/static\//],
  },
  {
    id: "wordpress",
    label: "Bespoke (WordPress)",
    hint: "Check for a wp-json REST route exposing the availability custom post type.",
    patterns: [/wp-content|wp-includes|wp-json/i],
  },
];

export function detectPlatform(html: string, url = ""): PlatformFingerprint | null {
  const haystack = `${url}\n${html}`;
  let best: { fp: PlatformFingerprint; hits: number } | null = null;
  for (const fp of PLATFORMS) {
    const hits = fp.patterns.filter((p) => p.test(haystack)).length;
    // A bespoke front-end framework is a weaker signal than a leasing vendor,
    // so it only wins when no vendor matched at all.
    if (hits === 0) continue;
    const weighted = fp.id === "next" || fp.id === "wordpress" ? hits * 0.5 : hits;
    if (!best || weighted > best.hits) best = { fp, hits: weighted };
  }
  return best?.fp ?? null;
}
