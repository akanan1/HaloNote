// HTTP retry policy with exponential backoff + jitter and Retry-After
// awareness. Centralised so every upstream HTTP caller (Athena chart
// REST, future Practice Fusion chart-context, etc.) shares the same
// retry posture instead of each rolling its own 1-second sleep.
//
// What we retry:
//   - 429 (Too Many Requests)
//   - 502 / 503 / 504 (upstream transient errors)
//   - Network exceptions (TCP reset, DNS failure)
//
// What we DON'T retry:
//   - 4xx other than 429 (those are caller bugs — retrying makes nothing better)
//   - 5xx other than 502/503/504 (could be an irrecoverable bug in the upstream)
//   - 2xx / 3xx (success / redirect — not our problem)
//
// Backoff: 200ms, 800ms, 3200ms base × random[0.5, 1.5) jitter, capped
// at 30s. Honoring Retry-After overrides the computed backoff for that
// attempt (we never sleep less than the server asked for; we'll sleep
// longer if our backoff is bigger). Both numeric (seconds) and HTTP-date
// Retry-After forms are accepted.
//
// Max 3 attempts total — i.e. the original call + up to 2 retries. We
// deliberately keep this short: at 3 attempts the user has waited up
// to ~5s for the slow path, which is the operational limit before a
// note-saving UI feels broken.

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface RetryOptions {
  /** Override max attempts (default 3). Floored to 1. */
  maxAttempts?: number;
  /**
   * Random-jitter source. Default `Math.random`. Tests inject a
   * deterministic generator so backoff is observable.
   */
  random?: () => number;
  /** Sleep implementation. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Clock for HTTP-date Retry-After parsing — defaults to `Date.now`.
   * Override in tests so the date math is deterministic.
   */
  now?: () => number;
  /**
   * Called once per retry decision (NOT on the initial attempt). Useful
   * for structured logging without forcing every call site to wrap us.
   */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    error?: unknown;
  }) => void;
}

export class HttpRetryGaveUpError extends Error {
  override readonly name = "HttpRetryGaveUpError";
  readonly attempts: number;
  readonly lastStatus?: number;
  readonly lastError?: unknown;
  constructor(opts: {
    attempts: number;
    lastStatus?: number;
    lastError?: unknown;
  }) {
    super(
      `HTTP retry exhausted after ${opts.attempts} attempts` +
        (opts.lastStatus !== undefined ? ` (last status ${opts.lastStatus})` : ""),
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.attempts = opts.attempts;
    if (opts.lastStatus !== undefined) this.lastStatus = opts.lastStatus;
    if (opts.lastError !== undefined) this.lastError = opts.lastError;
  }
}

/**
 * Parse a Retry-After header into milliseconds. Returns `null` if the
 * value is missing, malformed, or in the past.
 *
 * Per RFC 7231 §7.1.3 the value is either:
 *   - `delta-seconds`: a non-negative integer count of seconds, OR
 *   - `HTTP-date`: an absolute date in IMF-fixdate format.
 */
export function parseRetryAfter(
  raw: string | null | undefined,
  now: () => number = Date.now,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Integer seconds path.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  // HTTP-date path. Date.parse returns NaN for bad strings.
  const epoch = Date.parse(trimmed);
  if (!Number.isFinite(epoch)) return null;
  const delta = epoch - now();
  if (delta <= 0) return null;
  return delta;
}

function computeBackoffMs(
  attemptIndex: number,
  random: () => number,
): number {
  // attemptIndex 0 → first retry (after the initial call). Backoff grows
  // 4× per step: 200, 800, 3200, 12800, ...
  const base = BASE_DELAY_MS * Math.pow(4, attemptIndex);
  // Random jitter in [0.5, 1.5). Spreads thundering-herd if many clients
  // retry against the same upstream at once.
  const jitter = 0.5 + random();
  return Math.min(MAX_DELAY_MS, Math.floor(base * jitter));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute `fn` with retry. The callback is responsible for the
 * underlying network call and should return the raw Response — we
 * inspect the status (NOT the parsed body) to decide whether to retry,
 * and surface the final Response to the caller on success OR after
 * giving up.
 *
 * Use case is "wrap one fetch call site"; for cases where the caller
 * wants to throw on a non-2xx, throw inside `fn` AFTER calling us so
 * the retry logic still sees the Response.
 */
export async function fetchWithRetry(
  fn: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn();
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }
      lastResponse = res;
      if (attempt === maxAttempts) {
        // Out of attempts — surface the final response to the caller so
        // they can inspect status + body. (We don't throw on a status —
        // a 429 after retries is still a "real response", just unlucky.)
        return res;
      }
      const retryAfterHeader =
        res.headers.get("retry-after") ?? res.headers.get("Retry-After");
      const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
      const backoffMs = computeBackoffMs(attempt - 1, random);
      const delayMs =
        retryAfterMs !== null ? Math.max(retryAfterMs, backoffMs) : backoffMs;
      opts.onRetry?.({ attempt, delayMs, status: res.status });
      await sleep(delayMs);
    } catch (err) {
      // Network exception (TCP reset, DNS failure, AbortError, etc.).
      // Treat as retryable up to maxAttempts. AbortError is the one
      // exception — the caller cancelled, retrying would defeat the
      // cancellation.
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      lastError = err;
      if (attempt === maxAttempts) {
        throw new HttpRetryGaveUpError({
          attempts: attempt,
          lastError,
        });
      }
      const backoffMs = computeBackoffMs(attempt - 1, random);
      opts.onRetry?.({ attempt, delayMs: backoffMs, error: err });
      await sleep(backoffMs);
    }
  }

  // Defensive — the loop above always returns or throws on the final
  // iteration. If we somehow fall through, surface the best signal.
  if (lastResponse) return lastResponse;
  throw new HttpRetryGaveUpError({
    attempts: maxAttempts,
    lastError,
  });
}
