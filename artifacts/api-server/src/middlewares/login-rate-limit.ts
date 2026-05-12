import { rateLimit, ipKeyGenerator } from "express-rate-limit";

const WINDOW_MS = 15 * 60 * 1000;

// Per-IP cap. Defends against a single host blasting many accounts.
// Looser than the per-email cap so legitimate users sharing an IP
// (clinic NAT, etc.) aren't punished for a colleague's typos.
export const loginIpRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // A successful login is evidence of a real user; don't count it.
  skipSuccessfulRequests: true,
  message: { error: "too_many_attempts" },
});

// Per-email cap. Defends a specific account against a slow distributed
// attack across many IPs. Tighter than the IP cap.
export const loginEmailRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const raw = typeof body?.email === "string" ? body.email : "";
    const email = raw.toLowerCase().trim();
    // Fall back to a hash of the IP so a request without an email still
    // gets bucketed (rather than landing in a shared global bucket that
    // any user could flood). ipKeyGenerator returns an IPv4/IPv6-aware key.
    return email || `noemail:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "too_many_attempts" },
});
