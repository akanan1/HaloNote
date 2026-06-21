// Coder routes. Thin layer over services/coding.ts — parses inputs,
// serializes outputs, maps result kinds to HTTP codes. All real logic
// lives in the service so an offline/CLI driver can drive it too.

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import type {
  BillingSuggestion,
  EncounterCodingSession,
} from "@workspace/db";
import { respondInvalidBody } from "../http";
import { aiEndpointRateLimit } from "../middlewares/ai-rate-limit";
import { getActiveOrgId } from "../lib/active-org";
import {
  applyRefinement,
  approveAllHighConfidence,
  editSuggestion,
  generateCoding,
  getLatestSession,
  getSessionById,
  listBillerQueue,
  refineAllInSession,
  refineSuggestion,
} from "../services/coding";
import { ingestAthenaNote } from "../services/athena-ingest";
import {
  listRecentAthenaEncounters,
  listRecentAthenaNotes,
  type AthenaEncounterCandidate,
  type AthenaNoteCandidate,
} from "../lib/athena-note-pull";
import { getDb } from "@workspace/db";
import { patientsTable } from "@workspace/db";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Serializers — wire shape. Kept here (not OpenAPI yet) for Phase 1A;
// the next phase wires these into openapi.yaml so the frontend gets
// typed react-query hooks.
// ---------------------------------------------------------------------------

function serializeSession(row: EncounterCodingSession) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    noteId: row.noteId,
    noteSource: row.noteSource,
    sourceNoteHash: row.sourceNoteHash,
    status: row.status,
    failureReason: row.failureReason,
    parsedSections: row.parsedSections,
    extractionStartedAt: row.extractionStartedAt?.toISOString() ?? null,
    extractionCompletedAt: row.extractionCompletedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    writebackStartedAt: row.writebackStartedAt?.toISOString() ?? null,
    writebackCompletedAt: row.writebackCompletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSuggestion(row: BillingSuggestion) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    encounterId: row.encounterId,
    codingSessionId: row.codingSessionId,
    codeSystem: row.codeSystem,
    code: row.code,
    description: row.description,
    editedCode: row.editedCode,
    editedDescription: row.editedDescription,
    rationale: row.rationale,
    supportingExcerpts: row.supportingExcerpts,
    documentationGaps: row.documentationGaps,
    confidence: row.confidence,
    sourceSection: row.sourceSection,
    destinationField: row.destinationField,
    hccCategory: row.hccCategory,
    rafRelevant: row.rafRelevant,
    status: row.status,
    statusNote: row.statusNote,
    createdByAi: row.createdByAi,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /encounters/:id/coding/generate
// Runs the Coder against the encounter's latest note (or a specific
// noteId if provided). Returns the new session + the suggestions it
// produced. Synchronous — clients should expect ~5-10s for a real AI
// call. The /notes/:id/approve hook fires this in background so the
// approval response isn't blocked.
// ---------------------------------------------------------------------------

const GenerateBody = z.object({
  noteId: z.string().min(1).optional(),
  noteSource: z.enum(["halonote_scribe", "athena_existing"]).default("halonote_scribe"),
});

router.post("/encounters/:id/coding/generate", aiEndpointRateLimit, async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  // Adding middleware before the handler loosens Express's params typing
  // to string|string[]|undefined. Extract once with the known shape.
  const encounterId = req.params["id"] as string;

  const parsed = GenerateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    respondInvalidBody(res, parsed.error);
    return;
  }

  const result = await generateCoding({
    orgId,
    encounterId,
    noteId: parsed.data.noteId ?? null,
    noteSource: parsed.data.noteSource,
  });

  if (result.kind === "encounter_not_found") {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }
  if (result.kind === "patient_not_found") {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (result.kind === "no_note") {
    res.status(409).json({ error: "no_note_to_code_from" });
    return;
  }

  res.status(201).json({
    session: serializeSession(result.session),
    suggestions: result.suggestions.map(serializeSuggestion),
  });
});

// ---------------------------------------------------------------------------
// GET /encounters/:id/coding/session
// Returns the latest Coder session for this encounter + its suggestions.
// 404 when the encounter has never been Coder-coded.
// ---------------------------------------------------------------------------

router.get("/encounters/:id/coding/session", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const result = await getLatestSession(req.params.id, orgId);
  if (result.kind === "not_found") {
    res.status(404).json({ error: "no_coding_session" });
    return;
  }
  res.json({
    session: serializeSession(result.session),
    suggestions: result.suggestions.map(serializeSuggestion),
  });
});

// ---------------------------------------------------------------------------
// GET /coding/sessions/:id  — single-session read by id (Coder Review
// deep links land here when the URL has a specific session in it).
// ---------------------------------------------------------------------------

router.get("/coding/sessions/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const result = await getSessionById(req.params.id, orgId);
  if (result.kind === "not_found") {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({
    session: serializeSession(result.session),
    suggestions: result.suggestions.map(serializeSuggestion),
  });
});

// ---------------------------------------------------------------------------
// POST /coding/suggestions/:id/edit
// Provider edits a code/description before approving. Body:
//   { editedCode, editedDescription, reason? }
// Only works on ai_suggested / needs_review. Once approved, edits
// route through the approved-code amendment flow (out of Phase 1A).
// ---------------------------------------------------------------------------

const EditBody = z.object({
  editedCode: z.string().min(1).max(20),
  editedDescription: z.string().min(1).max(300),
  reason: z.string().max(500).optional(),
});

router.post("/coding/suggestions/:id/edit", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const reviewer = req.user;
  if (!reviewer) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const parsed = EditBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    respondInvalidBody(res, parsed.error);
    return;
  }

  const result = await editSuggestion({
    suggestionId: req.params.id,
    orgId,
    reviewerId: reviewer.id,
    editedCode: parsed.data.editedCode,
    editedDescription: parsed.data.editedDescription,
    reason: parsed.data.reason ?? null,
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (result.kind === "not_editable") {
    res.status(409).json({ error: "suggestion_not_editable" });
    return;
  }
  res.json(serializeSuggestion(result.suggestion));
});

// ---------------------------------------------------------------------------
// POST /coding/suggestions/:id/refine
// Returns ranked refinement options for a single ICD-10 / CPT suggestion.
// Read-only — apply is a separate POST so the provider can preview without
// committing. HaloNote's twist over CarePilot: each option carries
// hccUnlocked + suggestedNoteLanguage so the UI can surface the
// revenue lever AND turn doc-gap codes into documentation prompts.
// ---------------------------------------------------------------------------

router.post("/coding/suggestions/:id/refine", aiEndpointRateLimit, async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const suggestionId = req.params["id"] as string;

  const result = await refineSuggestion({
    suggestionId,
    orgId,
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "suggestion_not_found" });
    return;
  }
  if (result.kind === "not_refinable") {
    res.status(409).json({ error: "suggestion_not_refinable" });
    return;
  }
  if (result.kind === "session_lost") {
    res.status(409).json({ error: "session_unavailable" });
    return;
  }
  res.json({ options: result.options, source: result.source });
});

// ---------------------------------------------------------------------------
// POST /coding/sessions/:id/refine-all
// Bulk refine: runs the refiner against every editable icd10/cpt
// suggestion in the session. Concurrency-capped server-side so a
// 30-code session doesn't fan out 30 Anthropic calls. Returns the
// aggregate so the UI can render a compact overview with HCC
// unlocks highlighted. Apply is still per-row (this is read-only).
// ---------------------------------------------------------------------------

router.post(
  "/coding/sessions/:id/refine-all",
  aiEndpointRateLimit,
  async (req, res) => {
    const orgId = getActiveOrgId(req, res);
    if (!orgId) return;
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const result = await refineAllInSession({
      sessionId: req.params["id"] as string,
      orgId,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({
      items: result.items,
      hccUnlockCount: result.hccUnlockCount,
      source: result.source,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /coding/suggestions/:id/apply-refinement
// Provider picks one option from /refine and we set editedCode +
// editedDescription, bumping hccCategory when the refinement unlocks
// a bucket. Original code/description stay intact for audit.
// ---------------------------------------------------------------------------

const ApplyRefinementBody = z.object({
  chosenCode: z.string().min(1).max(20),
  chosenDescription: z.string().min(1).max(300),
  chosenHccCategory: z.string().max(200).nullable().optional(),
  hccUnlocked: z.boolean(),
});

router.post(
  "/coding/suggestions/:id/apply-refinement",
  async (req, res) => {
    const orgId = getActiveOrgId(req, res);
    if (!orgId) return;
    const reviewer = req.user;
    if (!reviewer) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const parsed = ApplyRefinementBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondInvalidBody(res, parsed.error);
      return;
    }
    const result = await applyRefinement({
      suggestionId: req.params.id,
      orgId,
      reviewerId: reviewer.id,
      chosenCode: parsed.data.chosenCode,
      chosenDescription: parsed.data.chosenDescription,
      chosenHccCategory: parsed.data.chosenHccCategory ?? null,
      hccUnlocked: parsed.data.hccUnlocked,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "suggestion_not_found" });
      return;
    }
    if (result.kind === "not_editable") {
      res.status(409).json({ error: "suggestion_not_editable" });
      return;
    }
    res.json(serializeSuggestion(result.suggestion));
  },
);

// ---------------------------------------------------------------------------
// POST /coding/sessions/:id/approve-all-high-confidence
// The "Approve and Write to Encounter" action. Bulk-approves every
// session suggestion whose confidence ≥ minConfidence (default 'high')
// AND has no block-severity documentation gap. Returns counts so the
// UI can render "12 approved · 3 need individual review".
// ---------------------------------------------------------------------------

const ApproveAllBody = z.object({
  minConfidence: z.enum(["low", "medium", "high"]).optional(),
});

router.post(
  "/coding/sessions/:id/approve-all-high-confidence",
  async (req, res) => {
    const orgId = getActiveOrgId(req, res);
    if (!orgId) return;
    const approver = req.user;
    if (!approver) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const parsed = ApproveAllBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondInvalidBody(res, parsed.error);
      return;
    }

    const result = await approveAllHighConfidence({
      sessionId: req.params.id,
      orgId,
      approverId: approver.id,
      ...(parsed.data.minConfidence
        ? { minConfidence: parsed.data.minConfidence }
        : {}),
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    if (result.kind === "wrong_state") {
      res.status(409).json({ error: "session_not_ready_for_approval" });
      return;
    }
    res.json({
      session: serializeSession(result.session),
      approvedCount: result.approvedCount,
      skippedCount: result.skippedCount,
      pushedBillingCount: result.pushedBillingCount,
      pushedOrderCount: result.pushedOrderCount,
      pushFailedCount: result.pushFailedCount,
    });
  },
);

// ---------------------------------------------------------------------------
// Athena-existing note ingestion (Phase 3 — practices without Scribe).
//
//   GET  /patients/:id/athena-notes        — list recent FHIR DocRefs
//   POST /encounters/:id/coding/ingest-athena-note
//        body: { athenaDocumentReferenceId: string }
//        Pulls the note, materializes it locally, fires the Coder
//        with noteSource='athena_existing'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /patients/:id/athena-encounters — picker source for the
// "Link to Athena encounter" UI in the Coder Review panel. Returns [] for
// patients without an ehrPatientId so the UI can degrade cleanly without
// branching on a separate error code.
// ---------------------------------------------------------------------------

router.get("/patients/:id/athena-encounters", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const [patient] = await getDb()
    .select({
      id: patientsTable.id,
      ehrPatientId: patientsTable.ehrPatientId,
    })
    .from(patientsTable)
    .where(eq(patientsTable.id, req.params.id))
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (!patient.ehrPatientId) {
    res.json({ data: [] as AthenaEncounterCandidate[] });
    return;
  }

  try {
    const data = await listRecentAthenaEncounters(patient.ehrPatientId);
    res.json({ data });
  } catch (err) {
    req.log.warn({ err }, "athena-encounters: list failed");
    res.status(502).json({ error: "athena_unavailable" });
  }
});

router.get("/patients/:id/athena-notes", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const [patient] = await getDb()
    .select({
      id: patientsTable.id,
      ehrPatientId: patientsTable.ehrPatientId,
    })
    .from(patientsTable)
    .where(eq(patientsTable.id, req.params.id))
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (!patient.ehrPatientId) {
    res.json({ data: [] as AthenaNoteCandidate[] });
    return;
  }

  try {
    const data = await listRecentAthenaNotes(patient.ehrPatientId);
    res.json({ data });
  } catch (err) {
    req.log.warn({ err }, "athena-notes: list failed");
    res.status(502).json({ error: "athena_unavailable" });
  }
});

const IngestBody = z.object({
  athenaDocumentReferenceId: z.string().min(1).max(120),
});

router.post(
  "/encounters/:id/coding/ingest-athena-note",
  aiEndpointRateLimit,
  async (req, res) => {
    const orgId = getActiveOrgId(req, res);
    if (!orgId) return;
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const parsed = IngestBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondInvalidBody(res, parsed.error);
      return;
    }

    const result = await ingestAthenaNote({
      orgId,
      encounterId: req.params["id"] as string,
      athenaDocumentReferenceId: parsed.data.athenaDocumentReferenceId,
      initiatingUserId: user.id,
      log: req.log,
    });

    if (result.kind === "encounter_not_found") {
      res.status(404).json({ error: "encounter_not_found" });
      return;
    }
    if (result.kind === "patient_not_found") {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (result.kind === "athena_doc_not_found") {
      res.status(404).json({ error: "athena_doc_not_found" });
      return;
    }
    if (result.kind === "athena_doc_no_text") {
      res.status(422).json({ error: "athena_doc_no_text" });
      return;
    }
    if (result.coding.kind !== "ok") {
      res
        .status(500)
        .json({ error: `coding_failed_${result.coding.kind}` });
      return;
    }
    res.status(201).json({
      noteId: result.noteId,
      noteSource: result.noteSource,
      session: serializeSession(result.coding.session),
      suggestions: result.coding.suggestions.map(serializeSuggestion),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /coding/biller-queue
// Encounters Coder-coded and awaiting (or recently past) biller review.
// One row per session in 'approved' | 'writing' | 'complete', aggregating
// approved-billing-code counts so the biller dashboard loads in one query.
// ---------------------------------------------------------------------------

router.get("/coding/biller-queue", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const limitRaw = Number(req.query["limit"] ?? 100);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500
      ? Math.floor(limitRaw)
      : 100;

  const rows = await listBillerQueue(orgId, limit);
  res.json({ data: rows });
});

export default router;
