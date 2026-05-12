import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import patientsRouter from "./patients";
import notesRouter from "./notes";
import auditLogRouter from "./audit-log";
import { requireAuth } from "../middlewares/require-auth";
import { requireCsrf } from "../middlewares/require-csrf";
import { auditLog } from "../middlewares/audit";

const router: IRouter = Router();

// Public.
router.use(healthRouter);
router.use(authRouter);

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

export default router;
