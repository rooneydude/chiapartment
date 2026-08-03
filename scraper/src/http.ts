const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const RETRIES = 3;
const TIMEOUT_MS = 30_000;

/**
 * fetch with browser-like headers, timeout, and retry with exponential
 * backoff on 429/5xx/network errors.
 */
export const httpFetch: typeof fetch = async (input, init) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(input, {
        ...init,
        headers: { ...BROWSER_HEADERS, ...(init?.headers as Record<string, string>) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        lastError = new Error(`HTTP ${res.status} from ${res.url}`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
