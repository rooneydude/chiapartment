import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * After a deployment: does the site serve what was just built?
 *
 * On 23 Nov 2026 a refresh scraped six of six buildings, committed the
 * snapshot, built the site and deployed it; every step was green. The site
 * went on serving the build from before the snapshot (two deployments of one
 * commit had met, and GitHub Pages kept the first). Nothing looked at the
 * page a person would open. This does. Every build of the site's data is
 * stamped with the time it was made (`health.generated` in data/config.json),
 * and the live copy has to carry this build's stamp, or a later one.
 *
 * The build's stamp rather than its newest snapshot's, so that a deployment
 * which changes only the code is held to the same test. "Or a later one",
 * because another deployment may have followed. And, told the newest
 * snapshot on the branch, it holds the page to that as well: a copy built
 * from a commit without the day's snapshot carries the right stamp and the
 * wrong data, and a green run has to mean that the page shows the newest
 * data there is. Looked for again and again,
 * because the site's own answers allow a copy to be reused for ten minutes
 * (`cache-control: max-age=600`): the looking goes on for twelve. And each
 * look has a time limit, so the check itself always ends — twenty-five
 * looks of at most twenty seconds, half a minute apart, is about twenty
 * minutes at the very worst.
 */

/** What a copy of the site's data says about itself. */
export interface BuiltCopy {
  /** When it was built: `health.generated`. */
  builtAt: string;
  /** The time of the newest snapshot in it; null when it holds none, or does not say. */
  latestSnapshot: string | null;
}

function readCopy(config: unknown): BuiltCopy | null {
  const health = (config as { health?: { generated?: unknown; latestSnapshot?: unknown } } | null)?.health;
  if (typeof health?.generated !== "string" || health.generated === "") return null;
  const latest = health.latestSnapshot;
  return { builtAt: health.generated, latestSnapshot: typeof latest === "string" && latest !== "" ? latest : null };
}

/** In words that complete "the site serves …". */
export function describeCopy(copy: BuiltCopy): string {
  return `a copy built at ${copy.builtAt}${copy.latestSnapshot === null ? "" : `, from the snapshot of ${copy.latestSnapshot}`}`;
}

/** The copy of the site's data compiled under `root` (web/public/data). */
export function builtCopy(root: string): BuiltCopy {
  const file = join(root, "web", "public", "data", "config.json");
  if (!existsSync(file)) throw new Error("web/public/data/config.json is missing: the site's data has not been compiled (npm run build:data).");
  const copy = readCopy(JSON.parse(readFileSync(file, "utf8")));
  if (copy === null) throw new Error("web/public/data/config.json does not say when it was built (health.generated), so the site could not be checked against it.");
  return copy;
}

/**
 * A build stamp as a moment, or null when the text is not one. Only a full
 * date and time with its zone counts — the form the build writes. Left to
 * itself JavaScript reads "1" as the year 2001 and "2027" as a date, and a
 * check held to either would pass everything or nothing.
 */
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
export function instant(stamp: string): number | null {
  if (!INSTANT.test(stamp)) return null;
  const at = Date.parse(stamp);
  return Number.isNaN(at) ? null : at;
}

export interface LiveCheck {
  /** The site's address, as GitHub Pages gives it after a deployment. */
  siteUrl: string;
  /** When the copy that was deployed was built: its `health.generated`. */
  builtAt: string;
  /** The time of the newest snapshot on the branch. Given, the live copy's data has to be at least that new. */
  newestSnapshot?: string;
  /** How many times to look before giving up. */
  attempts?: number;
  /** How long to wait between looks. */
  waitMs?: number;
  /** How long one look may take before it counts as no answer. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock: for the address of each look, and for saying how long the looking took. */
  now?: () => number;
  log?: (line: string) => void;
}

export type LiveResult =
  | { ok: true; served: BuiltCopy; attempts: number }
  | {
      ok: false;
      /** What the last look found, in words that complete "…: the site <seen>". */
      seen: string;
      attempts: number;
      /** The last look read a copy, and it was an older one. Only then is the page known to be behind. */
      behind: boolean;
      /** How long the looking took, first look to last. */
      elapsedMs: number;
    };

export const DEFAULT_ATTEMPTS = 25;
export const DEFAULT_WAIT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Where the check looks. A site address without a final slash still means the site, not its parent folder. */
export function liveDataUrl(siteUrl: string): URL {
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error(`Not a web address: ${siteUrl}`);
  }
  if (site.protocol !== "https:" && site.protocol !== "http:") throw new Error(`Not a web address: ${siteUrl}`);
  if (!site.pathname.endsWith("/")) site.pathname += "/";
  return new URL("data/config.json", site);
}

/** Why a request failed, as far as Node says: its fetch puts the reason in `cause`, behind a bare "fetch failed". */
function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  const why = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return why !== "" && why !== error.message ? `${error.message}: ${why}` : error.message;
}

/** One look at the live site: the copy it serves, or why that could not be learned. */
async function look(url: URL, doFetch: typeof fetch, timeoutMs: number): Promise<{ copy: BuiltCopy } | { seen: string }> {
  // A server that takes the call and then says nothing, or stops half way
  // through its answer, is given this long and no longer.
  const limit = AbortSignal.timeout(timeoutMs);
  const silent = { seen: `did not answer within ${timeoutMs / 1000} s` };
  let response: Response;
  try {
    response = await doFetch(url, { headers: { "cache-control": "no-cache" }, redirect: "follow", signal: limit });
  } catch (error) {
    if (limit.aborted) return silent;
    return { seen: `could not be reached (${reason(error)})` };
  }
  if (!response.ok) return { seen: `answered HTTP ${response.status} for its data` };
  let config: unknown;
  try {
    config = await response.json();
  } catch (error) {
    if (limit.aborted) return silent;
    // An answer that is not JSON is one thing; an answer that broke off is another.
    if (error instanceof SyntaxError) return { seen: "answered with something that is not its data file" };
    return { seen: `stopped half way through its answer (${reason(error)})` };
  }
  const copy = readCopy(config);
  return copy === null ? { seen: "serves data that does not say when it was built" } : { copy };
}

export async function verifyLive(check: LiveCheck): Promise<LiveResult> {
  const attempts = Math.max(1, Math.floor(check.attempts ?? DEFAULT_ATTEMPTS));
  const waitMs = Math.max(0, check.waitMs ?? DEFAULT_WAIT_MS);
  const timeoutMs = Math.max(1, Math.floor(check.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const doFetch = check.fetch ?? fetch;
  const sleep = check.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = check.now ?? Date.now;
  const log = check.log ?? (() => {});
  const builtAt = instant(check.builtAt);
  if (builtAt === null) throw new Error(`The time this deployment's copy was built is not a time: ${JSON.stringify(check.builtAt)}`);
  const needSnapshot = check.newestSnapshot === undefined ? null : instant(check.newestSnapshot);
  if (check.newestSnapshot !== undefined && needSnapshot === null) {
    throw new Error(`The time of the newest snapshot on the branch is not a time: ${JSON.stringify(check.newestSnapshot)}`);
  }
  const url = liveDataUrl(check.siteUrl);

  const started = clock();
  let seen = "";
  let behind = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // The address differs each time, for any cache in between that goes by the whole address.
    url.searchParams.set("checked", `${clock()}-${attempt}`);
    const found = await look(url, doFetch, timeoutMs);
    behind = false;
    if ("copy" in found) {
      const servedAt = instant(found.copy.builtAt);
      const dataAt = found.copy.latestSnapshot === null ? null : instant(found.copy.latestSnapshot);
      const thisBuildOrLater = servedAt !== null && servedAt >= builtAt;
      const holdsNewest = needSnapshot === null || (dataAt !== null && dataAt >= needSnapshot);
      if (thisBuildOrLater && holdsNewest) return { ok: true, served: found.copy, attempts: attempt };
      behind = servedAt !== null;
      seen =
        servedAt === null
          ? `serves data built at ${JSON.stringify(found.copy.builtAt)}, which is not a time`
          : !thisBuildOrLater
            ? `serves ${describeCopy(found.copy)}`
            : dataAt === null
              ? // only what was seen: a copy that does not say what it holds has not been seen to lack anything
                `serves ${describeCopy(found.copy)}, which does not say in a form that can be read which snapshot it holds (the newest on the branch is that of ${check.newestSnapshot})`
              : `serves ${describeCopy(found.copy)}, which does not hold the newest snapshot on the branch (${check.newestSnapshot})`;
    } else {
      seen = found.seen;
    }
    log(`Look ${attempt} of ${attempts}: the site ${seen}; this deployment's copy was built at ${check.builtAt}.`);
    if (attempt < attempts) await sleep(waitMs);
  }
  return { ok: false, seen, attempts, behind, elapsedMs: clock() - started };
}

/** What the run's page says when the check fails. One line. */
export function staleSiteMessage(
  check: { siteUrl: string; builtAt: string },
  result: { seen: string; attempts: number; behind: boolean; elapsedMs: number },
): string {
  const minutes = Math.round(result.elapsedMs / 60_000);
  const over = result.attempts <= 1 ? "one look" : minutes >= 1 ? `${result.attempts} looks over about ${minutes} minute${minutes === 1 ? "" : "s"}` : `${result.attempts} looks`;
  // Only an older copy, read from the site, shows that the page is behind. A
  // site that could not be read shows nothing either way.
  const whatFollows = result.behind
    ? "No data is lost, every snapshot is committed before anything is deployed: the page is behind, and the next deployment should bring it up to date."
    : "No data is lost, every snapshot is committed before anything is deployed; but the site's data could not be read, so whether the page is behind is not known.";
  return `The site does not serve what this run deployed. This run's copy was built at ${check.builtAt}; after ${over} at ${check.siteUrl} the site ${result.seen}. ${whatFollows}`.replace(/[\r\n]+/g, " ");
}
