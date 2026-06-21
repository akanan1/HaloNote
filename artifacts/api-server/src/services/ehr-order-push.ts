// pushApprovedOrder — high-level orchestrator for single-order EHR push.
//
// Layered above the EhrOrderAdapter (lib/ehr-order-adapter.ts) and
// pushOrderToEhr (lib/ehr-push-order.ts). Responsibilities the adapter
// layer deliberately does NOT have:
//
//   1. Gate: order MUST be in an approve-or-later status.
//   2. Gate: encounter's most-recent note MUST be finalized
//      (status='approved' or 'exported'). A draft note is never pushed
//      automatically — that's the patient-safety contract called out
//      in the requirements.
//   3. Idempotency: persist an Idempotency-Key on first attempt,
//      reuse on retries; short-circuit duplicate pushes after success.
//   4. Persistence: stamp status/exportedAt/ehrDocumentRef on success;
//      stamp ehrError on failure, leaving status alone so retry works.
//   5. Audit: emit the right coder.order.push.* event for every
//      outcome. The bulk-push path has its own coarser audit at the
//      session level; this service is for per-order pushes.
//
// The bulk-push flow inside coding-approval.ts still calls
// pushOrderToEhr directly — its own pre-checks (isComplete=true, status
// in ["approved","export_ready"], post-note-approval entry point) cover
// the same ground at session granularity. Routes touching individual
// orders should route through here.

import { and, desc, eq } from "drizzle-orm";
import {
  approvedOrdersTable,
  encountersTable,
  getDb,
  notesTable,
  type ApprovedOrder,
} from "@workspace/db";
import {
  generateOrderIdempotencyKey,
  pushOrderToEhr,
  type PushableOrder,
} from "../lib/ehr-push-order";
import type { EhrOrderPushOutcome } from "../lib/ehr-order-adapter";
import { EhrPushError } from "../lib/ehr-push";
import { findPatient } from "../lib/patients";
import { recordCoderAuditEvent, scrubEhrErrorMessage } from "../lib/audit-events";

export interface PushApprovedOrderRequest {
  orderId: string;
  orgId: string;
  initiatingUserId: string;
  /** When true, route through the dry-run adapter — payload preview is
   *  returned, no upstream call, no DB status flip. */
  dryRun?: boolean;
}

export type PushApprovedOrderResult =
  | { kind: "ok"; order: ApprovedOrder; outcome: EhrOrderPushOutcome }
  | { kind: "dry_run"; order: ApprovedOrder; outcome: EhrOrderPushOutcome }
  | {
      kind: "already_pushed";
      order: ApprovedOrder;
      previousRef: string;
    }
  | { kind: "order_not_found" }
  | { kind: "order_not_approved"; status: string }
  | { kind: "note_not_finalized"; noteStatus: string | null }
  | { kind: "encounter_not_linked" }
  | { kind: "patient_not_found" }
  | {
      kind: "failed";
      order: ApprovedOrder;
      error: string;
      retryable: boolean;
      status: number;
    };

// Statuses where an approved order is eligible to push. "approved" and
// "export_ready" are the normal entry points; "exported" is handled
// separately (idempotent short-circuit returns the previous ref).
const PUSHABLE_STATUSES = new Set<string>(["approved", "export_ready"]);

// A note is "finalized" once the provider has signed it. The exact
// semantics live in lib/db/src/schema/notes.ts NoteStatus — both
// "approved" (just signed) and "exported" (already pushed to EHR)
// count. Draft/active/entered-in-error do not.
const FINALIZED_NOTE_STATUSES = new Set<string>(["approved", "exported"]);

function toPushable(order: ApprovedOrder): PushableOrder {
  return {
    id: order.id,
    orderType: order.orderType,
    name: order.name,
    indication: order.indication,
    indicationDiagnosisCode: order.indicationDiagnosisCode,
    priority: order.priority,
    instructions: order.instructions,
    frequency: order.frequency,
    duration: order.duration,
    medicationName: order.medicationName,
    medicationDose: order.medicationDose,
    medicationRoute: order.medicationRoute,
    medicationFrequency: order.medicationFrequency,
    medicationDuration: order.medicationDuration,
    medicationQuantity: order.medicationQuantity,
    medicationRefills: order.medicationRefills,
  };
}

// HTTP status → retryable. 429/502/503/504 are transient (network or
// upstream load); 400/422 and 501 are caller-fixable and not worth
// auto-retry. Anything else: lean retryable since transient is the
// safer default for a clinician-initiated action.
function isRetryableStatus(status: number): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status === 400 || status === 422 || status === 501 || status === 409) {
    return false;
  }
  return true;
}

export async function pushApprovedOrder(
  req: PushApprovedOrderRequest,
): Promise<PushApprovedOrderResult> {
  const db = getDb();
  const dryRun = req.dryRun === true;

  // 1. Load the order. Tenant-scoped read.
  const [order] = await db
    .select()
    .from(approvedOrdersTable)
    .where(
      and(
        eq(approvedOrdersTable.id, req.orderId),
        eq(approvedOrdersTable.organizationId, req.orgId),
      ),
    )
    .limit(1);
  if (!order) return { kind: "order_not_found" };

  // 2. Idempotent short-circuit: already exported with a ref. NO
  //    upstream call. Tests can verify by counting adapter dispatches.
  if (
    order.status === "exported" &&
    order.ehrDocumentRef &&
    !dryRun
  ) {
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.order.push.skipped_duplicate",
      resourceType: "approved_order",
      resourceId: order.id,
      metadata: {
        encounterId: order.encounterId,
        existingRef: order.ehrDocumentRef,
      },
    });
    return {
      kind: "already_pushed",
      order,
      previousRef: order.ehrDocumentRef,
    };
  }

  // 3. Approval gate. Cancelled orders and anything not in a pushable
  //    status are rejected. "exported" is acceptable for dry-run
  //    (clinician wants to preview what was sent), but never re-pushed
  //    for real — that's caught by the idempotent short-circuit above.
  if (
    !PUSHABLE_STATUSES.has(order.status) &&
    !(dryRun && order.status === "exported")
  ) {
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.order.push.skipped_unapproved",
      resourceType: "approved_order",
      resourceId: order.id,
      metadata: {
        encounterId: order.encounterId,
        currentStatus: order.status,
      },
    });
    return { kind: "order_not_approved", status: order.status };
  }

  // 4. Note-finalized gate. Look up the most-recent note for the
  //    encounter; require it to be signed off. Single-query so a
  //    draft note with a hovering AI-generated order can't sneak a
  //    push out behind the provider's back.
  const [latestNote] = await db
    .select({ status: notesTable.status })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.encounterId, order.encounterId),
        eq(notesTable.organizationId, req.orgId),
      ),
    )
    .orderBy(desc(notesTable.updatedAt))
    .limit(1);
  const noteStatus = latestNote?.status ?? null;
  if (!noteStatus || !FINALIZED_NOTE_STATUSES.has(noteStatus)) {
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.order.push.skipped_unfinalized",
      resourceType: "approved_order",
      resourceId: order.id,
      metadata: {
        encounterId: order.encounterId,
        noteStatus,
      },
    });
    return { kind: "note_not_finalized", noteStatus };
  }

  // 5. Encounter + patient lookup. Encounter ehrEncounterRef is
  //    required for real-mode adapters; mock + dry-run skip the gate
  //    inside pushOrderToEhr. We still fetch it so the adapter has
  //    full context.
  const [enc] = await db
    .select({
      patientId: encountersTable.patientId,
      ehrEncounterRef: encountersTable.ehrEncounterRef,
    })
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, order.encounterId),
        eq(encountersTable.organizationId, req.orgId),
      ),
    )
    .limit(1);
  if (!enc) {
    // Shouldn't happen given the FK, but defensive.
    return { kind: "encounter_not_linked" };
  }
  const patient = await findPatient(enc.patientId, req.orgId);
  if (!patient) return { kind: "patient_not_found" };

  // 6. Idempotency key. Reuse the existing one on the row; if absent
  //    (first push attempt), mint and persist BEFORE the dispatch so
  //    a crash mid-push doesn't leave us without a recoverable key.
  //    Dry-runs intentionally DO NOT persist a key — the dry-run might
  //    be inspected, then a real run kicks off with a fresh key.
  let idempotencyKey = order.ehrIdempotencyKey ?? null;
  if (!idempotencyKey && !dryRun) {
    idempotencyKey = generateOrderIdempotencyKey();
    await db
      .update(approvedOrdersTable)
      .set({ ehrIdempotencyKey: idempotencyKey, updatedAt: new Date() })
      .where(eq(approvedOrdersTable.id, order.id));
  }

  // 7. Dispatch.
  try {
    const outcome = await pushOrderToEhr({
      order: toPushable(order),
      patient,
      encounterEhrRef: enc.ehrEncounterRef,
      userId: req.initiatingUserId,
      dryRun,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    if (outcome.dryRun) {
      // No DB mutation — dry-run is read-only. Audit event captures
      // who looked at what.
      recordCoderAuditEvent({
        organizationId: req.orgId,
        userId: req.initiatingUserId,
        action: "coder.order.push.dry_run",
        resourceType: "approved_order",
        resourceId: order.id,
        metadata: {
          encounterId: order.encounterId,
          orderType: order.orderType,
          provider: outcome.provider,
        },
      });
      return { kind: "dry_run", order, outcome };
    }

    // Real (or mock) success: stamp the row.
    const [updated] = await db
      .update(approvedOrdersTable)
      .set({
        status: "exported",
        exportedAt: outcome.pushedAt,
        ehrDocumentRef: outcome.ehrDocumentRef,
        ehrError: null,
        updatedAt: new Date(),
      })
      .where(eq(approvedOrdersTable.id, order.id))
      .returning();
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.order.push.succeeded",
      resourceType: "approved_order",
      resourceId: order.id,
      metadata: {
        encounterId: order.encounterId,
        orderType: order.orderType,
        provider: outcome.provider,
        ehrDocumentRef: outcome.ehrDocumentRef,
        mock: outcome.mock,
      },
    });
    return { kind: "ok", order: updated ?? order, outcome };
  } catch (err) {
    const status = err instanceof EhrPushError ? err.status : 500;
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Scrub before persistence — upstream error text occasionally
    // echoes PHI ("Patient JOHN SMITH not found").
    const scrubbed = scrubEhrErrorMessage(rawMessage);
    await db
      .update(approvedOrdersTable)
      .set({ ehrError: scrubbed, updatedAt: new Date() })
      .where(eq(approvedOrdersTable.id, order.id))
      .catch(() => {
        // Persistence failure on the error path is non-fatal — the
        // outer caller still gets a "failed" result and can decide.
      });
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.order.push.failed",
      resourceType: "approved_order",
      resourceId: order.id,
      metadata: {
        encounterId: order.encounterId,
        orderType: order.orderType,
        status,
        error: scrubbed,
      },
    });
    return {
      kind: "failed",
      order,
      error: scrubbed,
      retryable: isRetryableStatus(status),
      status,
    };
  }
}
