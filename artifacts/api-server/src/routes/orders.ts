import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import {
  approvedBillingCodesTable,
  approvedOrdersTable,
  encountersTable,
  getDb,
  notesTable,
  orderSuggestionsTable,
  patientsTable,
  type ApprovedOrder,
  type OrderSuggestion,
  type OrderType,
} from "@workspace/db";
import { normalizeOrder, suggestOrders } from "../lib/order-suggester";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

const ORDER_TYPES = [
  "lab",
  "imaging",
  "referral",
  "medication",
  "procedure",
  "followup",
  "instruction",
  "dme",
  "therapy",
  "nursing",
] as const satisfies readonly OrderType[];

function serializeSuggestion(row: OrderSuggestion) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    orderType: row.orderType,
    name: row.name,
    indication: row.indication,
    indicationDiagnosisCode: row.indicationDiagnosisCode,
    priority: row.priority,
    instructions: row.instructions,
    frequency: row.frequency,
    duration: row.duration,
    medicationName: row.medicationName,
    medicationDose: row.medicationDose,
    medicationRoute: row.medicationRoute,
    medicationFrequency: row.medicationFrequency,
    medicationDuration: row.medicationDuration,
    medicationQuantity: row.medicationQuantity,
    medicationRefills: row.medicationRefills,
    isComplete: row.isComplete,
    safetyWarnings: row.safetyWarnings,
    rationale: row.rationale,
    supportingExcerpts: row.supportingExcerpts,
    status: row.status,
    statusNote: row.statusNote,
    createdByAi: row.createdByAi,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeApproved(row: ApprovedOrder) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    sourceSuggestionId: row.sourceSuggestionId,
    orderType: row.orderType,
    name: row.name,
    indication: row.indication,
    indicationDiagnosisCode: row.indicationDiagnosisCode,
    priority: row.priority,
    instructions: row.instructions,
    frequency: row.frequency,
    duration: row.duration,
    medicationName: row.medicationName,
    medicationDose: row.medicationDose,
    medicationRoute: row.medicationRoute,
    medicationFrequency: row.medicationFrequency,
    medicationDuration: row.medicationDuration,
    medicationQuantity: row.medicationQuantity,
    medicationRefills: row.medicationRefills,
    isComplete: row.isComplete,
    safetyWarnings: row.safetyWarnings,
    status: row.status,
    statusNote: row.statusNote,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    exportReadyAt: row.exportReadyAt?.toISOString() ?? null,
    exportedAt: row.exportedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Apply normalizeOrder's medication-safety pass to a row's structured
// medication fields. Mirrors the suggester's check but works on the
// flat row shape used by the routes (medicationName + medicationDose etc.
// vs the nested medication object the suggester emits). Returns the
// updated isComplete + safetyWarnings without persisting.
function reNormalizeRow(input: {
  orderType: OrderType;
  medicationName: string | null;
  medicationDose: string | null;
  medicationRoute: string | null;
  medicationFrequency: string | null;
  medicationDuration: string | null;
  medicationQuantity: number | null;
  medicationRefills: number | null;
  safetyWarnings: unknown;
}): {
  isComplete: boolean;
  safetyWarnings: Array<{ kind: string; message: string; severity: "info" | "warn" | "block" }>;
} {
  // Drop any existing 'missing_field' / 'missing_medication_block' /
  // 'missing_quantity' / 'missing_refills' warnings so the check is
  // idempotent — those will be re-added below if still applicable.
  const RECOMPUTED_KINDS = new Set([
    "missing_field",
    "missing_medication_block",
    "missing_quantity",
    "missing_refills",
  ]);
  const preserved = Array.isArray(input.safetyWarnings)
    ? (input.safetyWarnings as Array<{
        kind: string;
        message: string;
        severity: "info" | "warn" | "block";
      }>).filter((w) => !RECOMPUTED_KINDS.has(w.kind))
    : [];

  const medBlock =
    input.orderType === "medication"
      ? {
          name: input.medicationName ?? "",
          dose: input.medicationDose ?? "",
          route: input.medicationRoute ?? "",
          frequency: input.medicationFrequency ?? "",
          duration: input.medicationDuration ?? "",
          ...(input.medicationQuantity != null
            ? { quantity: input.medicationQuantity }
            : {}),
          ...(input.medicationRefills != null
            ? { refills: input.medicationRefills }
            : {}),
        }
      : undefined;

  // Pass through normalizeOrder using a synthesized SuggestedOrder shape.
  // We only care about the warnings + isComplete output; everything else
  // is throwaway.
  const synthesized = {
    orderType: input.orderType,
    name: "x",
    indication: "x",
    priority: "routine" as const,
    rationale: "x",
    supportingExcerpts: [],
    safetyWarnings: preserved,
    ...(medBlock ? { medication: medBlock } : {}),
  };
  const out = normalizeOrder(synthesized);
  return { isComplete: out.isComplete, safetyWarnings: out.safetyWarnings };
}

// ---------------------------------------------------------------------------
// POST /encounters/:id/orders/suggest — run the AI suggester, persist the
// emitted orders as order_suggestions rows, return the new batch.
// ---------------------------------------------------------------------------
router.post("/encounters/:id/orders/suggest", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const encounterId = req.params.id;
  const db = getDb();

  const [encounter] = await db
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, encounterId),
        eq(encountersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!encounter) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }

  const [patient] = await db
    .select({ id: patientsTable.id, dateOfBirth: patientsTable.dateOfBirth })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, encounter.patientId),
        eq(patientsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  const [note] = await db
    .select({ body: notesTable.body })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.encounterId, encounterId),
        eq(notesTable.organizationId, orgId),
      ),
    )
    .orderBy(desc(notesTable.updatedAt))
    .limit(1);
  if (!note) {
    res.status(409).json({ error: "no_note_to_order_from" });
    return;
  }

  // Approved diagnoses on the encounter — passed to the suggester so it
  // can link orders to ICD-10s without making the provider re-type.
  const approvedDx = await db
    .select({
      code: approvedBillingCodesTable.code,
      description: approvedBillingCodesTable.description,
    })
    .from(approvedBillingCodesTable)
    .where(
      and(
        eq(approvedBillingCodesTable.encounterId, encounterId),
        eq(approvedBillingCodesTable.organizationId, orgId),
        eq(approvedBillingCodesTable.codeSystem, "icd10"),
      ),
    );

  const { result, source } = await suggestOrders({
    encounter: {
      id: encounter.id,
      visitType: encounter.visitType,
      customLabel: encounter.customLabel,
      isTelehealth: encounter.isTelehealth,
      scheduledAt: encounter.scheduledAt,
    },
    patient,
    noteBody: note.body,
    approvedDiagnoses: approvedDx,
  });

  if (result.orders.length === 0) {
    res.json({ data: [], source });
    return;
  }

  try {
    const inserted = await db
      .insert(orderSuggestionsTable)
      .values(
        result.orders.map((n) => ({
          organizationId: orgId,
          encounterId,
          orderType: n.raw.orderType,
          name: n.raw.name,
          indication: n.raw.indication,
          indicationDiagnosisCode: n.raw.indicationDiagnosisCode ?? null,
          priority: n.raw.priority,
          instructions: n.raw.instructions ?? null,
          frequency: n.raw.frequency ?? null,
          duration: n.raw.duration ?? null,
          medicationName: n.raw.medication?.name ?? null,
          medicationDose: n.raw.medication?.dose ?? null,
          medicationRoute: n.raw.medication?.route ?? null,
          medicationFrequency: n.raw.medication?.frequency ?? null,
          medicationDuration: n.raw.medication?.duration ?? null,
          medicationQuantity: n.raw.medication?.quantity ?? null,
          medicationRefills: n.raw.medication?.refills ?? null,
          isComplete: n.isComplete,
          safetyWarnings: n.safetyWarnings,
          rationale: n.raw.rationale,
          supportingExcerpts: n.raw.supportingExcerpts,
          createdByAi: true,
        })),
      )
      .returning();
    res.status(201).json({ data: inserted.map(serializeSuggestion), source });
  } catch (err) {
    req.log.error({ err, encounterId }, "Failed to persist order suggestions");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /encounters/:id/orders — list suggestions + approved orders.
// ---------------------------------------------------------------------------
router.get("/encounters/:id/orders", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const encounterId = req.params.id;
  const db = getDb();

  const [encounter] = await db
    .select({ id: encountersTable.id })
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, encounterId),
        eq(encountersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!encounter) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }

  const [suggestions, approved] = await Promise.all([
    db
      .select()
      .from(orderSuggestionsTable)
      .where(
        and(
          eq(orderSuggestionsTable.encounterId, encounterId),
          eq(orderSuggestionsTable.organizationId, orgId),
        ),
      )
      .orderBy(desc(orderSuggestionsTable.createdAt)),
    db
      .select()
      .from(approvedOrdersTable)
      .where(
        and(
          eq(approvedOrdersTable.encounterId, encounterId),
          eq(approvedOrdersTable.organizationId, orgId),
        ),
      )
      .orderBy(desc(approvedOrdersTable.createdAt)),
  ]);

  res.json({
    suggestions: suggestions.map(serializeSuggestion),
    approvedOrders: approved.map(serializeApproved),
  });
});

// ---------------------------------------------------------------------------
// POST /orders/suggestions/:id/approve — provider sign-off on a suggestion.
// Atomically creates an approved_orders row and flips the suggestion status.
// ---------------------------------------------------------------------------
router.post("/orders/suggestions/:id/approve", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const approver = req.user;
  if (!approver) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const suggestionId = req.params.id;
  const db = getDb();

  const [suggestion] = await db
    .select()
    .from(orderSuggestionsTable)
    .where(
      and(
        eq(orderSuggestionsTable.id, suggestionId),
        eq(orderSuggestionsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!suggestion) {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (suggestion.status === "approved") {
    res.status(409).json({ error: "already_approved" });
    return;
  }
  if (suggestion.status === "rejected") {
    res.status(409).json({ error: "already_rejected" });
    return;
  }
  if (suggestion.status === "exported") {
    res.status(409).json({ error: "already_exported" });
    return;
  }

  try {
    const approved = await db.transaction(async (tx) => {
      const [approvedRow] = await tx
        .insert(approvedOrdersTable)
        .values({
          organizationId: orgId,
          encounterId: suggestion.encounterId,
          sourceSuggestionId: suggestion.id,
          orderType: suggestion.orderType,
          name: suggestion.name,
          indication: suggestion.indication,
          indicationDiagnosisCode: suggestion.indicationDiagnosisCode,
          priority: suggestion.priority,
          instructions: suggestion.instructions,
          frequency: suggestion.frequency,
          duration: suggestion.duration,
          medicationName: suggestion.medicationName,
          medicationDose: suggestion.medicationDose,
          medicationRoute: suggestion.medicationRoute,
          medicationFrequency: suggestion.medicationFrequency,
          medicationDuration: suggestion.medicationDuration,
          medicationQuantity: suggestion.medicationQuantity,
          medicationRefills: suggestion.medicationRefills,
          isComplete: suggestion.isComplete,
          safetyWarnings: suggestion.safetyWarnings,
          status: "approved",
          approvedAt: new Date(),
          approvedByUserId: approver.id,
        })
        .returning();
      if (!approvedRow) throw new Error("Approved order insert returned no row");

      await tx
        .update(orderSuggestionsTable)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(orderSuggestionsTable.id, suggestion.id));

      return approvedRow;
    });
    res.status(201).json(serializeApproved(approved));
  } catch (err) {
    req.log.error({ err, suggestionId }, "Failed to approve order suggestion");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /orders/suggestions/:id/reject — captures reason.
// ---------------------------------------------------------------------------
const RejectBody = z.object({ reason: z.string().min(1).max(500) });

router.post("/orders/suggestions/:id/reject", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = RejectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select({ id: orderSuggestionsTable.id, status: orderSuggestionsTable.status })
    .from(orderSuggestionsTable)
    .where(
      and(
        eq(orderSuggestionsTable.id, id),
        eq(orderSuggestionsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (existing.status === "approved" || existing.status === "exported") {
    res.status(409).json({ error: "cannot_reject_approved", status: existing.status });
    return;
  }

  const [updated] = await db
    .update(orderSuggestionsTable)
    .set({ status: "rejected", statusNote: parsed.data.reason, updatedAt: new Date() })
    .where(
      and(
        eq(orderSuggestionsTable.id, id),
        eq(orderSuggestionsTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  res.json(serializeSuggestion(updated));
});

// ---------------------------------------------------------------------------
// POST /orders — manually create an approved order (no AI suggestion behind
// it). Used by the provider to add an order the AI missed.
// ---------------------------------------------------------------------------
const MedicationBody = z.object({
  name: z.string().min(1).max(200),
  dose: z.string().min(1).max(100),
  route: z.string().min(1).max(40),
  frequency: z.string().min(1).max(80),
  duration: z.string().min(1).max(80),
  quantity: z.number().int().min(1).max(10000).optional(),
  refills: z.number().int().min(0).max(12).optional(),
});

const CreateOrderBody = z.object({
  encounterId: z.string().min(1),
  orderType: z.enum(ORDER_TYPES),
  name: z.string().min(1).max(300),
  indication: z.string().min(1).max(500),
  indicationDiagnosisCode: z.string().max(20).optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  instructions: z.string().max(2000).optional(),
  frequency: z.string().max(80).optional(),
  duration: z.string().max(80).optional(),
  medication: MedicationBody.optional(),
});

router.post("/orders", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const approver = req.user;
  if (!approver) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const db = getDb();

  const [encounter] = await db
    .select({ id: encountersTable.id, organizationId: encountersTable.organizationId })
    .from(encountersTable)
    .where(eq(encountersTable.id, parsed.data.encounterId))
    .limit(1);
  if (!encounter || encounter.organizationId !== orgId) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }

  const normalized = normalizeOrder({
    orderType: parsed.data.orderType,
    name: parsed.data.name,
    indication: parsed.data.indication,
    indicationDiagnosisCode: parsed.data.indicationDiagnosisCode,
    priority: parsed.data.priority ?? "routine",
    instructions: parsed.data.instructions,
    frequency: parsed.data.frequency,
    duration: parsed.data.duration,
    medication: parsed.data.medication,
    rationale: "Manually created by provider.",
    supportingExcerpts: [],
    safetyWarnings: [],
  });

  try {
    const [inserted] = await db
      .insert(approvedOrdersTable)
      .values({
        organizationId: orgId,
        encounterId: parsed.data.encounterId,
        orderType: parsed.data.orderType,
        name: parsed.data.name,
        indication: parsed.data.indication,
        indicationDiagnosisCode: parsed.data.indicationDiagnosisCode ?? null,
        priority: parsed.data.priority ?? "routine",
        instructions: parsed.data.instructions ?? null,
        frequency: parsed.data.frequency ?? null,
        duration: parsed.data.duration ?? null,
        medicationName: parsed.data.medication?.name ?? null,
        medicationDose: parsed.data.medication?.dose ?? null,
        medicationRoute: parsed.data.medication?.route ?? null,
        medicationFrequency: parsed.data.medication?.frequency ?? null,
        medicationDuration: parsed.data.medication?.duration ?? null,
        medicationQuantity: parsed.data.medication?.quantity ?? null,
        medicationRefills: parsed.data.medication?.refills ?? null,
        isComplete: normalized.isComplete,
        safetyWarnings: normalized.safetyWarnings,
        approvedAt: new Date(),
        approvedByUserId: approver.id,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serializeApproved(inserted));
  } catch (err) {
    req.log.error({ err }, "Failed to create manual order");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id — edit an approved order. Required for the common case
// of completing a partial medication order (filling in dose / refills the
// AI couldn't infer). Refused once the order has been marked
// export_ready, exported, or cancelled — those are terminal/locked.
// ---------------------------------------------------------------------------
const UpdateOrderBody = z.object({
  name: z.string().min(1).max(300).optional(),
  indication: z.string().min(1).max(500).optional(),
  indicationDiagnosisCode: z.string().max(20).nullable().optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  instructions: z.string().max(2000).nullable().optional(),
  frequency: z.string().max(80).nullable().optional(),
  duration: z.string().max(80).nullable().optional(),
  medicationName: z.string().min(1).max(200).nullable().optional(),
  medicationDose: z.string().min(1).max(100).nullable().optional(),
  medicationRoute: z.string().min(1).max(40).nullable().optional(),
  medicationFrequency: z.string().min(1).max(80).nullable().optional(),
  medicationDuration: z.string().min(1).max(80).nullable().optional(),
  medicationQuantity: z.number().int().min(1).max(10000).nullable().optional(),
  medicationRefills: z.number().int().min(0).max(12).nullable().optional(),
});

router.patch("/orders/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select()
    .from(approvedOrdersTable)
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (existing.status !== "approved") {
    res.status(409).json({ error: "order_locked", status: existing.status });
    return;
  }

  // Build the merged row to re-normalize. nullable fields use `=== undefined`
  // vs `=== null` semantics: undefined keeps the existing value, null clears it.
  const next = {
    name: parsed.data.name ?? existing.name,
    indication: parsed.data.indication ?? existing.indication,
    indicationDiagnosisCode:
      parsed.data.indicationDiagnosisCode === undefined
        ? existing.indicationDiagnosisCode
        : parsed.data.indicationDiagnosisCode,
    priority: parsed.data.priority ?? existing.priority,
    instructions:
      parsed.data.instructions === undefined
        ? existing.instructions
        : parsed.data.instructions,
    frequency:
      parsed.data.frequency === undefined ? existing.frequency : parsed.data.frequency,
    duration:
      parsed.data.duration === undefined ? existing.duration : parsed.data.duration,
    medicationName:
      parsed.data.medicationName === undefined
        ? existing.medicationName
        : parsed.data.medicationName,
    medicationDose:
      parsed.data.medicationDose === undefined
        ? existing.medicationDose
        : parsed.data.medicationDose,
    medicationRoute:
      parsed.data.medicationRoute === undefined
        ? existing.medicationRoute
        : parsed.data.medicationRoute,
    medicationFrequency:
      parsed.data.medicationFrequency === undefined
        ? existing.medicationFrequency
        : parsed.data.medicationFrequency,
    medicationDuration:
      parsed.data.medicationDuration === undefined
        ? existing.medicationDuration
        : parsed.data.medicationDuration,
    medicationQuantity:
      parsed.data.medicationQuantity === undefined
        ? existing.medicationQuantity
        : parsed.data.medicationQuantity,
    medicationRefills:
      parsed.data.medicationRefills === undefined
        ? existing.medicationRefills
        : parsed.data.medicationRefills,
  };

  const renorm = reNormalizeRow({
    orderType: existing.orderType,
    medicationName: next.medicationName,
    medicationDose: next.medicationDose,
    medicationRoute: next.medicationRoute,
    medicationFrequency: next.medicationFrequency,
    medicationDuration: next.medicationDuration,
    medicationQuantity: next.medicationQuantity,
    medicationRefills: next.medicationRefills,
    safetyWarnings: existing.safetyWarnings,
  });

  const [updated] = await db
    .update(approvedOrdersTable)
    .set({
      ...next,
      isComplete: renorm.isComplete,
      safetyWarnings: renorm.safetyWarnings,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  res.json(serializeApproved(updated));
});

// ---------------------------------------------------------------------------
// POST /orders/:id/mark-export-ready — flip approved → export_ready.
// REFUSES if isComplete=false. Hardcoded patient-safety rule per the
// non-negotiable requirements: medication orders missing dose/route/
// frequency/duration cannot reach a downstream system.
// ---------------------------------------------------------------------------
router.post("/orders/:id/mark-export-ready", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select()
    .from(approvedOrdersTable)
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (existing.status !== "approved") {
    res
      .status(409)
      .json({ error: "order_not_in_approved_state", status: existing.status });
    return;
  }
  if (!existing.isComplete) {
    res.status(409).json({
      error: "order_incomplete",
      safetyWarnings: existing.safetyWarnings,
      message:
        "Order has unresolved completeness issues. Address the block-severity " +
        "safety warnings and PATCH the missing fields before marking export-ready.",
    });
    return;
  }

  const [updated] = await db
    .update(approvedOrdersTable)
    .set({
      status: "export_ready",
      exportReadyAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  res.json(serializeApproved(updated));
});

// ---------------------------------------------------------------------------
// POST /orders/:id/cancel — provider withdraws the order before submission.
// Terminal; cannot un-cancel (use POST /orders to recreate).
// ---------------------------------------------------------------------------
const CancelBody = z.object({ reason: z.string().min(1).max(500) });

router.post("/orders/:id/cancel", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CancelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select({ id: approvedOrdersTable.id, status: approvedOrdersTable.status })
    .from(approvedOrdersTable)
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (existing.status === "exported") {
    res.status(409).json({ error: "cannot_cancel_exported" });
    return;
  }
  if (existing.status === "cancelled") {
    res.status(409).json({ error: "already_cancelled" });
    return;
  }

  const [updated] = await db
    .update(approvedOrdersTable)
    .set({
      status: "cancelled",
      statusNote: parsed.data.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvedOrdersTable.id, id),
        eq(approvedOrdersTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  res.json(serializeApproved(updated));
});

export default router;
