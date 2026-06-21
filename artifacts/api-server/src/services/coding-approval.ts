// Approval lifecycle of the Coder workflow:
//
//   editSuggestion              — per-row override of code/description
//                                 before approval. Audit-logged.
//   approveAllHighConfidence    — "Approve and Write" bulk action.
//                                 Idempotent + retry-aware (re-runs
//                                 just re-push failed rows). Hits
//                                 Athena via the chart-API push with
//                                 a concurrency cap to stay under
//                                 the per-second rate budget.
//
// The bulk-approve also auto-advances the encounter to 'completed'
// when the writeback is clean.

import { and, eq, inArray } from "drizzle-orm";
import {
  approvedBillingCodesTable,
  approvedOrdersTable,
  billingSuggestionsTable,
  encounterCodingSessionsTable,
  encountersTable,
  getDb,
  type ApprovedOrder,
  type BillingSuggestion,
  type EncounterCodingSession,
  type SuggestionConfidence,
} from "@workspace/db";
import { recordCoderAuditEvent } from "../lib/audit-events";
import { mapWithLimit } from "../lib/concurrency";
import { pushBillingCodeToEhr } from "../lib/ehr-push-billing";
import { pushOrderToEhr } from "../lib/ehr-push-order";
import { findPatient } from "../lib/patients";
import {
  CONFIDENCE_RANK,
  loadSessionSuggestions,
  PUSH_CONCURRENCY,
  suggestionHasBlocker,
} from "./coding-internals";

export type EditSuggestionResult =
  | { kind: "ok"; suggestion: BillingSuggestion }
  | { kind: "not_found" }
  | { kind: "not_editable" };

export interface EditSuggestionArgs {
  suggestionId: string;
  orgId: string;
  reviewerId: string;
  editedCode: string;
  editedDescription: string;
  // Optional free-text reason — surfaced in audit log + biller view.
  reason?: string | null;
}

export type ApproveAllResult =
  | {
      kind: "ok";
      session: EncounterCodingSession;
      approvedCount: number;
      skippedCount: number;
      // Auto-push outcome. Failures don't fail the whole request —
      // each push is best-effort, per-row ehrError is persisted for
      // retry from the BillingPanel UI (or via a re-run of bulk
      // approve, which is now idempotent).
      pushedBillingCount: number;
      pushedOrderCount: number;
      pushFailedCount: number;
    }
  | { kind: "not_found" }
  | { kind: "wrong_state" };

export interface ApproveAllArgs {
  sessionId: string;
  orgId: string;
  approverId: string;
  // Confidence floor for bulk approval. Default 'high' — only auto-
  // approve high-confidence; everything else goes to individual review.
  minConfidence?: SuggestionConfidence;
}

export async function editSuggestion(
  args: EditSuggestionArgs,
): Promise<EditSuggestionResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.id, args.suggestionId),
        eq(billingSuggestionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (row.status !== "ai_suggested" && row.status !== "needs_review") {
    return { kind: "not_editable" };
  }

  const [updated] = await db
    .update(billingSuggestionsTable)
    .set({
      editedCode: args.editedCode,
      editedDescription: args.editedDescription,
      statusNote: args.reason ?? row.statusNote,
      updatedAt: new Date(),
    })
    .where(eq(billingSuggestionsTable.id, args.suggestionId))
    .returning();
  if (!updated) return { kind: "not_found" };

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.reviewerId,
    action: "coder.suggestion.edited",
    resourceType: "billing_suggestion",
    resourceId: args.suggestionId,
    metadata: {
      codeSystem: row.codeSystem,
      originalCode: row.code,
      editedCode: args.editedCode,
      hadPriorEdit: row.editedCode != null,
    },
  });
  return { kind: "ok", suggestion: updated };
}

export async function approveAllHighConfidence(
  args: ApproveAllArgs,
): Promise<ApproveAllResult> {
  const db = getDb();
  const floor = CONFIDENCE_RANK[args.minConfidence ?? "high"];

  const [session] = await db
    .select()
    .from(encounterCodingSessionsTable)
    .where(
      and(
        eq(encounterCodingSessionsTable.id, args.sessionId),
        eq(encounterCodingSessionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!session) return { kind: "not_found" };
  // Session-level idempotency: a previous bulk-approve might already
  // be in flight or done. Accept these states so a refresh / double-
  // click doesn't error out — eligibility filter below skips already-
  // promoted rows so no duplicate inserts.
  if (
    session.status !== "ready" &&
    session.status !== "approved" &&
    session.status !== "writing" &&
    session.status !== "complete" &&
    session.status !== "failed"
  ) {
    return { kind: "wrong_state" };
  }

  const suggestions = await loadSessionSuggestions(session.id, args.orgId);
  // Only ai_suggested / needs_review rows are eligible for fresh promotion.
  // Already-approved rows are skipped by this filter, so a double-click
  // never duplicates approved_billing_codes. A partial-failure session
  // can still be retried — the retryablePushFailures path below picks
  // up codes whose push failed without re-inserting.
  const eligible = suggestions.filter(
    (s) =>
      (s.status === "ai_suggested" || s.status === "needs_review") &&
      CONFIDENCE_RANK[s.confidence] >= floor &&
      !suggestionHasBlocker(s),
  );

  const retryCodes = await db
    .select()
    .from(approvedBillingCodesTable)
    .where(
      and(
        eq(approvedBillingCodesTable.encounterId, session.encounterId),
        eq(approvedBillingCodesTable.organizationId, args.orgId),
      ),
    );
  const retryablePushFailures = retryCodes.filter(
    (c) => c.ehrError != null && c.exportedAt == null,
  );

  if (eligible.length === 0 && retryablePushFailures.length === 0) {
    return {
      kind: "ok",
      session,
      approvedCount: 0,
      skippedCount: suggestions.length,
      pushedBillingCount: 0,
      pushedOrderCount: 0,
      pushFailedCount: 0,
    };
  }

  const now = new Date();

  const insertedCodes =
    eligible.length > 0
      ? await db
          .insert(approvedBillingCodesTable)
          .values(
            eligible.map((s) => {
              const finalCode = s.editedCode ?? s.code;
              const finalDescription = s.editedDescription ?? s.description;
              const wasEdited =
                s.editedCode != null && s.editedCode !== s.code;
              return {
                organizationId: args.orgId,
                encounterId: s.encounterId,
                codeSystem: s.codeSystem,
                code: finalCode,
                description: finalDescription,
                sourceSuggestionId: s.id,
                approvedAt: now,
                approvedByUserId: args.approverId,
                wasEditedBeforeApproval: wasEdited,
              };
            }),
          )
          .returning()
      : [];

  if (eligible.length > 0) {
    await db
      .update(billingSuggestionsTable)
      .set({ status: "provider_approved", updatedAt: now })
      .where(
        inArray(
          billingSuggestionsTable.id,
          eligible.map((s) => s.id),
        ),
      );
  }

  const skippedCount = suggestions.length - eligible.length;
  // Union: freshly-inserted rows + retryable failed pushes from prior runs.
  const codesToPush = [...insertedCodes, ...retryablePushFailures];

  // ----- Auto-push to EHR ---------------------------------------------------
  await db
    .update(encounterCodingSessionsTable)
    .set({
      status: "writing",
      writebackStartedAt: now,
      updatedAt: now,
    })
    .where(eq(encounterCodingSessionsTable.id, session.id));

  const [encounter] = await db
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, session.encounterId),
        eq(encountersTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  const patient = encounter
    ? await findPatient(encounter.patientId, args.orgId)
    : null;
  // Mock mode ignores encounterEhrRef. Real Athena mode requires it:
  // missing → the per-code push throws a clear "not linked" error
  // which the ehrError + toast UI surfaces.
  const encounterEhrRef: string | null = encounter?.ehrEncounterRef ?? null;

  let pushedBillingCount = 0;
  let pushedOrderCount = 0;
  let pushFailedCount = 0;

  // Concurrency-capped billing pushes so a large session doesn't burn
  // Athena's per-second rate budget for the whole org.
  const billingPushes = await mapWithLimit(
    codesToPush,
    PUSH_CONCURRENCY,
    (row) =>
      pushBillingCodeToEhr({
        billingCode: {
          id: row.id,
          codeSystem: row.codeSystem,
          code: row.code,
          description: row.description,
        },
        encounterEhrRef,
        userId: args.approverId,
      }),
  );
  for (let i = 0; i < codesToPush.length; i++) {
    const row = codesToPush[i]!;
    const result = billingPushes[i]!;
    if (result.status === "fulfilled") {
      await db
        .update(approvedBillingCodesTable)
        .set({
          exportedAt: result.value!.pushedAt,
          ehrDocumentRef: result.value!.ehrDocumentRef,
          ehrError: null,
          updatedAt: new Date(),
        })
        .where(eq(approvedBillingCodesTable.id, row.id));
      if (row.sourceSuggestionId) {
        await db
          .update(billingSuggestionsTable)
          .set({ status: "exported", updatedAt: new Date() })
          .where(eq(billingSuggestionsTable.id, row.sourceSuggestionId));
      }
      pushedBillingCount += 1;
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      // PHI-scrubbed by athena-chart-api before it gets here.
      await db
        .update(approvedBillingCodesTable)
        .set({ ehrError: msg, updatedAt: new Date() })
        .where(eq(approvedBillingCodesTable.id, row.id));
      pushFailedCount += 1;
    }
  }

  // Orders ready to ship: approved/export_ready, complete, not exported.
  const pendingOrders: ApprovedOrder[] = patient
    ? await db
        .select()
        .from(approvedOrdersTable)
        .where(
          and(
            eq(approvedOrdersTable.encounterId, session.encounterId),
            eq(approvedOrdersTable.organizationId, args.orgId),
            eq(approvedOrdersTable.isComplete, true),
            inArray(approvedOrdersTable.status, ["approved", "export_ready"]),
          ),
        )
    : [];

  if (patient && pendingOrders.length > 0) {
    const orderPushes = await mapWithLimit(
      pendingOrders,
      PUSH_CONCURRENCY,
      (o) =>
        pushOrderToEhr({
          order: {
            id: o.id,
            orderType: o.orderType,
            name: o.name,
            indication: o.indication,
            indicationDiagnosisCode: o.indicationDiagnosisCode,
            priority: o.priority,
            instructions: o.instructions,
            frequency: o.frequency,
            duration: o.duration,
            medicationName: o.medicationName,
            medicationDose: o.medicationDose,
            medicationRoute: o.medicationRoute,
            medicationFrequency: o.medicationFrequency,
            medicationDuration: o.medicationDuration,
            medicationQuantity: o.medicationQuantity,
            medicationRefills: o.medicationRefills,
          },
          patient,
          encounterEhrRef,
          userId: args.approverId,
        }),
    );
    for (let i = 0; i < pendingOrders.length; i++) {
      const row = pendingOrders[i]!;
      const result = orderPushes[i]!;
      if (result.status === "fulfilled") {
        await db
          .update(approvedOrdersTable)
          .set({
            status: "exported",
            exportedAt: result.value!.pushedAt,
            ehrDocumentRef: result.value!.ehrDocumentRef,
            ehrError: null,
            updatedAt: new Date(),
          })
          .where(eq(approvedOrdersTable.id, row.id));
        pushedOrderCount += 1;
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        await db
          .update(approvedOrdersTable)
          .set({ ehrError: msg, updatedAt: new Date() })
          .where(eq(approvedOrdersTable.id, row.id));
        pushFailedCount += 1;
      }
    }
  }

  const finalStatus = pushFailedCount === 0 ? "complete" : "failed";
  const finishedAt = new Date();
  const [updatedSession] = await db
    .update(encounterCodingSessionsTable)
    .set({
      status: finalStatus,
      approvedAt: now,
      approvedByUserId: args.approverId,
      writebackCompletedAt: finishedAt,
      failureReason:
        pushFailedCount > 0
          ? `${pushFailedCount} EHR push${pushFailedCount === 1 ? "" : "es"} failed; rows kept locally for retry`
          : null,
      updatedAt: finishedAt,
    })
    .where(eq(encounterCodingSessionsTable.id, session.id))
    .returning();

  // Auto-advance encounter on clean writeback. Partial-failure leaves
  // encounter flagged for attention until rows are retried.
  if (finalStatus === "complete") {
    await db
      .update(encountersTable)
      .set({
        status: "completed",
        completedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(
        and(
          eq(encountersTable.id, session.encounterId),
          eq(encountersTable.organizationId, args.orgId),
          inArray(encountersTable.status, ["scheduled", "in_progress"]),
        ),
      );
  }

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.approverId,
    action:
      pushFailedCount === 0
        ? "coder.session.writeback.completed"
        : "coder.session.writeback.partial_failure",
    resourceType: "coding_session",
    resourceId: session.id,
    metadata: {
      encounterId: session.encounterId,
      approvedCount: eligible.length,
      skippedCount,
      pushedBillingCount,
      pushedOrderCount,
      pushFailedCount,
      retryablePushFailureCount: retryablePushFailures.length,
      finalStatus,
      ehrEncounterRefPresent: encounterEhrRef != null,
    },
  });

  return {
    kind: "ok",
    session: updatedSession ?? session,
    approvedCount: eligible.length,
    skippedCount,
    pushedBillingCount,
    pushedOrderCount,
    pushFailedCount,
  };
}
