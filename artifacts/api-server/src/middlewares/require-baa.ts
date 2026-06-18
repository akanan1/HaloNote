import type { Request, Response, NextFunction } from "express";
import { and, desc, eq } from "drizzle-orm";
import { resolveCurrentDocument } from "../lib/legal-resolver";
import { getDb, legalAcceptancesTable } from "@workspace/db";

// Defense-in-depth gate for routes that handle PHI. Even though
// onboarding pins new users on the agreements step before they reach
// any clinical surface, a route added later could forget to honor
// that — this middleware fails closed at the request layer.
//
// Behavior:
//   - 401 if there's no session (shouldn't reach here past requireAuth,
//     but check anyway so the gate is independently safe).
//   - 403 with `{ error: "baa_not_accepted", currentVersion }` if the
//     user has either never accepted the BAA, or has only accepted an
//     older version than the one currently shipped in the repo. The
//     frontend uses the error code to redirect them to /onboarding.
//   - otherwise next().
//
// Performance: one DB read per gated request. The acceptance set is
// tiny per user (one row per type per version) and the index covers
// the (user_id, document_type, accepted_at) lookup. If this ever
// shows up in a hot-path profile, cache it on req.user during
// requireAuth instead — but premature optimization here would just
// add an invalidation footgun for a sub-millisecond query.

export async function requireBaa(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const currentBaa = await resolveCurrentDocument("baa");
  const [latest] = await getDb()
    .select({
      version: legalAcceptancesTable.version,
      acceptedAt: legalAcceptancesTable.acceptedAt,
    })
    .from(legalAcceptancesTable)
    .where(
      and(
        eq(legalAcceptancesTable.userId, user.id),
        eq(legalAcceptancesTable.documentType, "baa"),
      ),
    )
    .orderBy(desc(legalAcceptancesTable.acceptedAt))
    .limit(1);

  const reacceptRequiredAt = user.legalReacceptRequiredAt;
  const isCurrent =
    !!latest &&
    latest.version === currentBaa.currentVersion &&
    (!reacceptRequiredAt || latest.acceptedAt > reacceptRequiredAt);

  if (!isCurrent) {
    res.status(403).json({
      error: "baa_not_accepted",
      currentVersion: currentBaa.currentVersion,
    });
    return;
  }
  next();
}
