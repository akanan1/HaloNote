// Structured audit events for the Coder workflow.
//
// The generic audit middleware (middlewares/audit.ts) already logs one
// row per authenticated HTTP request with method + status + resource
// type + resource id. That's the compliance baseline.
//
// This module layers RICHER events on top — with sessionId, code
// counts, before/after deltas, HCC unlocks — that the HIPAA spec calls
// out explicitly (see the Partner Tech Spec we filled out:
// "Add audit logging for: Note ingestion, Coding generation, Suggested
// codes, Accepted codes, Rejected codes, Edited codes, Problem list
// changes, HCC/RAF suggestions, AthenaOne writeback attempts").
//
// All writes are fire-and-forget — failure to persist doesn't fail
// the underlying transition (the user's change is more important than
// the bookkeeping). Pino logs the persist error so we can detect
// audit-log outages.
//
// PHI safety: NEVER include patient names, DOB, MRN, full note text,
// or excerpts in the metadata. Codes, counts, status transitions,
// session ids, and authoring user ids are fine — those are what
// HIPAA audit logs are expected to carry.

import { auditLogTable, getDb } from "@workspace/db";
import { logger } from "./logger";
import { trackAuditWrite } from "../middlewares/audit";

export type CoderAuditAction =
  // Generation lifecycle.
  | "coder.generate.started"
  | "coder.generate.completed"
  | "coder.generate.failed"
  // Per-suggestion provider actions.
  | "coder.suggestion.edited"
  | "coder.suggestion.refined.preview"
  | "coder.suggestion.refined.applied"
  // Session-level provider actions.
  | "coder.session.bulk_approve"
  | "coder.session.writeback.completed"
  | "coder.session.writeback.partial_failure"
  // Single-order push lifecycle (pushApprovedOrder service). Bulk-push
  // already covers coverage at the session level via writeback.* —
  // these fire on the per-order /send-to-ehr path AND let HIPAA audit
  // see exactly which order rows hit the EHR, which user initiated,
  // and which were dry-runs vs real-mode dispatches.
  | "coder.order.push.succeeded"
  | "coder.order.push.failed"
  | "coder.order.push.dry_run"
  | "coder.order.push.skipped_duplicate"
  | "coder.order.push.skipped_unapproved"
  | "coder.order.push.skipped_unfinalized"
  // Per-billing-code retry — for stranded codes from the bulk-approve
  // path. Session-level writeback.* events already cover happy-path
  // bulk pushes; these fire when the provider hits "Retry" on a single
  // failed card so HIPAA audit can attribute the manual recovery.
  | "coder.billing_code.push.succeeded"
  | "coder.billing_code.push.failed"
  | "coder.billing_code.push.skipped_not_stranded"
  | "coder.billing_code.push.skipped_unfinalized"
  // Athena ingest.
  | "coder.ingest.athena_note.completed"
  | "coder.ingest.athena_note.failed"
  // Problem-list reconciliation.
  | "problem_list.reconcile.completed"
  | "problem_list.suggestion.accepted"
  | "problem_list.suggestion.rejected"
  // EHR encounter linking.
  | "encounter.athena_link.set"
  | "encounter.athena_link.cleared";

export interface CoderAuditArgs {
  organizationId: string;
  userId: string | null;
  action: CoderAuditAction;
  // Primary resource the event is about (session id for session-level,
  // suggestion id for per-row, encounter id for encounter actions).
  resourceType:
    | "coding_session"
    | "billing_suggestion"
    | "approved_billing_code"
    | "problem_list_suggestion"
    | "approved_order"
    | "encounter"
    | "note";
  resourceId: string;
  // Free-shape metadata. Caller is responsible for keeping PHI out.
  // Recommended fields per action:
  //   generate.completed → { suggestionCount, hccUnlockedCount, source }
  //   suggestion.edited  → { codeSystem, originalCode, editedCode }
  //   refined.applied    → { originalCode, refinedCode, hccUnlocked }
  //   bulk_approve       → { approvedCount, skippedCount, pushedBillingCount, pushedOrderCount, pushFailedCount }
  //   reconcile.completed→ { actionCount, ehrHit }
  //   athena_link.set    → { ehrEncounterRef }
  metadata?: Record<string, unknown>;
}

export function recordCoderAuditEvent(args: CoderAuditArgs): void {
  // Fire-and-forget — resolved Promise intentionally not awaited by callers.
  // We DO register it with trackAuditWrite so the integration test harness
  // can drain pending writes before TRUNCATE; otherwise the in-flight
  // INSERT into audit_log (RowShareLock on users via FK) deadlocks with
  // the next test's TRUNCATE (AccessExclusiveLock).
  const promise = getDb()
    .insert(auditLogTable)
    .values({
      organizationId: args.organizationId,
      userId: args.userId,
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      metadata: args.metadata ?? {},
    })
    .catch((err: unknown) => {
      logger.warn(
        {
          err,
          action: args.action,
          resourceType: args.resourceType,
          resourceId: args.resourceId,
        },
        "coder audit log write failed",
      );
    });
  trackAuditWrite(promise);
}

// ---------------------------------------------------------------------------
// PHI scrubbing helper for upstream-EHR error payloads. Athena REST
// errors sometimes echo patient identifiers ("Patient JOHN SMITH not
// found"). We persist the error message verbatim on the row for retry
// debugging — so it needs to be scrubbed first.
//
// Conservative: strips anything that looks like a name (two consecutive
// Title-Case words), keeps codes, status numbers, error keywords.
// ---------------------------------------------------------------------------

const NAME_PAIR = /\b[A-Z][a-z'-]{1,}\s+[A-Z][a-z'-]{1,}\b/g;
const DOB_LIKE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const SSN_LIKE = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const LONG_NUM = /\b\d{9,}\b/g; // MRNs, phone numbers, etc.

export function scrubEhrErrorMessage(raw: string): string {
  const truncated = raw.slice(0, 400);
  return truncated
    .replace(NAME_PAIR, "[PHI]")
    .replace(DOB_LIKE, "[DOB]")
    .replace(SSN_LIKE, "[SSN]")
    .replace(LONG_NUM, "[ID]")
    .trim();
}
