import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import patientsRouter from "./patients";
import notesRouter from "./notes";
import auditLogRouter from "./audit-log";
import usersRouter from "./users";
import scheduleRouter from "./schedule";
import templatesRouter from "./templates";
import ehrOauthRouter from "./ehr-oauth";
import devSandboxRouter from "./dev-sandbox";
import { requireAuth } from "../middlewares/require-auth";
import { requireCsrf } from "../middlewares/require-csrf";
import { auditLog } from "../middlewares/audit";
import { devRoutesEnabled } from "../lib/dev-routes";

const router: IRouter = Router();

// Public.
router.use(healthRouter);
router.use(authRouter);

// Dev-only mounts. Double-gated by devRoutesEnabled() — both
// NODE_ENV != "production" AND ALLOW_DEV_ROUTES=1 must hold. These
// bypass auth and CSRF so they can be opened directly in the browser
// to demo the live Athena sandbox integration; the second gate makes
// it much harder to ship them accidentally.
if (devRoutesEnabled()) {
  router.use(devSandboxRouter);
}

// Everything below requires a valid session and (for state-changing
// requests) a matching X-CSRF-Token header. Audit log fires after
// authentication so we know which user made the request. Reads of
// /audit-log themselves are logged — listing access is a meta event
// you want recorded for compliance.
router.use(requireAuth);
router.use(requireCsrf);
router.use(auditLog);
router.use(patientsRouter);
router.use(notesRouter);
router.use(auditLogRouter);
router.use(usersRouter);
router.use(scheduleRouter);
router.use(templatesRouter);
router.use(ehrOauthRouter);

export default router;
