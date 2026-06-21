import type { RequestHandler, Response } from "express";
import { z } from "@workspace/api-zod";

// Single source of truth for the 400 / invalid-request response shape.
// Routes that need to interleave Zod validation with pre-existing
// handler preconditions (org-scope checks, auth lookups, etc.) keep
// using safeParse inline and call this on failure — the wire envelope
// stays identical to what validateBody emits.
//
// Param typed structurally (just `{ issues }`) rather than `ZodError<T>`
// because zod/v4's ZodError carries private `_zod` / `type` brands that
// don't match across distinct ZodObject instantiations. The helper only
// reads `.issues`, so structural typing both avoids the variance trap
// and accidentally documents the actual contract.
export function respondInvalidBody(
  res: Response,
  error: { issues: readonly unknown[] },
): void {
  res.status(400).json({
    error: "invalid_request",
    issues: error.issues,
  });
}

// Validates `req.body` against a Zod schema and, on success, replaces
// `req.body` with the parsed (and thus narrowed/transformed) value
// before calling next. On failure responds via {@link respondInvalidBody}.
//
// Use this when the route has NO handler-level preconditions that need
// to run before validation (e.g. simple create/update endpoints). Routes
// that need to check session state, org membership, or other precon-
// ditions first should keep safeParse inline + call respondInvalidBody
// on failure — middleware runs before the handler, so wiring this in
// front of a precondition-heavy route subtly reorders the failure
// envelopes the caller sees.
//
// Why `z` from @workspace/api-zod and not `zod` directly: api-zod is
// the workspace's vetted re-export (currently `zod/v4`); routing zod
// usage through it keeps the version singular across the monorepo.
export function validateBody<T extends z.ZodTypeAny>(
  schema: T,
): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      respondInvalidBody(res, parsed.error);
      return;
    }
    req.body = parsed.data;
    next();
  };
}
