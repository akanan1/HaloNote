import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { CreatePatientBody, ListPatientsResponse } from "@workspace/api-zod";
import { getDb, patientsTable } from "@workspace/db";
import { listPatients } from "../lib/patients";
import { PatientSyncError, syncPatientFromEhr } from "../lib/patient-sync";
import { getPatientHistory, HistoryError } from "../lib/ehr-history";
import { PatientMappingError } from "@workspace/ehr";

const router: IRouter = Router();

router.get("/patients", async (_req, res) => {
  const patients = await listPatients();
  const payload = ListPatientsResponse.parse({ data: patients });
  res.json(payload);
});

router.post("/patients", async (req, res) => {
  const parsed = CreatePatientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  try {
    const inserted = await getDb()
      .insert(patientsTable)
      .values({
        id: `pt_${randomUUID()}`,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        dateOfBirth: parsed.data.dateOfBirth,
        mrn: parsed.data.mrn,
      })
      .returning();
    const patient = inserted[0];
    if (!patient) throw new Error("Insert returned no row");

    res.status(201).json({
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
      mrn: patient.mrn,
    });
  } catch (err) {
    // 23505 = Postgres unique_violation. mrn is the only unique column
    // on patients (the id is auto-generated), so we treat any 23505 as a
    // duplicate MRN. Drizzle sometimes wraps the pg error in `cause`,
    // so check both top-level and wrapped.
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "mrn_already_exists" });
      return;
    }
    req.log.error({ err }, "Failed to insert patient");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.post("/patients/sync", async (req, res) => {
  const externalId =
    typeof req.body === "object" && req.body !== null
      ? (req.body as { externalId?: unknown }).externalId
      : undefined;
  if (typeof externalId !== "string" || externalId.trim().length === 0) {
    res.status(400).json({ error: "missing_external_id" });
    return;
  }

  let fields;
  try {
    fields = await syncPatientFromEhr(externalId.trim());
  } catch (err) {
    if (err instanceof PatientMappingError) {
      req.log.warn({ err, externalId }, "EHR patient missing required fields");
      res.status(422).json({ error: "ehr_patient_incomplete", detail: err.message });
      return;
    }
    if (err instanceof PatientSyncError) {
      req.log.warn({ err, externalId, status: err.status }, "EHR patient sync failed");
      res.status(err.status).json({
        error: err.status === 404 ? "ehr_patient_not_found" : "ehr_unavailable",
      });
      return;
    }
    req.log.error({ err, externalId }, "Unexpected error during patient sync");
    res.status(500).json({ error: "internal_server_error" });
    return;
  }

  const db = getDb();

  try {
    // Upsert keyed on MRN — that's the only natural identity we share
    // with the EHR. If the row exists, refresh demographic fields in case
    // they changed upstream.
    const existing = await db
      .select()
      .from(patientsTable)
      .where(eq(patientsTable.mrn, fields.mrn))
      .limit(1);

    if (existing[0]) {
      const updated = await db
        .update(patientsTable)
        .set({
          firstName: fields.firstName,
          lastName: fields.lastName,
          dateOfBirth: fields.dateOfBirth,
        })
        .where(eq(patientsTable.id, existing[0].id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error("Update returned no row");
      res.json({
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        dateOfBirth: row.dateOfBirth,
        mrn: row.mrn,
        synced: { provider: fields.provider, created: false },
      });
      return;
    }

    const inserted = await db
      .insert(patientsTable)
      .values({
        id: `pt_${randomUUID()}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
        dateOfBirth: fields.dateOfBirth,
        mrn: fields.mrn,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Insert returned no row");

    res.status(201).json({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      dateOfBirth: row.dateOfBirth,
      mrn: row.mrn,
      synced: { provider: fields.provider, created: true },
    });
  } catch (err) {
    req.log.error({ err, externalId }, "Failed to upsert synced patient");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// History endpoint — fetches a patient's active problems, meds, and
// allergies from the configured EHR. The :id here is the EHR Patient.id
// (same shape as /patients/sync's externalId), NOT the local pt_*.
router.get("/patients/:id/history", async (req, res) => {
  const ehrPatientId = req.params.id;
  if (!ehrPatientId) {
    res.status(400).json({ error: "missing_patient_id" });
    return;
  }
  try {
    const history = await getPatientHistory(ehrPatientId);
    res.json(history);
  } catch (err) {
    if (err instanceof HistoryError) {
      req.log.warn(
        { err, ehrPatientId, status: err.status },
        "patient history fetch failed",
      );
      res.status(err.status).json({ error: "ehr_unavailable" });
      return;
    }
    req.log.error({ err, ehrPatientId }, "patient history fetch failed");
    res.status(500).json({ error: "internal_server_error" });
  }
});

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && e.cause.code === "23505") {
    return true;
  }
  return false;
}

export default router;
