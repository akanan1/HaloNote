import { Router, type IRouter } from "express";
import { ListPatientsResponse } from "@workspace/api-zod";
import { listPatients } from "../lib/patients";

const router: IRouter = Router();

router.get("/patients", async (_req, res) => {
  const patients = await listPatients();
  const payload = ListPatientsResponse.parse({ data: patients });
  res.json(payload);
});

export default router;
