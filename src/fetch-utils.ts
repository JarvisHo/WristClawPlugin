/**
 * Fetch with timeout + retry for transient errors.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 500;

export type FetchWithRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  retryOn?: (status: number) => boolean;
};

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function defaultRetryOn(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * Fetch with timeout. Throws on timeout.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const ms = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  // Merge signals if caller provided one
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with timeout + retry. Returns Response on success, throws on exhaustion.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit & FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = (init?.retries ?? DEFAULT_RETRIES) + 1;
  const retryOn = init?.retryOn ?? defaultRetryOn;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init);

      if (attempt < maxAttempts && retryOn(res.status)) {
        // Consume body to free connection
        await res.text().catch(() => {});

        // Retry-After header (seconds) or exponential backoff
        const retryAfter = res.headers.get("retry-after");
        const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const delayMs = !isNaN(parsedRetryAfter) && parsedRetryAfter > 0
          ? Math.min(parsedRetryAfter * 1000, 30_000)
          : RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delayMs);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

function isTransientError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  // fetch() throws TypeError for network errors — but so do real bugs.
  // Only retry if the message looks like a network/fetch error.
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    return msg.includes("fetch") || msg.includes("network") || msg.includes("econnr")
      || msg.includes("etimedout") || msg.includes("enotfound") || msg.includes("socket");
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
