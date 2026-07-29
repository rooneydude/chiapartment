/**
 * Pull structured data out of a rendered HTML page.
 *
 * Modern marketing sites almost never put availability in the markup — it
 * arrives as JSON embedded in the document (Next.js flight data, `__NEXT_DATA__`,
 * Nuxt/Apollo state, JSON-LD) or via XHR. Recovering those blobs is far more
 * reliable than scraping the DOM, so it is tried first for every site.
 */

/** Scan for balanced JSON values and parse the ones that succeed. */
export function scanBalancedJson(
  text: string,
  opts: { minLength?: number; maxLength?: number } = {},
): unknown[] {
  const { minLength = 40, maxLength = 8_000_000 } = opts;
  const out: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const end = findBalancedEnd(text, i, maxLength);
    if (end < 0) {
      i++;
      continue;
    }
    const slice = text.slice(i, end + 1);
    if (slice.length >= minLength) {
      try {
        out.push(JSON.parse(slice));
        i = end + 1; // Skip the whole parsed region.
        continue;
      } catch {
        /* not valid JSON — fall through and advance by one */
      }
    }
    i++;
  }
  return out;
}

/** Index of the character closing the bracket at `start`, or -1. */
function findBalancedEnd(text: string, start: number, maxLength: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + maxLength);

  for (let i = start; i < limit; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Next.js App Router streams the RSC payload as a series of
 * `self.__next_f.push([1, "<chunk>"])` calls. Concatenating the chunks
 * reconstitutes the stream, which contains the page's data as JSON.
 */
export function extractNextFlightPayload(html: string): string {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      chunks.push(JSON.parse(m[1]) as string);
    } catch {
      /* malformed chunk — skip */
    }
  }
  return chunks.join("");
}

const STATE_GLOBALS = [
  "__NEXT_DATA__",
  "__NUXT__",
  "__APOLLO_STATE__",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__remixContext",
  "__sveltekit_data",
];

/**
 * Every JSON value the page carries, richest sources first. Callers hand these
 * to `harvestUnits` / `harvestPlans` rather than reasoning about which
 * framework the site happens to use.
 */
export function extractJsonBlobs(html: string): unknown[] {
  const blobs: unknown[] = [];

  // 1. <script type="application/json"> and JSON-LD — the cleanest source.
  const scriptRe =
    /<script\b[^>]*type=["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html))) {
    const body = m[1].trim();
    if (!body) continue;
    try {
      blobs.push(JSON.parse(body));
    } catch {
      // Some sites HTML-escape the payload or append trailing junk.
      blobs.push(...scanBalancedJson(decodeEntities(body)));
    }
  }

  // 2. `window.__X__ = {...}` style state globals.
  for (const name of STATE_GLOBALS) {
    const re = new RegExp(
      `(?:window|self)\\.${name}\\s*=\\s*`,
      "g",
    );
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(html))) {
      const from = hit.index + hit[0].length;
      const parsed = scanBalancedJson(html.slice(from, from + 4_000_000), {
        minLength: 2,
      });
      if (parsed.length) blobs.push(parsed[0]);
    }
  }

  // 3. Next.js App Router flight data.
  const flight = extractNextFlightPayload(html);
  if (flight) blobs.push(...scanBalancedJson(flight));

  return blobs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
