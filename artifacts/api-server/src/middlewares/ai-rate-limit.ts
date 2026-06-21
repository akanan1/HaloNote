// Per-user rate limit on Anthropic-backed endpoints (Coder generate,
// Refine, problem-list reconcile, Athena-note ingest). A scripted
// client or a misbehaving integration could otherwise burn the org's
// Anthropic budget without the provider noticing.
//
// Why per-user (not per-IP / per-org):
//   - Per-IP would punish whole clinics behind a NAT for one bad actor
//   - Per-org would let one runaway provider take down the whole tenant
//   - Per-user is the right granularity; the budget is also charged
//     per the requesting user's session
//
// Budget: 300 AI calls per user per hour. That's ~5/min sustained,
// or about 10x what a busy provider organically needs (30-40 visits
// × ~3 AI calls each ÷ 8 working hours). Catches runaway scripts
// without ever hitting a real human.

import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { PostgresRateLimitStore } from "../lib/postgres-rate-limit-store";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LIMIT = 300;

export const aiEndpointRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  keyGenerator: (req) => {
    // req.user is set by requireAuth — the AI endpoints all sit below
    // it in the middleware chain. Fall back to IP for the (impossible
    // in normal flow) case where this fires pre-auth, so we never end
    // up bucketing every anonymous request into one shared key.
    return (
      req.user?.id ?? `unauth:${ipKeyGenerator(req.ip ?? "unknown")}`
    );
  },
  message: {
    error: "ai_rate_limit_exceeded",
    detail:
      "Too many AI calls in the last hour. Wait a few minutes and try again, or contact support if this seems wrong.",
  },
});
