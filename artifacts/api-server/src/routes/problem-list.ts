// Problem-list routes. Thin layer over services/problem-list.ts.
//
//   GET  /patients/:id/problems                     — local cache
//   GET  /coding/sessions/:id/problem-suggestions   — reconciler output
//   POST /coding/sessions/:id/reconcile-problems    — re-run reconcile
//   POST /problem-list-suggestions/:id/accept       — apply local mutation
//   POST /problem-list-suggestions/:id/reject       — record rejection
//
// The coding orchestrator auto-fires reconcile after extraction, so the
// explicit POST is for manual re-runs (provider edits the note and
// wants the reconciler to look again).

import { Router, type IRouter } from "express";
import { z } from "@workspace/api-zod";
import type { PatientProblem, ProblemListSuggestion } from "@workspace/db";
import { respondInvalidBody } from "../http";
import { aiEndpointRateLimit } from "../middlewares/ai-rate-limit";
import { getActiveOrgId } from "../lib/active-org";
import {
  acceptSuggestion,
  listPatientProblems,
  listProblemSuggestionsForSession,
  reconcileForCodingSession,
  rejectSuggestion,
} from "../services/problem-list";

const router: IRouter = Router();

function serializeProblem(row: PatientProblem) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    patientId: row.patientId,
    code: row.code,
    description: row.description,
    status: row.status,
    onsetDate: row.onsetDate,
    ehrSource: row.ehrSource,
    ehrResourceRef: row.ehrResourceRef,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSuggestion(row: ProblemListSuggestion) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    codingSessionId: row.codingSessionId,
    patientId: row.patientId,
    encounterId: row.encounterId,
    action: row.action,
    targetProblemId: row.targetProblemId,
    mergeFromProblemId: row.mergeFromProblemId,
    proposedCode: row.proposedCode,
    proposedDescription: row.proposedDescription,
    proposedStatus: row.proposedStatus,
    rationale: row.rationale,
    supportingExcerpts: row.supportingExcerpts,
    confidence: row.confidence,
    status: row.status,
    statusNote: row.statusNote,
    appliedLocally: row.appliedLocally,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /patients/:id/problems
// ---------------------------------------------------------------------------

router.get("/patients/:id/problems", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const rows = await listPatientProblems(req.params.id, orgId);
  res.json({ data: rows.map(serializeProblem) });
});

// ---------------------------------------------------------------------------
// GET /coding/sessions/:id/problem-suggestions
// ---------------------------------------------------------------------------

router.get("/coding/sessions/:id/problem-suggestions", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const rows = await listProblemSuggestionsForSession(req.params.id, orgId);
  res.json({ data: rows.map(serializeSuggestion) });
});

// ---------------------------------------------------------------------------
// POST /coding/sessions/:id/reconcile-problems — manual re-run
// ---------------------------------------------------------------------------

router.post("/coding/sessions/:id/reconcile-problems", aiEndpointRateLimit, async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const result = await reconcileForCodingSession(
    req.params["id"] as string,
    orgId,
  );

  if (result.kind === "session_not_found") {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (result.kind === "patient_not_found") {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (result.kind === "no_assessment_section") {
    res.status(409).json({ error: "no_assessment_section" });
    return;
  }

  res.json({
    data: result.suggestions.map(serializeSuggestion),
    problems: result.problems.map(serializeProblem),
    ehrHit: result.ehrHit,
  });
});

// ---------------------------------------------------------------------------
// POST /problem-list-suggestions/:id/accept
// ---------------------------------------------------------------------------

const AcceptBody = z.object({
  reason: z.string().max(500).optional(),
});

router.post("/problem-list-suggestions/:id/accept", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const reviewer = req.user;
  if (!reviewer) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = AcceptBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    respondInvalidBody(res, parsed.error);
    return;
  }
  const result = await acceptSuggestion({
    id: req.params.id,
    orgId,
    reviewerId: reviewer.id,
    reason: parsed.data.reason ?? null,
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (result.kind === "not_actionable") {
    res.status(409).json({ error: "suggestion_not_actionable" });
    return;
  }
  if (result.kind === "target_not_found") {
    res.status(409).json({ error: "target_problem_not_found" });
    return;
  }
  res.json(serializeSuggestion(result.suggestion));
});

// ---------------------------------------------------------------------------
// POST /problem-list-suggestions/:id/reject
// ---------------------------------------------------------------------------

const RejectBody = z.object({
  reason: z.string().min(1).max(500),
});

router.post("/problem-list-suggestions/:id/reject", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const reviewer = req.user;
  if (!reviewer) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = RejectBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    respondInvalidBody(res, parsed.error);
    return;
  }
  const result = await rejectSuggestion({
    id: req.params.id,
    orgId,
    reviewerId: reviewer.id,
    reason: parsed.data.reason,
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (result.kind === "not_actionable") {
    res.status(409).json({ error: "suggestion_not_actionable" });
    return;
  }
  res.json(serializeSuggestion(result.suggestion));
});

export default router;
