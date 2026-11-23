import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  builtCopy,
  DEFAULT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_MS,
  describeCopy,
  liveDataUrl,
  staleSiteMessage,
  verifyLive,
} from "../src/verify-live";

/**
 * The check that follows a deployment: does the site serve what was built?
 * (23 Nov 2026: a green run, and a site one snapshot behind.)
 */
const BUILT_AT = "2026-11-23T10:29:25.000Z"; // this deployment's copy
const BEFORE = "2026-11-23T10:25:11.000Z"; // the copy the site served until now
const SNAPSHOT = "2026-11-23T10:28:35Z";
const OLDER_SNAPSHOT = "2026-11-22T20:44:49Z";
const SITE = "https://example.github.io/tracker/";

/** The site's data file, as a copy built at `generated` from the snapshot of `latestSnapshot` serves it. */
const data = (generated?: string, latestSnapshot?: string): Response =>
  new Response(JSON.stringify({ buildings: [], health: { ...(generated ? { generated } : {}), buildings: {}, snapshots: 129, ...(latestSnapshot ? { latestSnapshot } : {}) } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A site that answers each look in turn (the last answer repeats), and a record of what was asked and how long was waited. */
function site(answers: (() => Response | Promise<Response>)[]) {
  const asked: string[] = [];
  const waited: number[] = [];
  let n = 0;
  const fetchStandIn = ((input: Parameters<typeof fetch>[0]) => {
    asked.push(String(input));
    return Promise.resolve(answers[Math.min(n++, answers.length - 1)]!());
  }) as typeof fetch;
  return { asked, waited, fetch: fetchStandIn, sleep: (ms: number) => (waited.push(ms), Promise.resolve()) };
}

describe("does the site serve what was deployed?", () => {
  it("yes, at once, when the live copy is the one this deployment built", async () => {
    const s = site([() => data(BUILT_AT, SNAPSHOT)]);
    expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep })).toEqual({
      ok: true,
      served: { builtAt: BUILT_AT, latestSnapshot: SNAPSHOT },
      attempts: 1,
    });
    expect(s.waited).toEqual([]);
    expect(s.asked[0]).toMatch(/^https:\/\/example\.github\.io\/tracker\/data\/config\.json\?checked=/);
  });

  it("yes, when the live copy was built later still: another deployment has followed", async () => {
    const s = site([() => data("2026-11-23T20:46:10.000Z", "2026-11-23T20:45:02Z")]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep })).ok).toBe(true);
  });

  it("no, when the site still serves the copy from before — 23 Nov: a snapshot behind", async () => {
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 4, waitMs: 1000, fetch: s.fetch, sleep: s.sleep });
    expect(result).toEqual({ ok: false, seen: `serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}`, attempts: 4 });
    expect(s.asked).toHaveLength(4);
    expect(s.waited).toEqual([1000, 1000, 1000]); // no wait after the last look
  });

  it("no, when only the code changed and the copy from before is still served: same snapshot, earlier build", async () => {
    const s = site([() => data(BEFORE, SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, fetch: s.fetch, sleep: s.sleep });
    expect(result).toEqual({ ok: false, seen: `serves a copy built at ${BEFORE}, from the snapshot of ${SNAPSHOT}`, attempts: 2 });
  });

  it("goes by when the copy was built, not by its snapshot: a later build of an older snapshot is still what was deployed last", async () => {
    const s = site([() => data(BUILT_AT, OLDER_SNAPSHOT)]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep })).ok).toBe(true);
  });

  it("compares the two as times, however each is written", async () => {
    for (const same of ["2026-11-23T10:29:25Z", "2026-11-23T04:29:25.000-06:00", "2026-11-23T10:29:25.000+00:00"]) {
      const s = site([() => data(same)]);
      expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep })).ok, same).toBe(true);
    }
    // one millisecond earlier is earlier
    const s = site([() => data("2026-11-23T10:29:24.999Z")]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, fetch: s.fetch, sleep: s.sleep })).ok).toBe(false);
  });

  it("looks again while the deployment is still reaching the servers, a different address each time", async () => {
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT), () => new Response("Not Found", { status: 404 }), () => data(BUILT_AT, SNAPSHOT)]);
    const lines: string[] = [];
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, waitMs: 15_000, fetch: s.fetch, sleep: s.sleep, log: (l) => lines.push(l) });
    expect(result).toEqual({ ok: true, served: { builtAt: BUILT_AT, latestSnapshot: SNAPSHOT }, attempts: 3 });
    expect(s.waited).toEqual([15_000, 15_000]);
    expect(new Set(s.asked).size).toBe(3);
    expect(lines).toEqual([
      `Look 1 of ${DEFAULT_ATTEMPTS}: the site serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}; this deployment's copy was built at ${BUILT_AT}.`,
      `Look 2 of ${DEFAULT_ATTEMPTS}: the site answered HTTP 404 for its data; this deployment's copy was built at ${BUILT_AT}.`,
    ]);
  });

  it("says what was in the way when the site's data could not be read at all", async () => {
    const cases: [answer: () => Response | Promise<Response>, seen: string][] = [
      [() => new Response("gone", { status: 503 }), "answered HTTP 503 for its data"],
      [() => new Response("<html>a sign-in page</html>", { status: 200 }), "answered with something that is not its data file"],
      [() => data(), "serves data that does not say when it was built"],
      [() => new Response("null", { status: 200 }), "serves data that does not say when it was built"],
      [() => new Response('{"buildings":[]}', { status: 200 }), "serves data that does not say when it was built"],
      [() => data("yesterday"), 'serves data built at "yesterday", which is not a time'],
      [() => Promise.reject(new Error("getaddrinfo ENOTFOUND example.github.io")), "could not be reached (getaddrinfo ENOTFOUND example.github.io)"],
    ];
    for (const [answer, seen] of cases) {
      const s = site([answer]);
      expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, fetch: s.fetch, sleep: s.sleep }), seen).toEqual({ ok: false, seen, attempts: 2 });
    }
  });

  it("goes on looking for twelve minutes — twenty-five looks, half a minute apart — unless told otherwise", async () => {
    // The site lets a copy be reused for ten minutes (cache-control: max-age=600). The looking has to outlast that.
    expect([DEFAULT_ATTEMPTS, DEFAULT_WAIT_MS]).toEqual([25, 30_000]);
    expect((DEFAULT_ATTEMPTS - 1) * DEFAULT_WAIT_MS).toBeGreaterThan(10 * 60_000);
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep });
    expect(result.attempts).toBe(25);
    expect(s.waited).toEqual(Array.from({ length: 24 }, () => 30_000));
  });

  describe("one look may not take for ever", () => {
    afterEach(() => vi.restoreAllMocks());
    const noWait = () => Promise.resolve();

    /** A site that takes the call and never says a word: the look ends only when its time is up. */
    function silentSite() {
      const limits: (AbortSignal | null | undefined)[] = [];
      const fetchStandIn = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const limit = init?.signal;
        limits.push(limit);
        return new Promise<Response>((_resolve, reject) => limit?.addEventListener("abort", () => reject(limit.reason)));
      }) as typeof fetch;
      return { limits, fetch: fetchStandIn };
    }

    it("a site that takes the call and says nothing counts as not answering, look after look", async () => {
      const s = silentSite();
      const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, waitMs: 0, timeoutMs: 40, fetch: s.fetch, sleep: noWait });
      expect(result).toEqual({ ok: false, seen: "did not answer within 0.04 s", attempts: 2 });
      expect(s.limits).toHaveLength(2);
      expect(s.limits[0]).toBeInstanceOf(AbortSignal);
      expect(s.limits[0]).not.toBe(s.limits[1]); // each look has its own time
    });

    it("so does one that starts its answer and stops half way", async () => {
      const stalls = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const limit = init!.signal!;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"health":{"generated":"'));
            limit.addEventListener("abort", () => controller.error(limit.reason));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;
      const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 1, timeoutMs: 40, fetch: stalls, sleep: noWait });
      expect(result).toEqual({ ok: false, seen: "did not answer within 0.04 s", attempts: 1 });
    });

    it("an answer that is cut off for another reason is not blamed on the clock", async () => {
      const cutOff = (() => Promise.reject(new DOMException("This operation was aborted", "AbortError"))) as typeof fetch;
      const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 1, timeoutMs: 60_000, fetch: cutOff, sleep: noWait });
      expect(result).toEqual({ ok: false, seen: "could not be reached (This operation was aborted)", attempts: 1 });
    });

    it("the limit is twenty seconds a look unless told otherwise", async () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
      const asked = vi.spyOn(AbortSignal, "timeout");
      const s = site([() => data(BUILT_AT)]);
      await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep });
      expect(asked.mock.calls).toEqual([[20_000]]);
      await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, timeoutMs: 2500, fetch: s.fetch, sleep: s.sleep });
      expect(asked.mock.calls).toEqual([[20_000], [2500]]);
    });
  });

  it("looks under the site's own address, with or without a final slash", () => {
    expect(String(liveDataUrl("https://example.github.io/tracker/"))).toBe("https://example.github.io/tracker/data/config.json");
    expect(String(liveDataUrl("https://example.github.io/tracker"))).toBe("https://example.github.io/tracker/data/config.json");
    expect(String(liveDataUrl("https://tracker.example.com"))).toBe("https://tracker.example.com/data/config.json");
    expect(() => liveDataUrl("not an address")).toThrow();
    expect(() => liveDataUrl("file:///etc/passwd")).toThrow(/Not a web address/);
  });

  it("refuses a build time that is not a time, rather than pass or fail on a guess", async () => {
    const s = site([() => data(BUILT_AT)]);
    await expect(verifyLive({ siteUrl: SITE, builtAt: "just now", fetch: s.fetch, sleep: s.sleep })).rejects.toThrow(/is not a time: "just now"/);
    expect(s.asked).toEqual([]);
  });

  it("describes a copy by when it was built and, when it says, the snapshot it was built from", () => {
    expect(describeCopy({ builtAt: BUILT_AT, latestSnapshot: SNAPSHOT })).toBe(`a copy built at ${BUILT_AT}, from the snapshot of ${SNAPSHOT}`);
    expect(describeCopy({ builtAt: BUILT_AT, latestSnapshot: null })).toBe(`a copy built at ${BUILT_AT}`);
  });

  it("puts the failure in one line that says what was built, what was served, and that nothing is lost", () => {
    const stale = { seen: `serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}`, attempts: 25 };
    expect(staleSiteMessage({ siteUrl: SITE, builtAt: BUILT_AT }, stale, 30_000)).toBe(
      `The site does not serve what this run deployed. This run's copy was built at ${BUILT_AT}; after 25 looks over about 12 minutes at ${SITE} the site serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}. ` +
        "No data is lost, every snapshot is committed before anything is deployed: the page is behind, and the next deployment should bring it up to date.",
    );
    expect(staleSiteMessage({ siteUrl: SITE, builtAt: BUILT_AT }, { seen: "x", attempts: 1 }, 30_000)).toContain("after one look at");
    expect(staleSiteMessage({ siteUrl: SITE, builtAt: BUILT_AT }, { seen: "x", attempts: 3 }, 30_000)).toContain("after 3 looks over about 1 minute at");
    expect(staleSiteMessage({ siteUrl: SITE, builtAt: BUILT_AT }, { seen: "x", attempts: 3 }, 50)).toContain("after 3 looks at");
    expect(staleSiteMessage({ siteUrl: SITE, builtAt: BUILT_AT }, { seen: "could not be reached (a\nb)", attempts: 2 }, 0)).not.toMatch(/[\r\n]/);
  });
});

describe("which copy of the site's data was built here?", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "chiapartment-built-"));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
  const compiled = (config: unknown): void => {
    mkdirSync(join(ROOT, "web", "public", "data"), { recursive: true });
    writeFileSync(join(ROOT, "web", "public", "data", "config.json"), JSON.stringify(config));
  };

  it("fails, saying what to run, before the data has been compiled", () => {
    expect(() => builtCopy(ROOT)).toThrow(/has not been compiled \(npm run build:data\)/);
  });

  it("reads when it was built, and its newest snapshot when it has one", () => {
    compiled({ buildings: [], health: { generated: BUILT_AT, buildings: {}, snapshots: 129, latestSnapshot: SNAPSHOT } });
    expect(builtCopy(ROOT)).toEqual({ builtAt: BUILT_AT, latestSnapshot: SNAPSHOT });
    compiled({ buildings: [], health: { generated: BUILT_AT, buildings: {}, snapshots: 0 } });
    expect(builtCopy(ROOT)).toEqual({ builtAt: BUILT_AT, latestSnapshot: null });
    // a snapshot time that is empty, or not text, is no snapshot time: nothing to put in a sentence
    for (const odd of ["", 7, null]) {
      compiled({ buildings: [], health: { generated: BUILT_AT, buildings: {}, latestSnapshot: odd } });
      expect(builtCopy(ROOT), JSON.stringify(odd)).toEqual({ builtAt: BUILT_AT, latestSnapshot: null });
    }
  });

  it("fails when the compiled data does not say when it was built: there would be nothing to hold the site to", () => {
    compiled({ buildings: [] });
    expect(() => builtCopy(ROOT)).toThrow(/does not say when it was built \(health\.generated\)/);
    compiled({ buildings: [], health: { generated: "", buildings: {} } });
    expect(() => builtCopy(ROOT)).toThrow(/does not say when it was built/);
  });
});
