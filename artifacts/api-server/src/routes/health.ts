import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const HEALTH_PAYLOAD = HealthCheckResponse.parse({ status: "ok" });

router.get("/healthz", (_req, res) => {
  res.json(HEALTH_PAYLOAD);
});

export default router;
