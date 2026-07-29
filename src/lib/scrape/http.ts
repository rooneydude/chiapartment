import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Polite HTTP for scraping.
 *
 * Three rules, enforced here rather than left to each adapter:
 *   1. robots.txt is fetched once per host and honoured. A disallowed path is
 *      a hard error, not a warning.
 *   2. Requests to the same host are serialized with a crawl delay.
 *   3. Responses are cached on disk so re-running a parse during development
 *      costs the building nothing.
 */

export const USER_AGENT =
  process.env.CHIAPARTMENT_UA ??
  "chiapartment/0.1 (personal apartment-hunting tool; +https://github.com/rooneydude/chiapartment)";

const CACHE_DIR = process.env.CHIAPARTMENT_CACHE ?? resolve(".scrape-cache");

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt disallows ${url} for ${USER_AGENT}`);
    this.name = "RobotsDisallowedError";
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
}

const robotsCache = new Map<string, RobotsRules>();

/**
 * Minimal robots.txt evaluator implementing the parts that matter: group
 * selection by user-agent, longest-match-wins between Allow and Disallow, and
 * Crawl-delay. `*` wildcards and `$` anchors are supported.
 */
export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: RobotsRules }> = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (!current) continue;
    lastWasAgent = false;
    if (field === "allow") current.rules.allow.push(value);
    else if (field === "disallow") current.rules.disallow.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.rules.crawlDelay = n;
    }
  }

  // Most specific matching group wins: exact UA token, then "*".
  const exact = groups.find((g) =>
    g.agents.some((a) => a !== "*" && ua.includes(a)),
  );
  const star = groups.find((g) => g.agents.includes("*"));
  return exact?.rules ?? star?.rules ?? { allow: [], disallow: [] };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

export function isAllowedByRobots(rules: RobotsRules, path: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const p of rules.allow) {
    if (p && patternToRegex(p).test(path)) bestAllow = Math.max(bestAllow, p.length);
  }
  for (const p of rules.disallow) {
    if (p === "") continue; // `Disallow:` with no value means "allow everything"
    if (patternToRegex(p).test(path)) bestDisallow = Math.max(bestDisallow, p.length);
  }
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

async function loadRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: RobotsRules = { allow: [], disallow: [] };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    // A missing robots.txt means "no restrictions"; a 5xx means we should back
    // off entirely, which the caller treats as disallowed.
    if (res.status === 200) rules = parseRobots(await res.text(), USER_AGENT);
    else if (res.status >= 500) rules = { allow: [], disallow: ["/"] };
  } catch {
    // Network failure fetching robots.txt — assume permissive but keep the
    // crawl delay conservative.
    rules = { allow: [], disallow: [], crawlDelay: 5 };
  }
  robotsCache.set(origin, rules);
  return rules;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const hostQueue = new Map<string, Promise<void>>();
const lastRequestAt = new Map<string, number>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialize per host and enforce a minimum gap between requests. */
async function withHostLock<T>(
  host: string,
  delaySec: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = hostQueue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  hostQueue.set(host, prior.then(() => gate));

  await prior;
  try {
    const last = lastRequestAt.get(host) ?? 0;
    const wait = last + delaySec * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function cachePath(url: string, init?: RequestInit): string {
  const key = createHash("sha256")
    .update(url)
    .update(String(init?.method ?? "GET"))
    .update(typeof init?.body === "string" ? init.body : "")
    .digest("hex")
    .slice(0, 32);
  return join(CACHE_DIR, `${key}.json`);
}

interface CacheEntry {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchedAt: number;
}

function readCache(path: string, maxAgeSec: number): CacheEntry | null {
  try {
    const st = statSync(path);
    if ((Date.now() - st.mtimeMs) / 1000 > maxAgeSec) return null;
    return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export interface FetcherOptions {
  /** Minimum seconds between requests to the host. robots.txt can raise this. */
  crawlDelaySec?: number;
  /** Serve from disk cache when the entry is younger than this. 0 disables. */
  cacheMaxAgeSec?: number;
  /** Skip the robots.txt check. Only for replaying local fixtures. */
  ignoreRobots?: boolean;
  onLog?: (msg: string) => void;
}

export interface Fetcher {
  (url: string, init?: RequestInit): Promise<Response>;
  getText(url: string): Promise<string>;
  getJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  /** Crawl delay actually in force, after consulting robots.txt. */
  effectiveDelay(origin: string): Promise<number>;
}

export function createFetcher(opts: FetcherOptions = {}): Fetcher {
  const {
    crawlDelaySec = 2,
    cacheMaxAgeSec = 0,
    ignoreRobots = false,
    onLog = () => {},
  } = opts;

  const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const origin = u.origin;

    if (!ignoreRobots) {
      const rules = await loadRobots(origin);
      if (!isAllowedByRobots(rules, u.pathname + u.search)) {
        throw new RobotsDisallowedError(url);
      }
    }
    const rules = ignoreRobots ? undefined : await loadRobots(origin);
    const delay = Math.max(crawlDelaySec, rules?.crawlDelay ?? 0);

    if (cacheMaxAgeSec > 0) {
      const hit = readCache(cachePath(url, init), cacheMaxAgeSec);
      if (hit) {
        onLog(`cache hit ${url}`);
        return new Response(hit.body, { status: hit.status, headers: hit.headers });
      }
    }

    return withHostLock(u.host, delay, async () => {
      onLog(`GET ${url}`);
      const res = await fetch(url, {
        ...init,
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          ...(init?.headers as Record<string, string> | undefined),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(45_000),
      });

      if (cacheMaxAgeSec > 0 && res.ok) {
        const body = await res.clone().text();
        mkdirSync(CACHE_DIR, { recursive: true });
        const entry: CacheEntry = {
          url,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body,
          fetchedAt: Date.now(),
        };
        writeFileSync(cachePath(url, init), JSON.stringify(entry));
      }
      return res;
    });
  };

  const fetcher = doFetch as Fetcher;

  fetcher.getText = async (url) => {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return res.text();
  };

  fetcher.getJson = async <T,>(url: string, init?: RequestInit) => {
    const res = await doFetch(url, init);
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `GET ${url} → expected JSON, got ${text.slice(0, 120).replace(/\s+/g, " ")}…`,
      );
    }
  };

  fetcher.effectiveDelay = async (origin) => {
    if (ignoreRobots) return crawlDelaySec;
    const rules = await loadRobots(origin);
    return Math.max(crawlDelaySec, rules.crawlDelay ?? 0);
  };

  return fetcher;
}

/** Exposed for the CLI's `--add` probe. */
export async function checkRobots(url: string) {
  const u = new URL(url);
  const rules = await loadRobots(u.origin);
  return {
    allowed: isAllowedByRobots(rules, u.pathname + u.search),
    crawlDelay: rules.crawlDelay,
  };
}
