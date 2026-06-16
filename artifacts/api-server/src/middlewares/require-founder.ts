import type { Request, Response, NextFunction } from "express";

// Founder-only gate. Stricter than `requireAdmin`: admins can see the
// audit log for their tenant, founders see cross-tenant analytics and
// every user's legal acceptance status. Granted via the `is_founder`
// boolean on `users`, set manually for the HaloNote team.
export function requireFounder(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!user.isFounder) {
    // 404 instead of 403 — there's no benefit to advertising the
    // existence of the founder surface to non-founders.
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}
