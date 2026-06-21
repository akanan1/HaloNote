import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { CreatePatientBody, ListPatientsResponse } from "@workspace/api-zod";
import { getDb, notesTable, patientsTable } from "@workspace/db";
import { listPatients } from "../lib/patients";
import { PatientSyncError, syncPatientFromEhr } from "../lib/patient-sync";
import { getPatientHistory, HistoryError } from "../lib/ehr-history";
import { PatientMappingError } from "@workspace/ehr";
import { getActiveOrgId } from "../lib/active-org";
import { isUniqueViolation, respondInvalidBody } from "../http";

const router: IRouter = Router();

router.get("/patients", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const patients = await listPatients(orgId);
  const payload = ListPatientsResponse.parse({ data: patients });
  res.json(payload);
});

// Single-patient lookup. Mounted BEFORE /patients/sync and
// /patients/:id/history so Express's first-match routing reaches the
// more specific endpoints first; placing this under /patients keeps it
// path-distinct from /sync and /history (which are sibling literal
// segments, not :id matches, in Express's router).
router.get("/patients/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const [row] = await getDb()
    .select()
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, req.params.id),
        eq(patientsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  res.json({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: row.dateOfBirth,
    mrn: row.mrn,
  });
});

// ---------------------------------------------------------------------------
// GET /patients/:id/vital-trends — chronological list of persisted
// extracted_vitals across the patient's notes. Used by the
// EncounterReview Vitals panel to render "from 138/86 last visit"
// inline on each tile. Optional ?excludeNoteId so the panel can ask
// for "prior visits, NOT this note's own values."
// ---------------------------------------------------------------------------
router.get("/patients/:id/vital-trends", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const excludeNoteId =
    typeof req.query["excludeNoteId"] === "string"
      ? req.query["excludeNoteId"].trim() || undefined
      : undefined;

  // Capped at 10 — enough for the panel's "last visit" comparison and
  // a future small sparkline. The query indexes well: (patient_id,
  // created_at desc) covers everything.
  const conditions = [
    eq(notesTable.patientId, req.params.id),
    eq(notesTable.organizationId, orgId),
    isNotNull(notesTable.extractedVitals),
  ];
  if (excludeNoteId) conditions.push(ne(notesTable.id, excludeNoteId));

  const rows = await getDb()
    .select({
      noteId: notesTable.id,
      encounterId: notesTable.encounterId,
      noteCreatedAt: notesTable.createdAt,
      noteUpdatedAt: notesTable.updatedAt,
      noteStatus: notesTable.status,
      extractedVitals: notesTable.extractedVitals,
    })
    .from(notesTable)
    .where(and(...conditions))
    .orderBy(desc(notesTable.createdAt))
    .limit(10);

  res.json({
    data: rows.map((r) => ({
      noteId: r.noteId,
      encounterId: r.encounterId,
      noteCreatedAt: r.noteCreatedAt.toISOString(),
      noteUpdatedAt: r.noteUpdatedAt.toISOString(),
      noteStatus: r.noteStatus,
      extractedVitals: r.extractedVitals,
    })),
  });
});

router.post("/patients", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const parsed = CreatePatientBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  try {
    const inserted = await getDb()
      .insert(patientsTable)
      .values({
        id: `pt_${randomUUID()}`,
        organizationId: orgId,
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
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

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
    fields = await syncPatientFromEhr(externalId.trim(), req.user?.id);
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
    // MRN is now only unique within an org, so scope the lookup. A
    // different org may have a row with the same MRN and that's their
    // patient, not ours.
    const existing = await db
      .select()
      .from(patientsTable)
      .where(
        and(
          eq(patientsTable.organizationId, orgId),
          eq(patientsTable.mrn, fields.mrn),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const updated = await db
        .update(patientsTable)
        .set({
          ehrPatientId: fields.ehrPatientId,
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
        organizationId: orgId,
        ehrPatientId: fields.ehrPatientId,
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
    const history = await getPatientHistory(ehrPatientId, req.user?.id);
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

export default router;
