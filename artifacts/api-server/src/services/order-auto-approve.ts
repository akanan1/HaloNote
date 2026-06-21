// autoApproveAndPushNonMedOrders — the post-AI hook for the mobile
// "record + walk away" flow.
//
// When the order-suggester finishes for an encounter, this service:
//   1. Loads every ai_suggested order for the encounter,
//   2. Filters out medications (those stay queued for desktop review —
//      hard patient-safety floor),
//   3. Mirrors each non-med into approved_orders (status="export_ready"
//      since we're going straight to push),
//   4. Marks the source suggestion approved,
//   5. Invokes pushApprovedOrder for each, so all of the per-order
//      gates (note-finalized, idempotency, audit, ehrError persistence)
//      fire identically to a manual click.
//
// Callers should only invoke this when the authoring user has
// autoApproveNonMedOrders=true. Gating that decision on the caller
// keeps this service mechanically simple — it does what it's asked,
// no flag-reading.
//
// Returns counts the mobile UI can surface: "3 orders pushed, 1
// medication pending desktop review". Failures don't abort the batch;
// each order succeeds or fails independently and is reported back.

import { and, eq, inArray } from "drizzle-orm";
import {
  approvedOrdersTable,
  getDb,
  orderSuggestionsTable,
  type OrderType,
} from "@workspace/db";
import { pushApprovedOrder } from "./ehr-order-push";

export interface AutoApproveResult {
  /** Non-med suggestions found in ai_suggested state for this encounter. */
  eligibleCount: number;
  /** Approved + pushed cleanly to the EHR. */
  pushedCount: number;
  /** Approved locally but push errored (ehrError persisted). */
  failedCount: number;
  /** Medication suggestions held back for desktop review. */
  medicationsHeldCount: number;
}

const NON_MEDICATION_TYPES: ReadonlyArray<OrderType> = [
  "lab",
  "imaging",
  "referral",
  "procedure",
  "followup",
  "instruction",
  "dme",
  "therapy",
  "nursing",
];

export async function autoApproveAndPushNonMedOrders(args: {
  encounterId: string;
  orgId: string;
  initiatingUserId: string;
}): Promise<AutoApproveResult> {
  const db = getDb();

  // Load every ai_suggested order for this encounter, tenant-scoped.
  // Sources from order_suggestions, NOT approved_orders — we're
  // promoting these into approved.
  const suggestions = await db
    .select()
    .from(orderSuggestionsTable)
    .where(
      and(
        eq(orderSuggestionsTable.encounterId, args.encounterId),
        eq(orderSuggestionsTable.organizationId, args.orgId),
        eq(orderSuggestionsTable.status, "ai_suggested"),
      ),
    );

  const medications = suggestions.filter((s) => s.orderType === "medication");
  const nonMeds = suggestions.filter((s) =>
    (NON_MEDICATION_TYPES as readonly string[]).includes(s.orderType),
  );

  if (nonMeds.length === 0) {
    return {
      eligibleCount: 0,
      pushedCount: 0,
      failedCount: 0,
      medicationsHeldCount: medications.length,
    };
  }

  const now = new Date();

  // Bulk-insert all approved rows. status="export_ready" because we
  // intend to push immediately — pushApprovedOrder accepts both
  // "approved" and "export_ready" so this matches the eligibility
  // window without an intermediate state-flip.
  const approvedRows = await db
    .insert(approvedOrdersTable)
    .values(
      nonMeds.map((s) => ({
        organizationId: args.orgId,
        encounterId: s.encounterId,
        sourceSuggestionId: s.id,
        orderType: s.orderType,
        name: s.name,
        indication: s.indication,
        indicationDiagnosisCode: s.indicationDiagnosisCode,
        priority: s.priority,
        instructions: s.instructions,
        frequency: s.frequency,
        duration: s.duration,
        medicationName: s.medicationName,
        medicationDose: s.medicationDose,
        medicationRoute: s.medicationRoute,
        medicationFrequency: s.medicationFrequency,
        medicationDuration: s.medicationDuration,
        medicationQuantity: s.medicationQuantity,
        medicationRefills: s.medicationRefills,
        isComplete: s.isComplete,
        safetyWarnings: s.safetyWarnings,
        status: "export_ready" as const,
        approvedAt: now,
        approvedByUserId: args.initiatingUserId,
        exportReadyAt: now,
      })),
    )
    .returning();

  // Mark the source suggestions approved in one shot. Same audit
  // semantics as the per-suggestion approve route — the suggestion
  // is no longer the floor for further action.
  await db
    .update(orderSuggestionsTable)
    .set({ status: "approved", updatedAt: now })
    .where(
      and(
        inArray(
          orderSuggestionsTable.id,
          nonMeds.map((s) => s.id),
        ),
        eq(orderSuggestionsTable.organizationId, args.orgId),
      ),
    );

  // Push each approved row through the existing service so it gets the
  // same gates + audit + idempotency-key handling as a manual click.
  // Sequential to keep things simple — non-med order counts per
  // encounter are small (typically 1-5). Add concurrency later if
  // real-world batches grow.
  let pushedCount = 0;
  let failedCount = 0;
  for (const row of approvedRows) {
    const result = await pushApprovedOrder({
      orderId: row.id,
      orgId: args.orgId,
      initiatingUserId: args.initiatingUserId,
    });
    if (result.kind === "ok" || result.kind === "already_pushed") {
      pushedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    eligibleCount: nonMeds.length,
    pushedCount,
    failedCount,
    medicationsHeldCount: medications.length,
  };
}
