import { describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  HttpRetryGaveUpError,
  parseRetryAfter,
} from "./http-retry";

// Deterministic random generator so we can predict the jittered backoff.
// Math.random() ∈ [0, 1); our jitter multiplier = 0.5 + random, so a
// fixed 0.5 yields jitter=1 and exact base × 4^attempt values.
const deterministicRandom = () => 0.5;

// Tiny no-op sleep so the test suite isn't waiting actual seconds. We
// capture the durations the helper asked for and assert on those.
function makeRecordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(`status=${status}`, { status, headers });
}

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("rejects malformed seconds", () => {
    expect(parseRetryAfter("abc")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("  ")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("parses HTTP-date and returns delta from `now`", () => {
    const now = new Date("2026-06-24T12:00:00Z").getTime();
    const future = "Wed, 24 Jun 2026 12:00:30 GMT";
    expect(parseRetryAfter(future, () => now)).toBe(30_000);
  });

  it("returns null for past HTTP-dates", () => {
    const now = new Date("2026-06-24T12:00:00Z").getTime();
    const past = "Wed, 24 Jun 2026 11:00:00 GMT";
    expect(parseRetryAfter(past, () => now)).toBeNull();
  });
});

describe("fetchWithRetry", () => {
  it("returns immediately on a 2xx without sleeping", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const fn = vi.fn().mockResolvedValue(makeResponse(200));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry non-retryable 4xx", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const fn = vi.fn().mockResolvedValue(makeResponse(404));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(res.status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries 503 with exponential backoff + jitter and gives up after 3 attempts", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const fn = vi.fn().mockResolvedValue(makeResponse(503));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(res.status).toBe(503);
    // 1 original + 2 retries = 3 total attempts (max).
    expect(fn).toHaveBeenCalledTimes(3);
    // With random=0.5, jitter=1.0, so backoff is exactly base × 4^index:
    //   attempt 1 → 200ms, attempt 2 → 800ms
    expect(delays).toEqual([200, 800]);
  });

  it("honors numeric Retry-After (seconds)", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const responses = [
      makeResponse(429, { "Retry-After": "2" }),
      makeResponse(200),
    ];
    const fn = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(res.status).toBe(200);
    // Retry-After (2000ms) > computed backoff (200ms) → uses Retry-After.
    expect(delays).toEqual([2000]);
  });

  it("honors HTTP-date Retry-After", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const now = new Date("2026-06-24T12:00:00Z").getTime();
    const future = "Wed, 24 Jun 2026 12:00:10 GMT"; // +10s
    const responses = [
      makeResponse(503, { "Retry-After": future }),
      makeResponse(200),
    ];
    const fn = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
      now: () => now,
    });
    expect(res.status).toBe(200);
    expect(delays).toEqual([10_000]);
  });

  it("uses the larger of computed backoff and Retry-After", async () => {
    const { delays, sleep } = makeRecordingSleep();
    // Retry-After tiny (0s) — computed backoff (200ms) wins.
    const responses = [
      makeResponse(429, { "Retry-After": "0" }),
      makeResponse(200),
    ];
    const fn = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(delays).toEqual([200]);
  });

  it("recovers when an early attempt fails and a later one succeeds", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const responses = [
      makeResponse(502),
      makeResponse(503),
      makeResponse(200),
    ];
    const fn = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const res = await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
    });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([200, 800]);
  });

  it("retries network exceptions and throws HttpRetryGaveUpError after maxAttempts", async () => {
    const { sleep } = makeRecordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      fetchWithRetry(fn, { random: deterministicRandom, sleep }),
    ).rejects.toBeInstanceOf(HttpRetryGaveUpError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry AbortError — propagates immediately", async () => {
    const { sleep } = makeRecordingSleep();
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(abort);
    await expect(
      fetchWithRetry(fn, { random: deterministicRandom, sleep }),
    ).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry once per retry decision with attempt + delay", async () => {
    const { sleep } = makeRecordingSleep();
    const onRetry = vi.fn();
    const responses = [
      makeResponse(503),
      makeResponse(503),
      makeResponse(200),
    ];
    const fn = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    await fetchWithRetry(fn, {
      random: deterministicRandom,
      sleep,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      delayMs: 200,
      status: 503,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      delayMs: 800,
      status: 503,
    });
  });

  it("respects custom maxAttempts", async () => {
    const { delays, sleep } = makeRecordingSleep();
    const fn = vi.fn().mockResolvedValue(makeResponse(503));
    await fetchWithRetry(fn, {
      maxAttempts: 2,
      random: deterministicRandom,
      sleep,
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([200]);
  });
});
