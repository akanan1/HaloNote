// Per-user (or per-token) hourly cap on sensitive auth transitions:
//   - POST /auth/2fa/disable
//   - POST /auth/password-reset/confirm
//
// These endpoints are second-factor gates around "take over this
// account" actions. Without a tight rate limit a thief sitting on a
// stolen session (or a leaked reset-link inbox) could grind through
// TOTP guesses or replay-attack the password-reset token until it
// works.
//
// 5 attempts per hour matches the existing per-email login limiter
// (login-rate-limit.ts) — the same threshold a typo-prone human can
// recover from in one annoyed phone call without giving an attacker
// usable throughput. Window is 1h here vs 15m for login because the
// recovery flow is rarer and any successful attack pivot is much
// more damaging.
//
// Keying:
//   - 2fa/disable runs after requireAuth, so we bucket by user id.
//   - password-reset/confirm is unauthenticated; we bucket by the
//     raw reset token (already random-256-bit, so it makes a great
//     per-attempt key) with an IP fallback when no token is supplied.

import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { PostgresRateLimitStore } from "../lib/postgres-rate-limit-store";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LIMIT = 5;

// /auth/2fa/disable — runs after requireAuth so req.user is set.
// Falling back to IP would only fire on the (impossible in normal
// flow) case where this middleware mounts pre-auth.
export const twoFactorDisableRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  // Do NOT skip successful requests — a successful 2fa_disable is
  // exactly the action we want to cap to 5/hr.
  keyGenerator: (req) => {
    return req.user?.id ?? `unauth:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "too_many_attempts" },
});

// /auth/password-reset/confirm — unauthenticated. Bucket by the
// reset token itself so an attacker can't bypass the cap by rotating
// IPs while replaying the same token; fall back to IP if no token
// was supplied (so anonymous requests still get bucketed somewhere
// other than a shared global key).
export const passwordResetConfirmRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  keyGenerator: (req) => {
    const body = req.body as { token?: unknown } | undefined;
    const raw = typeof body?.token === "string" ? body.token : "";
    // Tokens are 64-hex chars; prefix to keep this bucket distinct
    // from any other limiter that might key on a similar string.
    return raw
      ? `pwreset:${raw}`
      : `pwreset:noemail:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "too_many_attempts" },
});
