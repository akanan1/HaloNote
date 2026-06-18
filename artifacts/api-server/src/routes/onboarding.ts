import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, usersTable } from "@workspace/db";

// First-run onboarding completion. Frontend POSTs here when the user
// finishes (or skips) the wizard; we stamp `onboarding_completed_at`
// once and return the refreshed AuthUser so the client doesn't have
// to follow up with a separate `/auth/me` fetch.
//
// Idempotent — re-calling after completion is a no-op. The check is
// `IS NULL` so we never accidentally bump a previously-set timestamp
// (which would obscure the original onboarding date for any future
// analytics).

const router: IRouter = Router();

router.post("/onboarding/complete", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const now = new Date();
  if (!user.onboardingCompletedAt) {
    await getDb()
      .update(usersTable)
      .set({ onboardingCompletedAt: now })
      .where(
        and(
          eq(usersTable.id, user.id),
          // Belt-and-suspenders against a race where another tab also
          // POSTs to this endpoint — the IS NULL guard makes the
          // second write a no-op so the original timestamp survives.
          isNull(usersTable.onboardingCompletedAt),
        ),
      );
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    twoFactorEnabled: Boolean(user.totpEnabledAt),
    onboardingCompleted: true,
  });
});

export default router;
