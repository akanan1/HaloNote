import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import {
  approvedBillingCodesTable,
  billingSuggestionsTable,
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  type ApprovedBillingCode,
  type BillingSuggestion,
} from "@workspace/db";
import { suggestBillingCodes } from "../lib/billing-suggester";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

function serializeSuggestion(row: BillingSuggestion) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    codeSystem: row.codeSystem,
    code: row.code,
    description: row.description,
    rationale: row.rationale,
    supportingExcerpts: row.supportingExcerpts,
    documentationGaps: row.documentationGaps,
    confidence: row.confidence,
    status: row.status,
    createdByAi: row.createdByAi,
    statusNote: row.statusNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeApproved(row: ApprovedBillingCode) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    codeSystem: row.codeSystem,
    code: row.code,
    description: row.description,
    sourceSuggestionId: row.sourceSuggestionId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    billerApprovedAt: row.billerApprovedAt?.toISOString() ?? null,
    billerApprovedByUserId: row.billerApprovedByUserId,
    exportedAt: row.exportedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /encounters/:id/billing/suggest — run the AI suggester and store the
// emitted codes as billing_suggestions rows. Returns the freshly-inserted
// batch. Safe to call repeatedly; previous batches stay on file.
//
// The route layer feeds the suggester the approved-or-latest note body
// (never the raw transcript — see billing-suggester.ts for why).
// ---------------------------------------------------------------------------
router.post("/encounters/:id/billing/suggest", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const encounterId = req.params.id;
  const db = getDb();

  // Fetch encounter + verify tenancy.
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

  // Fetch patient demographics (only DOB is fed to the AI — minimum
  // necessary).
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
    // Shouldn't happen — encounter FK guarantees this — but guard so
    // the suggester always has demographics.
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  // Source body: prefer the most recent approved/exported note for this
  // encounter; fall back to the latest draft. No note → 409, can't bill
  // without documentation.
  const [note] = await db
    .select({ id: notesTable.id, body: notesTable.body, status: notesTable.status })
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
    res.status(409).json({ error: "no_note_to_bill" });
    return;
  }

  const { result, source } = await suggestBillingCodes({
    encounter: {
      id: encounter.id,
      visitType: encounter.visitType,
      customLabel: encounter.customLabel,
      isTelehealth: encounter.isTelehealth,
      scheduledAt: encounter.scheduledAt,
    },
    patient,
    noteBody: note.body,
  });

  if (result.codes.length === 0) {
    res.json({ data: [], source });
    return;
  }

  try {
    const inserted = await db
      .insert(billingSuggestionsTable)
      .values(
        result.codes.map((c) => ({
          organizationId: orgId,
          encounterId,
          codeSystem: c.codeSystem,
          code: c.code,
          description: c.description,
          rationale: c.rationale,
          supportingExcerpts: c.supportingExcerpts,
          documentationGaps: c.documentationGaps,
          confidence: c.confidence,
          createdByAi: true,
        })),
      )
      .returning();
    res.status(201).json({ data: inserted.map(serializeSuggestion), source });
  } catch (err) {
    req.log.error({ err, encounterId }, "Failed to persist billing suggestions");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /encounters/:id/billing — list all suggestions + approved codes for
// an encounter. Single round-trip so the billing tab can render both panels
// without sequencing two calls.
// ---------------------------------------------------------------------------
router.get("/encounters/:id/billing", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const encounterId = req.params.id;
  const db = getDb();

  // Existence + tenancy check up front so we 404 cleanly rather than
  // returning empty arrays for a nonexistent / cross-tenant encounter.
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
      .from(billingSuggestionsTable)
      .where(
        and(
          eq(billingSuggestionsTable.encounterId, encounterId),
          eq(billingSuggestionsTable.organizationId, orgId),
        ),
      )
      .orderBy(desc(billingSuggestionsTable.createdAt)),
    db
      .select()
      .from(approvedBillingCodesTable)
      .where(
        and(
          eq(approvedBillingCodesTable.encounterId, encounterId),
          eq(approvedBillingCodesTable.organizationId, orgId),
        ),
      )
      .orderBy(desc(approvedBillingCodesTable.createdAt)),
  ]);

  res.json({
    suggestions: suggestions.map(serializeSuggestion),
    approvedCodes: approved.map(serializeApproved),
  });
});

// ---------------------------------------------------------------------------
// POST /billing/suggestions/:id/approve — provider sign-off on a single
// suggestion. Creates an approved_billing_codes row (with the suggestion
// id as source), and transitions the suggestion's status to
// provider_approved. Rejects if a 'block' severity documentation gap is
// unaddressed.
// ---------------------------------------------------------------------------
router.post("/billing/suggestions/:id/approve", async (req, res) => {
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
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.id, suggestionId),
        eq(billingSuggestionsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!suggestion) {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }

  // Block-severity gaps prevent approval until the underlying issue is
  // documented and the suggestion is regenerated. Provider can override
  // by sending acknowledgeBlockingGaps=true (logged in status_note for
  // audit).
  type Gap = { field: string; message: string; severity: "info" | "warn" | "block" };
  const gaps = Array.isArray(suggestion.documentationGaps)
    ? (suggestion.documentationGaps as Gap[])
    : [];
  const blockers = gaps.filter((g) => g.severity === "block");
  const ackBlock =
    typeof req.body === "object" &&
    req.body !== null &&
    (req.body as { acknowledgeBlockingGaps?: unknown })
      .acknowledgeBlockingGaps === true;
  if (blockers.length > 0 && !ackBlock) {
    res.status(409).json({
      error: "documentation_blockers",
      gaps: blockers,
      message:
        "This suggestion has documentation gaps marked 'block'. Address " +
        "them in the note or send { acknowledgeBlockingGaps: true } to override.",
    });
    return;
  }

  if (suggestion.status === "provider_approved" || suggestion.status === "biller_approved") {
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
    // Transaction: the approved code + the status flip on the
    // suggestion must land together. A crash between would leave a
    // suggestion in "approved" state with no approved_billing_codes row.
    const approved = await db.transaction(async (tx) => {
      const [approvedRow] = await tx
        .insert(approvedBillingCodesTable)
        .values({
          organizationId: orgId,
          encounterId: suggestion.encounterId,
          codeSystem: suggestion.codeSystem,
          code: suggestion.code,
          description: suggestion.description,
          sourceSuggestionId: suggestion.id,
          approvedAt: new Date(),
          approvedByUserId: approver.id,
        })
        .returning();
      if (!approvedRow) throw new Error("Approved code insert returned no row");

      await tx
        .update(billingSuggestionsTable)
        .set({
          status: "provider_approved",
          statusNote: ackBlock
            ? "Provider acknowledged blocking documentation gaps at approval."
            : null,
          updatedAt: new Date(),
        })
        .where(eq(billingSuggestionsTable.id, suggestion.id));

      return approvedRow;
    });

    res.status(201).json(serializeApproved(approved));
  } catch (err) {
    req.log.error(
      { err, suggestionId },
      "Failed to approve billing suggestion",
    );
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /billing/suggestions/:id/reject — provider explicitly declines a
// suggestion. Captures the reason so audit can answer "why wasn't this
// coded" without inferring from absence.
// ---------------------------------------------------------------------------
const RejectBody = z.object({
  reason: z.string().min(1).max(500),
});

router.post("/billing/suggestions/:id/reject", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = RejectBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const suggestionId = req.params.id;
  const db = getDb();

  const [suggestion] = await db
    .select({
      id: billingSuggestionsTable.id,
      status: billingSuggestionsTable.status,
    })
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.id, suggestionId),
        eq(billingSuggestionsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!suggestion) {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (
    suggestion.status === "provider_approved" ||
    suggestion.status === "biller_approved" ||
    suggestion.status === "exported"
  ) {
    res
      .status(409)
      .json({ error: "cannot_reject_approved", status: suggestion.status });
    return;
  }

  const [updated] = await db
    .update(billingSuggestionsTable)
    .set({
      status: "rejected",
      statusNote: parsed.data.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(billingSuggestionsTable.id, suggestionId),
        eq(billingSuggestionsTable.organizationId, orgId),
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
// POST /billing/codes/:id/biller-approve — second sign-off by a billing
// specialist. Required before export to the practice management system.
// ---------------------------------------------------------------------------
router.post("/billing/codes/:id/biller-approve", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const biller = req.user;
  if (!biller) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const codeId = req.params.id;
  const db = getDb();

  const [code] = await db
    .select()
    .from(approvedBillingCodesTable)
    .where(
      and(
        eq(approvedBillingCodesTable.id, codeId),
        eq(approvedBillingCodesTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!code) {
    res.status(404).json({ error: "code_not_found" });
    return;
  }
  if (code.exportedAt) {
    res.status(409).json({ error: "already_exported" });
    return;
  }
  if (code.billerApprovedAt) {
    // Idempotent on the same biller; return current state.
    res.json(serializeApproved(code));
    return;
  }

  const [updated] = await db
    .update(approvedBillingCodesTable)
    .set({
      billerApprovedAt: new Date(),
      billerApprovedByUserId: biller.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvedBillingCodesTable.id, codeId),
        eq(approvedBillingCodesTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "code_not_found" });
    return;
  }
  // Mirror the biller-approval onto the source suggestion (if any) so
  // queue queries on billing_suggestions reflect the latest state.
  if (updated.sourceSuggestionId) {
    await db
      .update(billingSuggestionsTable)
      .set({ status: "biller_approved", updatedAt: new Date() })
      .where(
        and(
          eq(billingSuggestionsTable.id, updated.sourceSuggestionId),
          eq(billingSuggestionsTable.organizationId, orgId),
        ),
      );
  }
  res.json(serializeApproved(updated));
});

export default router;
