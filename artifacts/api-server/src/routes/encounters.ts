import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import {
  encountersTable,
  getDb,
  patientsTable,
  type Encounter,
  type EncounterStatus,
  type VisitType,
} from "@workspace/db";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

// The taxonomy mirrors the TS VisitType union exactly. Kept inline so
// Zod can validate without importing the shape at runtime; if it
// drifts from the schema, typecheck on the route's switch statements
// catches it.
const VISIT_TYPES = [
  "new_patient",
  "established_patient",
  "follow_up",
  "annual_physical",
  "hospital_follow_up",
  "procedure",
  "telehealth",
  "nursing_facility",
  "custom",
] as const satisfies readonly VisitType[];

const ENCOUNTER_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const satisfies readonly EncounterStatus[];

// Encounter status transitions. Reads as: from → allowed next states.
// `completed` and `cancelled` are terminal — once an encounter is done
// you don't reopen it, you create a new one (or an amendment note).
const ALLOWED_TRANSITIONS: Record<EncounterStatus, readonly EncounterStatus[]> = {
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const CreateEncounterBody = z.object({
  patientId: z.string().min(1),
  visitType: z.enum(VISIT_TYPES),
  customLabel: z.string().min(1).max(120).optional(),
  isTelehealth: z.boolean().optional(),
  location: z.string().max(120).optional(),
  scheduledAt: z.iso.datetime().optional(),
  providerId: z.string().min(1).optional(),
});

const UpdateEncounterBody = z.object({
  visitType: z.enum(VISIT_TYPES).optional(),
  customLabel: z.string().min(1).max(120).nullable().optional(),
  isTelehealth: z.boolean().optional(),
  location: z.string().max(120).nullable().optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
  scheduledAt: z.iso.datetime().nullable().optional(),
  providerId: z.string().min(1).nullable().optional(),
});

function serialize(row: Encounter) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    patientId: row.patientId,
    providerId: row.providerId,
    visitType: row.visitType,
    customLabel: row.customLabel,
    status: row.status,
    isTelehealth: row.isTelehealth,
    location: row.location,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.post("/encounters", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateEncounterBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  // visit_type='custom' requires a customLabel; any other value forbids
  // it (avoids stale labels lingering on a re-categorized visit).
  if (parsed.data.visitType === "custom" && !parsed.data.customLabel) {
    res.status(400).json({ error: "custom_label_required" });
    return;
  }
  if (parsed.data.visitType !== "custom" && parsed.data.customLabel) {
    res.status(400).json({ error: "custom_label_forbidden_for_known_type" });
    return;
  }

  // Verify the patient belongs to the active org. 404 (not 403) so we
  // don't leak existence of cross-tenant rows.
  const [patient] = await getDb()
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, parsed.data.patientId),
        eq(patientsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  try {
    const [inserted] = await getDb()
      .insert(encountersTable)
      .values({
        organizationId: orgId,
        patientId: parsed.data.patientId,
        providerId: parsed.data.providerId ?? req.user?.id ?? null,
        visitType: parsed.data.visitType,
        customLabel: parsed.data.customLabel ?? null,
        isTelehealth: parsed.data.isTelehealth ?? false,
        location: parsed.data.location ?? null,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : null,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    req.log.error({ err }, "Failed to insert encounter");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.get("/encounters", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  // Optional ?patientId=... filter. Useful for the chart view ("all
  // encounters for this patient"). Skipped if absent — returns the
  // whole org's recent encounters, capped for safety.
  const patientId =
    typeof req.query["patientId"] === "string"
      ? req.query["patientId"]
      : undefined;

  const conditions = [eq(encountersTable.organizationId, orgId)];
  if (patientId) conditions.push(eq(encountersTable.patientId, patientId));

  const rows = await getDb()
    .select()
    .from(encountersTable)
    .where(and(...conditions))
    .orderBy(desc(encountersTable.createdAt))
    .limit(200);
  res.json({ data: rows.map(serialize) });
});

router.get("/encounters/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const [row] = await getDb()
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, req.params.id),
        eq(encountersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }
  res.json(serialize(row));
});

router.patch("/encounters/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateEncounterBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const [existing] = await getDb()
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, req.params.id),
        eq(encountersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }

  // Status transition enforcement. The state machine forbids reopening
  // a terminal encounter — to amend, the provider creates a new note
  // that replaces the old one via the FHIR replaces chain.
  const updates: Partial<typeof encountersTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.status && parsed.data.status !== existing.status) {
    const allowed = ALLOWED_TRANSITIONS[existing.status];
    if (!allowed.includes(parsed.data.status)) {
      res.status(409).json({
        error: "illegal_status_transition",
        from: existing.status,
        to: parsed.data.status,
      });
      return;
    }
    updates.status = parsed.data.status;
    // Auto-stamp lifecycle timestamps so callers don't have to.
    if (parsed.data.status === "in_progress" && !existing.startedAt) {
      updates.startedAt = new Date();
    }
    if (parsed.data.status === "completed" && !existing.completedAt) {
      updates.completedAt = new Date();
      // A completed encounter without a startedAt is suspicious but
      // not illegal — same-day walk-ins might skip the in_progress
      // step. Backfill startedAt to completedAt so reports don't
      // show NULL.
      if (!existing.startedAt) updates.startedAt = updates.completedAt;
    }
  }

  // visit_type changes: if changing TO custom, customLabel must come
  // along; if changing AWAY from custom, clear any stale customLabel.
  if (parsed.data.visitType && parsed.data.visitType !== existing.visitType) {
    updates.visitType = parsed.data.visitType;
    if (parsed.data.visitType === "custom") {
      const label = parsed.data.customLabel ?? existing.customLabel;
      if (!label) {
        res.status(400).json({ error: "custom_label_required" });
        return;
      }
      updates.customLabel = label;
    } else {
      updates.customLabel = null;
    }
  } else if (parsed.data.customLabel !== undefined) {
    // visit_type unchanged but customLabel explicitly provided.
    // Honor only if currently custom.
    if (existing.visitType === "custom") {
      updates.customLabel = parsed.data.customLabel;
    }
    // Otherwise silently ignore — patch is permissive on stale fields.
  }

  if (parsed.data.isTelehealth !== undefined)
    updates.isTelehealth = parsed.data.isTelehealth;
  if (parsed.data.location !== undefined) updates.location = parsed.data.location;
  if (parsed.data.scheduledAt !== undefined) {
    updates.scheduledAt = parsed.data.scheduledAt
      ? new Date(parsed.data.scheduledAt)
      : null;
  }
  if (parsed.data.providerId !== undefined) updates.providerId = parsed.data.providerId;

  try {
    const [updated] = await getDb()
      .update(encountersTable)
      .set(updates)
      .where(
        and(
          eq(encountersTable.id, req.params.id),
          eq(encountersTable.organizationId, orgId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "encounter_not_found" });
      return;
    }
    res.json(serialize(updated));
  } catch (err) {
    req.log.error({ err, id: req.params.id }, "Failed to update encounter");
    res.status(500).json({ error: "persistence_failed" });
  }
});

export default router;
