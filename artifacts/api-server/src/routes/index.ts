import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import patientsRouter from "./patients";
import notesRouter from "./notes";
import { requireAuth } from "../middlewares/require-auth";
import { requireCsrf } from "../middlewares/require-csrf";

const router: IRouter = Router();

// Public.
router.use(healthRouter);
router.use(authRouter);

// Everything below requires a valid session and (for state-changing
// requests) a matching X-CSRF-Token header.
router.use(requireAuth);
router.use(requireCsrf);
router.use(patientsRouter);
router.use(notesRouter);

export default router;
