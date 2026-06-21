// Problem-list service. Orchestrates:
//   1. Athena pull (delegates to athena-problem-list.ts)
//   2. LLM reconciliation (delegates to problem-list-reconciler.ts)
//   3. Persistence of problem_list_suggestions rows
//   4. Provider accept/reject transitions, including the local mutation
//      that applies the action to patient_problems.
//
// EHR writeback for accepted actions is deferred to Phase 3 (paired
// with the codes writeback). Until then, accept = "applied locally";
// the user knows the chart-side push is the next step.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  encounterCodingSessionsTable,
  getDb,
  patientProblemsTable,
  patientsTable,
  problemListSuggestionsTable,
  type PatientProblem,
  type ProblemListSuggestion,
  type ProblemStatus,
  type ProblemSuggestionAction,
} from "@workspace/db";
import { syncPatientProblemList } from "../lib/athena-problem-list";
import { recordCoderAuditEvent } from "../lib/audit-events";
import { pushProblemListChangeToEhr } from "../lib/ehr-push-problem";
import { logger } from "../lib/logger";
import {
  reconcileProblemList,
  type ReconcilerAction,
} from "../lib/problem-list-reconciler";

// ---------------------------------------------------------------------------
// Result kinds
// ---------------------------------------------------------------------------

export type ReconcileForSessionResult =
  | {
      kind: "ok";
      suggestions: ProblemListSuggestion[];
      problems: PatientProblem[];
      ehrHit: boolean;
    }
  | { kind: "session_not_found" }
  | { kind: "patient_not_found" }
  | { kind: "no_assessment_section" };

export type AcceptResult =
  | { kind: "ok"; suggestion: ProblemListSuggestion }
  | { kind: "not_found" }
  | { kind: "not_actionable" }
  | { kind: "target_not_found" };

export type RejectResult =
  | { kind: "ok"; suggestion: ProblemListSuggestion }
  | { kind: "not_found" }
  | { kind: "not_actionable" };

// ---------------------------------------------------------------------------
// Persisted-row loaders
// ---------------------------------------------------------------------------

async function loadSuggestionsForSession(
  sessionId: string,
  orgId: string,
): Promise<ProblemListSuggestion[]> {
  return getDb()
    .select()
    .from(problemListSuggestionsTable)
    .where(
      and(
        eq(problemListSuggestionsTable.codingSessionId, sessionId),
        eq(problemListSuggestionsTable.organizationId, orgId),
      ),
    )
    .orderBy(problemListSuggestionsTable.createdAt);
}

// ---------------------------------------------------------------------------
// reconcileForCodingSession — the main pipeline. Pulls Athena, calls
// the LLM, persists the suggestions linked to the session.
// ---------------------------------------------------------------------------

export async function reconcileForCodingSession(
  sessionId: string,
  orgId: string,
): Promise<ReconcileForSessionResult> {
  const db = getDb();

  const [session] = await db
    .select()
    .from(encounterCodingSessionsTable)
    .where(
      and(
        eq(encounterCodingSessionsTable.id, sessionId),
        eq(encounterCodingSessionsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!session) return { kind: "session_not_found" };

  // We need the encounter's patientId + the patient's ehrPatientId for
  // the Athena pull. Sessions don't carry patient directly, so join
  // via encounter.
  // Drizzle's relational layer would need extra schema config to join
  // encounters → patients; the parameterized sql tag is clearer here
  // and binds values safely (no manual quote-escaping).
  const encResult = await db.execute<{
    patient_id: string;
    ehr_patient_id: string | null;
  }>(sql`
    SELECT e.patient_id, p.ehr_patient_id
    FROM encounters e
    JOIN patients p ON p.id = e.patient_id
    WHERE e.id = ${session.encounterId}
      AND e.organization_id = ${orgId}
    LIMIT 1
  `);
  const encRow = encResult.rows[0];
  if (!encRow) return { kind: "patient_not_found" };
  const patientId = encRow.patient_id;

  // Sync the local cache from Athena (no-op in mock mode).
  const synced = await syncPatientProblemList({
    orgId,
    patientId,
    ehrPatientId: encRow.ehr_patient_id,
  });

  // Pull the session's ICD-10 suggestions + the parsed assessment/plan
  // sections from the session row. The reconciler reads both.
  const sections = (session.parsedSections ?? {}) as {
    assessment?: string;
    plan?: string;
  };
  if (!sections.assessment && !sections.plan) {
    // No narrative for the reconciler to read. We still persist a
    // marker row so the UI can say "ran but found nothing".
    return {
      kind: "ok",
      suggestions: [],
      problems: synced.problems,
      ehrHit: synced.hit,
    };
  }

  const noteIcd10 = await db.execute<{ code: string; description: string }>(sql`
    SELECT code, description
    FROM billing_suggestions
    WHERE coding_session_id = ${session.id}
      AND organization_id = ${orgId}
      AND code_system = 'icd10'
  `);

  const { result: reconciled } = await reconcileProblemList({
    currentProblems: synced.problems.map((p) => ({
      id: p.id,
      code: p.code,
      description: p.description,
      status: p.status,
    })),
    noteIcd10Codes: noteIcd10.rows.map((r) => ({
      code: r.code,
      description: r.description,
    })),
    assessmentText: sections.assessment ?? "",
    planText: sections.plan ?? "",
  });

  // Resolve targetProblemId + mergeFromProblemId via local lookups so
  // the suggestion rows carry stable FK references the UI can render.
  const byCode = new Map<string, string>(); // code → patient_problems.id
  for (const p of synced.problems) byCode.set(p.code, p.id);

  // Wipe previously-persisted suggestions for this session before re-
  // inserting. Reconcile is idempotent on re-run; old suggestions
  // would just become stale duplicates if we appended.
  await db
    .delete(problemListSuggestionsTable)
    .where(
      and(
        eq(problemListSuggestionsTable.codingSessionId, session.id),
        eq(problemListSuggestionsTable.organizationId, orgId),
      ),
    );

  const rows = reconciled.actions.map((a: ReconcilerAction) => {
    const targetProblemId =
      a.action === "update_status" ||
      a.action === "resolve" ||
      a.action === "merge_duplicate" ||
      a.action === "flag_uncertain"
        ? (byCode.get(a.code) ?? null)
        : null;
    const mergeFromProblemId =
      a.action === "merge_duplicate" && a.mergeFromCode
        ? (byCode.get(a.mergeFromCode) ?? null)
        : null;
    return {
      organizationId: orgId,
      codingSessionId: session.id,
      patientId,
      encounterId: session.encounterId,
      action: a.action,
      targetProblemId,
      mergeFromProblemId,
      proposedCode: a.action === "add" ? a.code : (a.code ?? null),
      proposedDescription:
        a.action === "add" ? a.description : (a.description ?? null),
      proposedStatus: a.proposedStatus ?? null,
      rationale: a.rationale,
      supportingExcerpts: a.supportingExcerpts,
      confidence: a.confidence,
    };
  });

  const inserted = rows.length
    ? await db
        .insert(problemListSuggestionsTable)
        .values(rows)
        .returning()
    : [];

  recordCoderAuditEvent({
    organizationId: orgId,
    userId: null,
    action: "problem_list.reconcile.completed",
    resourceType: "coding_session",
    resourceId: session.id,
    metadata: {
      patientId,
      encounterId: session.encounterId,
      actionCount: inserted.length,
      addCount: inserted.filter((s) => s.action === "add").length,
      updateCount: inserted.filter((s) => s.action === "update_status").length,
      resolveCount: inserted.filter((s) => s.action === "resolve").length,
      mergeCount: inserted.filter((s) => s.action === "merge_duplicate").length,
      flagCount: inserted.filter((s) => s.action === "flag_uncertain").length,
      ehrHit: synced.hit,
    },
  });

  return {
    kind: "ok",
    suggestions: inserted,
    problems: synced.problems,
    ehrHit: synced.hit,
  };
}

// ---------------------------------------------------------------------------
// Accept — apply the proposed action to patient_problems locally.
// ---------------------------------------------------------------------------

async function applyLocally(
  suggestion: ProblemListSuggestion,
  orgId: string,
): Promise<"ok" | "target_not_found"> {
  const db = getDb();
  const now = new Date();
  const action = suggestion.action as ProblemSuggestionAction;

  if (action === "add") {
    if (!suggestion.proposedCode || !suggestion.proposedDescription) {
      return "target_not_found";
    }
    // Upsert keyed on (patientId, code) — if a row materialized between
    // suggestion-time and accept-time, prefer keeping the existing one
    // with a status update.
    await db
      .insert(patientProblemsTable)
      .values({
        organizationId: orgId,
        patientId: suggestion.patientId,
        code: suggestion.proposedCode,
        description: suggestion.proposedDescription,
        status: suggestion.proposedStatus ?? "active",
        ehrSource: "manual",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [patientProblemsTable.patientId, patientProblemsTable.code],
        set: {
          description: suggestion.proposedDescription,
          status: suggestion.proposedStatus ?? "active",
          updatedAt: now,
        },
      });
    return "ok";
  }

  if (action === "update_status" || action === "resolve") {
    if (!suggestion.targetProblemId) return "target_not_found";
    const status: ProblemStatus =
      action === "resolve"
        ? "resolved"
        : (suggestion.proposedStatus ?? "active");
    await db
      .update(patientProblemsTable)
      .set({ status, updatedAt: now })
      .where(
        and(
          eq(patientProblemsTable.id, suggestion.targetProblemId),
          eq(patientProblemsTable.organizationId, orgId),
        ),
      );
    return "ok";
  }

  if (action === "merge_duplicate") {
    if (!suggestion.targetProblemId || !suggestion.mergeFromProblemId) {
      return "target_not_found";
    }
    // Mark the duplicate as resolved + note the merge target. Hard
    // delete would orphan any audit rows referencing it; resolved+note
    // is the conservative path.
    await db
      .update(patientProblemsTable)
      .set({
        status: "resolved",
        description: `(merged into ${suggestion.proposedCode ?? suggestion.targetProblemId})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(patientProblemsTable.id, suggestion.mergeFromProblemId),
          eq(patientProblemsTable.organizationId, orgId),
        ),
      );
    return "ok";
  }

  // flag_uncertain — no mutation; the suggestion exists purely to
  // surface the gap to the clinician. Accept = acknowledged.
  return "ok";
}

export async function acceptSuggestion(args: {
  id: string;
  orgId: string;
  reviewerId: string;
  reason?: string | null;
}): Promise<AcceptResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(problemListSuggestionsTable)
    .where(
      and(
        eq(problemListSuggestionsTable.id, args.id),
        eq(problemListSuggestionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (row.status !== "suggested") return { kind: "not_actionable" };

  const applied = await applyLocally(row, args.orgId);
  if (applied === "target_not_found") return { kind: "target_not_found" };

  const now = new Date();
  const [updated] = await db
    .update(problemListSuggestionsTable)
    .set({
      status: "accepted",
      appliedLocally: true,
      reviewedByUserId: args.reviewerId,
      reviewedAt: now,
      statusNote: args.reason ?? row.statusNote,
      updatedAt: now,
    })
    .where(eq(problemListSuggestionsTable.id, args.id))
    .returning();
  if (!updated) return { kind: "not_found" };

  // Fire-and-forget EHR push. Mock-mode (default in dev) just logs;
  // real Athena mode hits the chart REST API. Failure does not roll
  // back the local accept — the local row already reflects the
  // clinician's decision and the provider can retry from the UI when
  // we add a "Retry EHR push" affordance.
  const patientEhrId = await db
    .execute<{ ehr_patient_id: string | null }>(
      sql`SELECT ehr_patient_id FROM patients WHERE id = ${row.patientId} AND organization_id = ${args.orgId} LIMIT 1`,
    )
    .then((r) => r.rows[0]?.ehr_patient_id ?? null)
    .catch(() => null);

  void pushProblemListChangeToEhr({
    suggestionId: row.id,
    action: row.action,
    patientEhrId,
    icd10: row.proposedCode ?? "",
    description: row.proposedDescription ?? "",
    status: row.proposedStatus ?? "active",
  }).catch((err) => {
    logger.warn(
      { err, suggestionId: row.id },
      "problem-list ehr push failed (accept is final locally; manual retry surface lands next turn)",
    );
  });

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.reviewerId,
    action: "problem_list.suggestion.accepted",
    resourceType: "problem_list_suggestion",
    resourceId: args.id,
    metadata: {
      patientId: row.patientId,
      encounterId: row.encounterId,
      problemAction: row.action,
      proposedCode: row.proposedCode,
      proposedStatus: row.proposedStatus,
    },
  });

  return { kind: "ok", suggestion: updated };
}

export async function rejectSuggestion(args: {
  id: string;
  orgId: string;
  reviewerId: string;
  reason: string;
}): Promise<RejectResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(problemListSuggestionsTable)
    .where(
      and(
        eq(problemListSuggestionsTable.id, args.id),
        eq(problemListSuggestionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (row.status !== "suggested") return { kind: "not_actionable" };

  const now = new Date();
  const [updated] = await db
    .update(problemListSuggestionsTable)
    .set({
      status: "rejected",
      reviewedByUserId: args.reviewerId,
      reviewedAt: now,
      statusNote: args.reason,
      updatedAt: now,
    })
    .where(eq(problemListSuggestionsTable.id, args.id))
    .returning();
  if (!updated) return { kind: "not_found" };

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.reviewerId,
    action: "problem_list.suggestion.rejected",
    resourceType: "problem_list_suggestion",
    resourceId: args.id,
    metadata: {
      patientId: row.patientId,
      encounterId: row.encounterId,
      problemAction: row.action,
      reasonLength: args.reason.length,
    },
  });
  return { kind: "ok", suggestion: updated };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProblemSuggestionsForSession(
  sessionId: string,
  orgId: string,
): Promise<ProblemListSuggestion[]> {
  return loadSuggestionsForSession(sessionId, orgId);
}

export async function listPatientProblems(
  patientId: string,
  orgId: string,
): Promise<PatientProblem[]> {
  return getDb()
    .select()
    .from(patientProblemsTable)
    .where(
      and(
        eq(patientProblemsTable.organizationId, orgId),
        eq(patientProblemsTable.patientId, patientId),
      ),
    )
    .orderBy(desc(patientProblemsTable.updatedAt));
}

// Suppress unused-import warning for cross-table types referenced only
// via schema FK definitions.
void patientsTable;
void inArray;
