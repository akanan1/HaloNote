// retryBillingCodePush — per-card retry for stranded billing codes.
//
// The bulk-approve flow (coding-approval.ts) pushes every freshly
// provider-approved code; failures persist `ehrError` on the row and
// leave `exportedAt` null. The bulk path can be re-run to retry the
// whole batch, but a clinician fixing one specific row (encounter link,
// edited code, etc.) needs a per-row recovery affordance that doesn't
// require re-approving the entire session.
//
// The existing POST /billing/codes/:id/send-to-ehr route is the
// biller-driven happy-path manual export — it gates on
// `billerApprovedAt != null`. Bulk-approve-pushed codes don't have
// biller approval set (provider approval is sufficient for the bulk
// path), so they can't use that route to recover. This service is the
// retry-from-bulk-failure path.
//
// Mirrors the gates + audit shape of pushApprovedOrder:
//   - Code must be "stranded": ehrError set, exportedAt null
//   - Encounter's most-recent note must be finalized (patient safety)
//   - Idempotency handled at the pushBillingCodeToEhr layer via the
//     deterministic `bc_<id>` key (Athena dedupes within retention)
//   - Per-attempt audit event with the right resource type

import { and, desc, eq } from "drizzle-orm";
import {
  approvedBillingCodesTable,
  billingSuggestionsTable,
  encountersTable,
  getDb,
  notesTable,
  type ApprovedBillingCode,
} from "@workspace/db";
import { pushBillingCodeToEhr } from "../lib/ehr-push-billing";
import { EhrPushError } from "../lib/ehr-push";
import {
  recordCoderAuditEvent,
  scrubEhrErrorMessage,
} from "../lib/audit-events";

export interface RetryBillingCodePushRequest {
  codeId: string;
  orgId: string;
  initiatingUserId: string;
}

export type RetryBillingCodePushResult =
  | {
      kind: "ok";
      code: ApprovedBillingCode;
      ehrDocumentRef: string;
      provider: string;
      mock: boolean;
      pushedAt: Date;
    }
  | { kind: "code_not_found" }
  | { kind: "code_not_stranded"; exportedAt: Date | null; ehrError: string | null }
  | { kind: "note_not_finalized"; noteStatus: string | null }
  | { kind: "encounter_not_found" }
  | {
      kind: "failed";
      code: ApprovedBillingCode;
      error: string;
      retryable: boolean;
      status: number;
    };

// A note is "finalized" once the provider has signed it. Matches the
// same set used by the per-order push service for consistency.
const FINALIZED_NOTE_STATUSES = new Set<string>(["approved", "exported"]);

function isRetryableStatus(status: number): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status === 400 || status === 422 || status === 501 || status === 409) {
    return false;
  }
  return true;
}

export async function retryBillingCodePush(
  req: RetryBillingCodePushRequest,
): Promise<RetryBillingCodePushResult> {
  const db = getDb();

  // 1. Load the code (tenant-scoped).
  const [code] = await db
    .select()
    .from(approvedBillingCodesTable)
    .where(
      and(
        eq(approvedBillingCodesTable.id, req.codeId),
        eq(approvedBillingCodesTable.organizationId, req.orgId),
      ),
    )
    .limit(1);
  if (!code) return { kind: "code_not_found" };

  // 2. Stranded check. A code is eligible for this endpoint only if a
  //    previous push attempt failed — distinguishes from the "never
  //    tried" case (which goes through the biller-approval flow) and
  //    the "already exported" case (which is a no-op for retry, idempotency
  //    is already established).
  const isStranded =
    code.ehrError != null && code.exportedAt == null;
  if (!isStranded) {
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.billing_code.push.skipped_not_stranded",
      resourceType: "approved_billing_code",
      resourceId: code.id,
      metadata: {
        encounterId: code.encounterId,
        exported: code.exportedAt != null,
        hadError: code.ehrError != null,
      },
    });
    return {
      kind: "code_not_stranded",
      exportedAt: code.exportedAt,
      ehrError: code.ehrError,
    };
  }

  // 3. Note-finalized gate. Same contract as the per-order push: never
  //    push from a draft note.
  const [latestNote] = await db
    .select({ status: notesTable.status })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.encounterId, code.encounterId),
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
      action: "coder.billing_code.push.skipped_unfinalized",
      resourceType: "approved_billing_code",
      resourceId: code.id,
      metadata: {
        encounterId: code.encounterId,
        noteStatus,
      },
    });
    return { kind: "note_not_finalized", noteStatus };
  }

  // 4. Encounter lookup for ehrEncounterRef.
  const [enc] = await db
    .select({ ehrEncounterRef: encountersTable.ehrEncounterRef })
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, code.encounterId),
        eq(encountersTable.organizationId, req.orgId),
      ),
    )
    .limit(1);
  if (!enc) return { kind: "encounter_not_found" };

  // 5. Dispatch. pushBillingCodeToEhr handles vendor selection
  //    (mock / athenahealth / epic-not-impl) and applies a
  //    deterministic Idempotency-Key of `bc_<id>` so the upstream
  //    dedupes regardless of how many retries land.
  try {
    const outcome = await pushBillingCodeToEhr({
      billingCode: {
        id: code.id,
        codeSystem: code.codeSystem,
        code: code.code,
        description: code.description,
      },
      encounterEhrRef: enc.ehrEncounterRef,
      userId: req.initiatingUserId,
    });

    const now = new Date();
    const [updated] = await db
      .update(approvedBillingCodesTable)
      .set({
        exportedAt: outcome.pushedAt,
        ehrDocumentRef: outcome.ehrDocumentRef,
        ehrError: null,
        updatedAt: now,
      })
      .where(eq(approvedBillingCodesTable.id, code.id))
      .returning();

    // Mirror onto the source suggestion so the dashboard queue sees
    // the recovery. Matches the existing /send-to-ehr behavior.
    if (code.sourceSuggestionId) {
      await db
        .update(billingSuggestionsTable)
        .set({ status: "exported", updatedAt: now })
        .where(eq(billingSuggestionsTable.id, code.sourceSuggestionId));
    }

    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.billing_code.push.succeeded",
      resourceType: "approved_billing_code",
      resourceId: code.id,
      metadata: {
        encounterId: code.encounterId,
        codeSystem: code.codeSystem,
        provider: outcome.provider,
        ehrDocumentRef: outcome.ehrDocumentRef,
        mock: outcome.mock,
      },
    });

    return {
      kind: "ok",
      code: updated ?? code,
      ehrDocumentRef: outcome.ehrDocumentRef,
      provider: outcome.provider,
      mock: outcome.mock,
      pushedAt: outcome.pushedAt,
    };
  } catch (err) {
    const status = err instanceof EhrPushError ? err.status : 500;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const scrubbed = scrubEhrErrorMessage(rawMessage);
    await db
      .update(approvedBillingCodesTable)
      .set({ ehrError: scrubbed, updatedAt: new Date() })
      .where(eq(approvedBillingCodesTable.id, code.id))
      .catch(() => {
        // Persistence failure on the error path is non-fatal — the
        // caller still gets the failed result and can act.
      });
    recordCoderAuditEvent({
      organizationId: req.orgId,
      userId: req.initiatingUserId,
      action: "coder.billing_code.push.failed",
      resourceType: "approved_billing_code",
      resourceId: code.id,
      metadata: {
        encounterId: code.encounterId,
        codeSystem: code.codeSystem,
        status,
        error: scrubbed,
      },
    });
    return {
      kind: "failed",
      code,
      error: scrubbed,
      retryable: isRetryableStatus(status),
      status,
    };
  }
}
