import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import accessRequestsRouter from "./access-requests";
import patientsRouter from "./patients";
import notesRouter from "./notes";
import auditLogRouter from "./audit-log";
import usersRouter from "./users";
import scheduleRouter from "./schedule";
import templatesRouter from "./templates";
import phraseMappingsRouter from "./phrase-mappings";
import noteDefaultsRouter from "./note-defaults";
import onboardingRouter from "./onboarding";
import legalRouter from "./legal";
import founderRouter from "./founder";
import recordingsRouter from "./recordings";
import ehrOauthRouter from "./ehr-oauth";
import encountersRouter from "./encounters";
import billingRouter from "./billing";
import ordersRouter from "./orders";
import tasksRouter from "./tasks";
import devSandboxRouter from "./dev-sandbox";
import { requireAuth } from "../middlewares/require-auth";
import { requireCsrf } from "../middlewares/require-csrf";
import { requireBaa } from "../middlewares/require-baa";
import { auditLog } from "../middlewares/audit";
import { devRoutesEnabled } from "../lib/dev-routes";

const router: IRouter = Router();

// Public.
router.use(healthRouter);
router.use(authRouter);
router.use(accessRequestsRouter);

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
// Admin sub-routers are mounted under explicit path prefixes. Without
// the prefix, their top-level `router.use(requireAdmin)` runs path-
// agnostically and 403s every non-admin request that reaches them,
// blocking everything mounted after them (notably ehrOauthRouter, used
// by physicians to connect their own EHR). With a path prefix, the
// admin gate only fires for requests under that prefix.
router.use("/audit-log", auditLogRouter);
router.use("/users", usersRouter);
// Non-PHI personalization + auth surfaces stay open so a user who
// hasn't accepted the BAA yet can still finish onboarding (load
// agreements, accept them, set defaults). Patient-facing surfaces are
// gated with `requireBaa` below — defense in depth so a route added
// later can't accidentally accept PHI from an unaccepted user.
router.use(templatesRouter);
router.use(phraseMappingsRouter);
router.use(noteDefaultsRouter);
router.use(onboardingRouter);
router.use(legalRouter);
// Founder router stays above the PHI gate so the founder can audit
// users (including their legal acceptance status) without themselves
// needing to have accepted the BAA — they may be viewing data BEFORE
// any patient signups exist. The router's own `requireFounder`
// middleware locks it down.
router.use(founderRouter);

// ============================================================
// PHI gate — every route below this line handles patient PHI
// (records, schedule pulls, audio segments, generated notes).
// `requireBaa` fails closed (403) if the user hasn't accepted
// the current BAA version, so a route added below this line
// cannot accidentally accept PHI from an unaccepted user.
// ============================================================
router.use(requireBaa);
router.use(patientsRouter);
router.use(encountersRouter);
router.use(notesRouter);
router.use(billingRouter);
router.use(ordersRouter);
router.use(tasksRouter);
router.use(scheduleRouter);
router.use(recordingsRouter);
router.use(ehrOauthRouter);

export default router;
