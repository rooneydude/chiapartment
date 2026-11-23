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
  instant,
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
/** Where the stand-in clock starts. */
const T0 = 1_800_000_000_000;

/** The site's data file, as a copy built at `generated` from the snapshot of `latestSnapshot` serves it. */
const data = (generated?: string, latestSnapshot?: string): Response =>
  new Response(JSON.stringify({ buildings: [], health: { ...(generated ? { generated } : {}), buildings: {}, snapshots: 129, ...(latestSnapshot ? { latestSnapshot } : {}) } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * A site that answers each look in turn (the last answer repeats), with a
 * record of what was asked and how, and a clock that only the waits move.
 */
function site(answers: (() => Response | Promise<Response>)[]) {
  const asked: string[] = [];
  const how: (RequestInit | undefined)[] = [];
  const waited: number[] = [];
  let clock = T0;
  let n = 0;
  const fetchStandIn = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    asked.push(String(input));
    how.push(init);
    return Promise.resolve(answers[Math.min(n++, answers.length - 1)]!());
  }) as typeof fetch;
  const sleep = (ms: number): Promise<void> => {
    waited.push(ms);
    clock += ms;
    return Promise.resolve();
  };
  return { asked, how, waited, fetch: fetchStandIn, sleep, now: () => clock };
}

describe("does the site serve what was deployed?", () => {
  it("yes, at once, when the live copy is the one this deployment built", async () => {
    const s = site([() => data(BUILT_AT, SNAPSHOT)]);
    expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now })).toEqual({
      ok: true,
      served: { builtAt: BUILT_AT, latestSnapshot: SNAPSHOT },
      attempts: 1,
    });
    expect(s.waited).toEqual([]);
    expect(s.asked).toEqual([`https://example.github.io/tracker/data/config.json?checked=${T0}-1`]);
  });

  it("asks the way a visitor's browser would not be answered from a cache: redirects followed, no cached copy wanted", async () => {
    const s = site([() => data(BUILT_AT)]);
    await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now });
    expect(s.how[0]).toMatchObject({ redirect: "follow", headers: { "cache-control": "no-cache" } });
    expect(s.how[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("yes, when the live copy was built later still: another deployment has followed", async () => {
    const s = site([() => data("2026-11-23T20:46:10.000Z", "2026-11-23T20:45:02Z")]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now })).ok).toBe(true);
  });

  it("no, when the site still serves the copy from before — 23 Nov: a snapshot behind", async () => {
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 4, waitMs: 1000, fetch: s.fetch, sleep: s.sleep, now: s.now });
    expect(result).toEqual({ ok: false, seen: `serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}`, attempts: 4, found: "older", elapsedMs: 3000 });
    expect(s.asked).toHaveLength(4);
    expect(s.waited).toEqual([1000, 1000, 1000]); // no wait after the last look
  });

  it("no, when only the code changed and the copy from before is still served: same snapshot, earlier build", async () => {
    const s = site([() => data(BEFORE, SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, waitMs: 500, fetch: s.fetch, sleep: s.sleep, now: s.now });
    expect(result).toEqual({ ok: false, seen: `serves a copy built at ${BEFORE}, from the snapshot of ${SNAPSHOT}`, attempts: 2, found: "older", elapsedMs: 500 });
  });

  it("goes by when the copy was built, not by its snapshot: a later build of an older snapshot is still what was deployed last", async () => {
    const s = site([() => data(BUILT_AT, OLDER_SNAPSHOT)]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now })).ok).toBe(true);
  });

  describe("told the newest snapshot on the branch, it holds the page to that as well", () => {
    const need = { siteUrl: SITE, builtAt: BUILT_AT, newestSnapshot: SNAPSHOT };

    it("passes a copy that is this build and holds that snapshot, or a newer one", async () => {
      for (const latest of [SNAPSHOT, "2026-11-23T04:28:35-06:00", "2026-11-23T20:45:02Z"]) {
        const s = site([() => data(BUILT_AT, latest)]);
        expect(await verifyLive({ ...need, fetch: s.fetch, sleep: s.sleep, now: s.now }), latest).toMatchObject({ ok: true, attempts: 1 });
      }
    });

    it("fails a copy with this build's stamp and older data: built from a commit without the day's snapshot", async () => {
      const s = site([() => data(BUILT_AT, OLDER_SNAPSHOT)]);
      expect(await verifyLive({ ...need, attempts: 2, waitMs: 100, fetch: s.fetch, sleep: s.sleep, now: s.now })).toEqual({
        ok: false,
        seen: `serves a copy built at ${BUILT_AT}, from the snapshot of ${OLDER_SNAPSHOT}, which does not hold the newest snapshot on the branch (${SNAPSHOT})`,
        attempts: 2,
        found: "lacks-newest",
        elapsedMs: 100,
      });
      // one second short of it is short of it
      const t = site([() => data(BUILT_AT, "2026-11-23T10:28:34Z")]);
      expect((await verifyLive({ ...need, attempts: 1, fetch: t.fetch, sleep: t.sleep, now: t.now })).ok).toBe(false);
    });

    it("fails a copy that does not say which snapshot it holds, or says it in no form of time — and claims no more than that", async () => {
      const cases: [answer: () => Response, seen: string][] = [
        [() => data(BUILT_AT), `serves a copy built at ${BUILT_AT}, which does not say in a form that can be read which snapshot it holds (the newest on the branch is that of ${SNAPSHOT})`],
        [
          () => data(BUILT_AT, "today"),
          `serves a copy built at ${BUILT_AT}, from the snapshot of today, which does not say in a form that can be read which snapshot it holds (the newest on the branch is that of ${SNAPSHOT})`,
        ],
      ];
      for (const [answer, seen] of cases) {
        const s = site([answer]);
        expect(await verifyLive({ ...need, attempts: 1, fetch: s.fetch, sleep: s.sleep, now: s.now })).toMatchObject({ ok: false, seen, found: "lacks-newest" });
      }
    });

    it("still fails an older build, and says only that: its data is beside the point", async () => {
      const s = site([() => data(BEFORE, SNAPSHOT)]);
      expect(await verifyLive({ ...need, attempts: 1, fetch: s.fetch, sleep: s.sleep, now: s.now })).toMatchObject({
        ok: false,
        seen: `serves a copy built at ${BEFORE}, from the snapshot of ${SNAPSHOT}`,
      });
    });

    it("waits for the deployment that carries it: this build first, the one with the snapshot after", async () => {
      // A merge that also starts a refresh: this run's copy arrives without the
      // snapshot the refresh has pushed meanwhile; the refresh's own follows.
      const s = site([() => data(BUILT_AT, OLDER_SNAPSHOT), () => data("2026-11-23T10:31:02.000Z", SNAPSHOT)]);
      expect(await verifyLive({ ...need, attempts: 3, waitMs: 30_000, fetch: s.fetch, sleep: s.sleep, now: s.now })).toMatchObject({ ok: true, attempts: 2 });
    });

    it("refuses a snapshot time that is not a time", async () => {
      const s = site([() => data(BUILT_AT, SNAPSHOT)]);
      await expect(verifyLive({ ...need, newestSnapshot: "latest", fetch: s.fetch, sleep: s.sleep, now: s.now })).rejects.toThrow('newest snapshot on the branch is not a time: "latest"');
      expect(s.asked).toEqual([]);
    });
  });

  it("compares the two as moments, however each is written", async () => {
    for (const same of ["2026-11-23T10:29:25Z", "2026-11-23T04:29:25.000-06:00", "2026-11-23T10:29:25.000+00:00"]) {
      const s = site([() => data(same)]);
      expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now })).ok, same).toBe(true);
    }
    // one millisecond earlier is earlier
    const s = site([() => data("2026-11-23T10:29:24.999Z")]);
    expect((await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, fetch: s.fetch, sleep: s.sleep, now: s.now })).ok).toBe(false);
  });

  it("takes only a full date and time for a build stamp: not a bare number, a year or a day", () => {
    expect(instant(BUILT_AT)).toBe(Date.parse(BUILT_AT));
    expect(instant("2026-11-23T04:29:25-06:00")).toBe(Date.parse(BUILT_AT));
    // each of these JavaScript would read as some date or other
    for (const loose of ["1", "129", "2027", "2026-11-23", "Nov 23 2026 10:29", "2026-11-23T10:29:25", "2026-11-23 10:29:25Z", ""]) {
      expect(instant(loose), JSON.stringify(loose)).toBeNull();
    }
    expect(instant("2026-13-45T99:99:99Z")).toBeNull(); // the right shape, and no such moment
  });

  it("looks again while the deployment is still reaching the servers, a different address each time", async () => {
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT), () => new Response("Not Found", { status: 404 }), () => data(BUILT_AT, SNAPSHOT)]);
    const lines: string[] = [];
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, waitMs: 15_000, fetch: s.fetch, sleep: s.sleep, now: s.now, log: (l) => lines.push(l) });
    expect(result).toEqual({ ok: true, served: { builtAt: BUILT_AT, latestSnapshot: SNAPSHOT }, attempts: 3 });
    expect(s.waited).toEqual([15_000, 15_000]);
    // the clock is in the address, so no two looks — of this run or of another — ask for the same one
    expect(s.asked.map((a) => new URL(a).searchParams.get("checked"))).toEqual([`${T0}-1`, `${T0 + 15_000}-2`, `${T0 + 30_000}-3`]);
    expect(lines).toEqual([
      `Look 1 of ${DEFAULT_ATTEMPTS}: the site serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}; this deployment's copy was built at ${BUILT_AT}.`,
      `Look 2 of ${DEFAULT_ATTEMPTS}: the site answered HTTP 404 for its data; this deployment's copy was built at ${BUILT_AT}.`,
    ]);
  });

  it("does not look again until the wait is over", async () => {
    // A wait that ends only when the test says so. A check that did not wait
    // for it would make its looks back to back — twenty-five within a second,
    // against a deployment that needs a few to arrive.
    const asked: string[] = [];
    let release: () => void = () => {};
    const gate = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));
    const fetchStandIn = ((input: Parameters<typeof fetch>[0]) => {
      asked.push(String(input));
      return Promise.resolve(asked.length < 3 ? data(BEFORE) : data(BUILT_AT));
    }) as typeof fetch;
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

    const done = verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 5, fetch: fetchStandIn, sleep: gate });
    await settle();
    expect(asked).toHaveLength(1);
    await settle();
    expect(asked).toHaveLength(1); // still waiting
    release();
    await settle();
    expect(asked).toHaveLength(2);
    release();
    expect(await done).toMatchObject({ ok: true, attempts: 3 });
  });

  it("waits for real when left to its own clock", async () => {
    const at: number[] = [];
    const fetchStandIn = (() => {
      at.push(performance.now());
      return Promise.resolve(at.length < 2 ? data(BEFORE) : data(BUILT_AT));
    }) as typeof fetch;
    expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 3, waitMs: 120, fetch: fetchStandIn })).toMatchObject({ ok: true, attempts: 2 });
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(110);
  });

  it("says what was in the way when the site's data could not be read at all, and does not call the page behind", async () => {
    const cases: [answer: () => Response | Promise<Response>, seen: string][] = [
      [() => new Response("gone", { status: 503 }), "answered HTTP 503 for its data"],
      [() => new Response("<html>a sign-in page</html>", { status: 200 }), "answered with something that is not its data file"],
      [() => data(), "serves data that does not say when it was built"],
      [() => new Response("null", { status: 200 }), "serves data that does not say when it was built"],
      [() => new Response('{"buildings":[]}', { status: 200 }), "serves data that does not say when it was built"],
      [() => data("yesterday"), 'serves data built at "yesterday", which is not a time'],
      [() => data("2027"), 'serves data built at "2027", which is not a time'],
      // the way Node's own fetch fails: a bare "fetch failed", the reason behind it
      [
        () => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.github.io") })),
        "could not be reached (fetch failed: getaddrinfo ENOTFOUND example.github.io)",
      ],
      [() => Promise.reject(new TypeError("fetch failed", { cause: "connect ECONNREFUSED 127.0.0.1:9" })), "could not be reached (fetch failed: connect ECONNREFUSED 127.0.0.1:9)"],
      [() => Promise.reject(new Error("socket hang up")), "could not be reached (socket hang up)"],
      [() => Promise.reject("no network"), "could not be reached (no network)"],
    ];
    for (const [answer, seen] of cases) {
      const s = site([answer]);
      expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, waitMs: 250, fetch: s.fetch, sleep: s.sleep, now: s.now }), seen).toEqual({
        ok: false,
        seen,
        attempts: 2,
        found: "unread",
        elapsedMs: 250,
      });
    }
  });

  it("goes by the last look: an older copy read earlier does not make an unreadable site 'behind'", async () => {
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT), () => new Response("gone", { status: 503 })]);
    expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2, waitMs: 100, fetch: s.fetch, sleep: s.sleep, now: s.now })).toEqual({
      ok: false,
      seen: "answered HTTP 503 for its data",
      attempts: 2,
      found: "unread",
      elapsedMs: 100,
    });
  });

  it("tells an answer that broke off from one that is not the data file", async () => {
    const cutOff = (() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"health":{"generated":"'));
          controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 1, fetch: cutOff });
    expect(result).toMatchObject({ ok: false, seen: "stopped half way through its answer (terminated: other side closed)", found: "unread" });
  });

  it("goes on looking for twelve minutes — twenty-five looks, half a minute apart — unless told otherwise", async () => {
    // The site lets a copy be reused for ten minutes (cache-control: max-age=600). The looking has to outlast that.
    expect([DEFAULT_ATTEMPTS, DEFAULT_WAIT_MS]).toEqual([25, 30_000]);
    expect((DEFAULT_ATTEMPTS - 1) * DEFAULT_WAIT_MS).toBeGreaterThan(10 * 60_000);
    const s = site([() => data(BEFORE, OLDER_SNAPSHOT)]);
    const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now });
    expect(result).toMatchObject({ ok: false, attempts: 25, found: "older", elapsedMs: 24 * 30_000 });
    expect(s.waited).toEqual(Array.from({ length: 24 }, () => 30_000));
  });

  it("looks once at the least, and never waits a negative while", async () => {
    const s = site([() => data(BEFORE)]);
    expect(await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 0, waitMs: -5, fetch: s.fetch, sleep: s.sleep, now: s.now })).toMatchObject({ ok: false, attempts: 1 });
    expect(s.asked).toHaveLength(1);
    const t = site([() => data(BEFORE)]);
    await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 2.9, waitMs: -5, fetch: t.fetch, sleep: t.sleep, now: t.now });
    expect([t.asked.length, t.waited]).toEqual([2, [0]]);
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
      expect(result).toMatchObject({ ok: false, seen: "did not answer within 0.04 s", attempts: 2, found: "unread" });
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
      expect(result).toMatchObject({ ok: false, seen: "did not answer within 0.04 s", attempts: 1 });
    });

    it("an answer that is cut off for another reason is not blamed on the clock", async () => {
      const cutOff = (() => Promise.reject(new DOMException("This operation was aborted", "AbortError"))) as typeof fetch;
      const result = await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, attempts: 1, timeoutMs: 60_000, fetch: cutOff, sleep: noWait });
      expect(result).toMatchObject({ ok: false, seen: "could not be reached (This operation was aborted)", attempts: 1 });
    });

    it("the limit is twenty seconds a look unless told otherwise", async () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
      const asked = vi.spyOn(AbortSignal, "timeout");
      const s = site([() => data(BUILT_AT)]);
      await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, fetch: s.fetch, sleep: s.sleep, now: s.now });
      expect(asked.mock.calls).toEqual([[20_000]]);
      await verifyLive({ siteUrl: SITE, builtAt: BUILT_AT, timeoutMs: 2500, fetch: s.fetch, sleep: s.sleep, now: s.now });
      expect(asked.mock.calls).toEqual([[20_000], [2500]]);
    });
  });

  it("looks under the site's own address, with or without a final slash", () => {
    expect(String(liveDataUrl("https://example.github.io/tracker/"))).toBe("https://example.github.io/tracker/data/config.json");
    expect(String(liveDataUrl("https://example.github.io/tracker"))).toBe("https://example.github.io/tracker/data/config.json");
    expect(String(liveDataUrl("https://tracker.example.com"))).toBe("https://tracker.example.com/data/config.json");
    // what is not a web address is refused in words that say so, and say what it was
    expect(() => liveDataUrl("example.github.io/tracker/")).toThrow("Not a web address: example.github.io/tracker/");
    expect(() => liveDataUrl("file:///etc/passwd")).toThrow("Not a web address: file:///etc/passwd");
  });

  it("refuses a build time that is not a time, rather than pass or fail on a guess", async () => {
    const s = site([() => data(BUILT_AT)]);
    for (const loose of ["just now", "1", "2027", ""]) {
      await expect(verifyLive({ siteUrl: SITE, builtAt: loose, fetch: s.fetch, sleep: s.sleep, now: s.now }), JSON.stringify(loose)).rejects.toThrow(
        `is not a time: ${JSON.stringify(loose)}`,
      );
    }
    expect(s.asked).toEqual([]);
  });

  it("describes a copy by when it was built and, when it says, the snapshot it was built from", () => {
    expect(describeCopy({ builtAt: BUILT_AT, latestSnapshot: SNAPSHOT })).toBe(`a copy built at ${BUILT_AT}, from the snapshot of ${SNAPSHOT}`);
    expect(describeCopy({ builtAt: BUILT_AT, latestSnapshot: null })).toBe(`a copy built at ${BUILT_AT}`);
  });

  describe("the failure, in one line", () => {
    const about = { siteUrl: SITE, builtAt: BUILT_AT };
    const stale = { seen: `serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}`, attempts: 25, found: "older", elapsedMs: 12 * 60_000 + 4000 } as const;

    it("says what was built, what was served, how long was looked, and that nothing is lost", () => {
      expect(staleSiteMessage(about, stale)).toBe(
        `The site does not serve what this run deployed. This run's copy was built at ${BUILT_AT}; after 25 looks over about 12 minutes at ${SITE} the site serves a copy built at ${BEFORE}, from the snapshot of ${OLDER_SNAPSHOT}. ` +
          "No data is lost, every snapshot is committed before anything is deployed: the page is behind, and the next deployment should bring it up to date.",
      );
    });

    it("opens with what was found, three ways: a site that could not be read is not said to be behind", () => {
      // twenty-five looks of twenty seconds and twenty-four waits: the time it took, not the time it was meant to take
      const unread = { seen: "did not answer within 20 s", attempts: 25, found: "unread", elapsedMs: 25 * 20_000 + 24 * 30_000 } as const;
      expect(staleSiteMessage(about, unread)).toBe(
        `The site could not be read, so whether it serves what this run deployed is not known. This run's copy was built at ${BUILT_AT}; after 25 looks over about 20 minutes at ${SITE} the site did not answer within 20 s. ` +
          "No data is lost: every snapshot is committed before anything is deployed.",
      );
    });

    it("…and a site that serves this run's copy without the newest snapshot is not said to have lost this run's deployment", () => {
      const lacks = {
        seen: `serves a copy built at ${BUILT_AT}, from the snapshot of ${OLDER_SNAPSHOT}, which does not hold the newest snapshot on the branch (${SNAPSHOT})`,
        attempts: 25,
        found: "lacks-newest",
        elapsedMs: 12 * 60_000,
      } as const;
      expect(staleSiteMessage(about, lacks)).toBe(
        `As far as its data says, the site does not show the newest snapshot on the branch. This run's copy was built at ${BUILT_AT}; after 25 looks over about 12 minutes at ${SITE} the site serves a copy built at ${BUILT_AT}, from the snapshot of ${OLDER_SNAPSHOT}, which does not hold the newest snapshot on the branch (${SNAPSHOT}). ` +
          "No data is lost, every snapshot is committed before anything is deployed: the deployment that carries that snapshot has not arrived, and the next one should bring the page up to date.",
      );
    });

    it("counts the looks and the minutes as a person would", () => {
      expect(staleSiteMessage(about, { ...stale, attempts: 1, elapsedMs: 0 })).toContain("after one look at");
      expect(staleSiteMessage(about, { ...stale, attempts: 3, elapsedMs: 61_000 })).toContain("after 3 looks over about 1 minute at");
      expect(staleSiteMessage(about, { ...stale, attempts: 3, elapsedMs: 100 })).toContain("after 3 looks at");
      expect(staleSiteMessage(about, { ...stale, seen: "could not be reached (a\nb)" })).not.toMatch(/[\r\n]/);
    });
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
