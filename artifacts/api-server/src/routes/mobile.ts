// Mobile PWA support routes. Today this is just the one-shot init
// endpoint the /m landing page calls on first visit; the rest of the
// mobile UI rides on existing endpoints (schedule, recordings,
// orders/suggest, etc.).
//
// Mounted ABOVE the PHI / BAA gate intentionally — flipping a user's
// own auto-push toggles is a personalization action, not a PHI
// operation, and we want the call to succeed even if the user is in
// the middle of re-accepting an updated BAA on the desktop. They
// can't reach the PHI surfaces (schedule, recording) until the BAA
// gate is satisfied; this endpoint is fine pre-acceptance.

import { Router, type IRouter } from "express";
import { initializeMobileFor } from "../services/mobile-init";

const router: IRouter = Router();

router.post("/m/initialize", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const result = await initializeMobileFor(user.id);
    res.json({
      initialized: result.initialized,
      autoPushMode: result.user.autoPushMode,
      autoPushOrders: result.user.autoPushOrders,
      autoPushMedications: result.user.autoPushMedications,
      autoApproveNonMedOrders: result.user.autoApproveNonMedOrders,
      mobileOnboardedAt: result.user.mobileOnboardedAt,
    });
  } catch (err) {
    req.log.error({ err, userId: user.id }, "Mobile init failed");
    res.status(500).json({ error: "mobile_init_failed" });
  }
});

export default router;
