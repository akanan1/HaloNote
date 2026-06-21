import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { CreateNoteBody, UpdateNoteBody } from "@workspace/api-zod";
import {
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
} from "@workspace/db";
import { EhrPushError } from "../lib/ehr-push";
import { pushApprovedNote } from "../lib/auto-push";
import { getActiveOrgId } from "../lib/active-org";
import { analyzeNoteGaps } from "../lib/note-gap-analyzer";
import {
  generatePatientSummary,
  SUMMARY_LANGUAGES,
  type SummaryLanguage,
} from "../lib/patient-summary-generator";
import { refineNote } from "../lib/note-refiner";
import { extractVitals } from "../lib/vital-extractor";
import { z } from "@workspace/api-zod";
import { clampLimit, parseIsoDate, respondInvalidBody } from "../http";
import {
  approveNote,
  createNote,
  findNoteById,
  listNotes,
  NOTE_STATUSES,
  serializeNote,
  softDeleteNote,
  updateNoteBody,
  type CreateNoteResult,
  type NoteStatus,
} from "../services/notes";
import { kickCodingForApprovedNote } from "../services/coding";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const router: IRouter = Router();

router.get("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const row = await findNoteById(req.params.id, orgId);
  if (!row) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  res.json(serializeNote(row));
});

router.get("/notes", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  // Query-string normalisation lives here, not in the service: empty
  // strings collapse to undefined, "me" resolves against the session,
  // and unknown statuses are silently ignored so a stale frontend
  // sending the legacy 'active' value doesn't error against a current
  // server.
  const patientId =
    typeof req.query["patientId"] === "string"
      ? req.query["patientId"].trim() || undefined
      : undefined;
  const before = parseIsoDate(req.query["before"]);
  const limit = clampLimit(req.query["limit"]);
  const statusRaw =
    typeof req.query["status"] === "string"
      ? req.query["status"].trim()
      : undefined;
  const status =
    statusRaw && (NOTE_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as NoteStatus)
      : undefined;
  const authorRaw =
    typeof req.query["authorId"] === "string"
      ? req.query["authorId"].trim()
      : undefined;
  const authorId =
    authorRaw === "me" ? req.user?.id : authorRaw || undefined;

  const { rows, nextCursor } = await listNotes(orgId, {
    limit,
    ...(patientId ? { patientId } : {}),
    ...(before ? { before } : {}),
    ...(status ? { status } : {}),
    ...(authorId ? { authorId } : {}),
  });

  res.json({ data: rows.map(serializeNote), nextCursor });
});

// Maps the discriminated CreateNoteResult to a stable HTTP envelope.
// Keeping this in the route file (not the service) is intentional:
// status codes are an HTTP concern; the service shouldn't know they
// exist. Adding a new error kind requires extending this switch and
// gets caught by exhaustiveness checking.
const CREATE_NOTE_ERRORS = {
  patient_not_found: 404,
  predecessor_not_found: 404,
  predecessor_entered_in_error: 409,
  predecessor_patient_mismatch: 400,
  encounter_not_found: 404,
  encounter_patient_mismatch: 400,
} as const satisfies Record<Exclude<CreateNoteResult["kind"], "ok">, number>;

router.post("/notes", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const parsed = CreateNoteBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  const author = req.user;
  if (!author) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const result = await createNote(
      orgId,
      { id: author.id, displayName: author.displayName },
      {
        patientId: parsed.data.patientId,
        body: parsed.data.body,
        encounterId: parsed.data.encounterId ?? null,
        replacesNoteId: parsed.data.replacesNoteId ?? null,
      },
    );
    if (result.kind === "ok") {
      res.status(201).json(serializeNote(result.row));
      return;
    }
    res.status(CREATE_NOTE_ERRORS[result.kind]).json({ error: result.kind });
  } catch (err) {
    req.log.error({ err }, "Failed to insert note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateNoteBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  const noteId = req.params.id;
  try {
    const result = await updateNoteBody(noteId, orgId, parsed.data.body);
    if (result.kind === "not_found") {
      res.status(404).json({ error: "note_not_found" });
      return;
    }
    if (result.kind === "locked") {
      res.status(409).json({ error: "note_locked", status: result.status });
      return;
    }
    res.json(serializeNote(result.row));
  } catch (err) {
    req.log.error({ err, noteId }, "Failed to update note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const deleted = await softDeleteNote(req.params.id, orgId);
  if (!deleted) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  res.status(204).end();
});

// Provider approval. Transitions draft → approved, stamps approved_at,
// approved_by_user_id, and signed_note_hash. The body is locked at this
// hash — any subsequent direct edit is refused by the PATCH lock check
// above. Amendments go through the FHIR replaces chain.
//
// Idempotent on already-approved notes when the same approver re-hits
// the endpoint with the same body hash (no row change, returns 200).
// Already-exported notes 409 because exporting implies the upstream
// EHR has the approved version and we should not silently overwrite.
router.post("/notes/:id/approve", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const approver = req.user;
  if (!approver) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const noteId = req.params.id;

  try {
    const result = await approveNote(noteId, orgId, approver.id);
    if (result.kind === "not_found") {
      res.status(404).json({ error: "note_not_found" });
      return;
    }
    if (result.kind === "entered_in_error") {
      res.status(409).json({ error: "note_entered_in_error" });
      return;
    }
    if (result.kind === "already_exported") {
      res.status(409).json({ error: "note_already_exported" });
      return;
    }
    if (result.kind === "signed_hash_mismatch") {
      res.status(409).json({
        error: "signed_hash_mismatch",
        message: "Stored hash does not match current body; possible tampering.",
      });
      return;
    }

    // Auto-fire the Coder: on every fresh approval (not idempotent),
    // when the note is attached to an encounter, kick off a coding
    // pass in the background. Fire-and-forget — the orchestrator
    // swallows its own errors so a coder failure never rolls back
    // approval, and the provider can re-run from the Coder Review UI
    // if the auto-pass missed.
    if (result.kind === "approved" && result.row.encounterId) {
      const encounterId = result.row.encounterId;
      void kickCodingForApprovedNote({
        orgId,
        encounterId,
        noteId,
        log: req.log,
      });
    }

    // Auto-push: only on the fresh transition, never on idempotent re-
    // approval (we'd push the same note twice). Failure intentionally
    // does NOT roll back the approval — the note is still approved,
    // just not yet exported, and the manual Send to EHR button can
    // retry. ehrError lands on the row via pushApprovedNote's catch
    // path so the UI can surface the message without an extra query.
    if (
      result.kind === "approved" &&
      approver.autoPushMode === "after_approve"
    ) {
      const [fresh] = await getDb()
        .select()
        .from(notesTable)
        .where(
          and(
            eq(notesTable.id, noteId),
            eq(notesTable.organizationId, orgId),
          ),
        )
        .limit(1);
      if (fresh) {
        await pushApprovedNote(fresh, orgId, approver.id, req.log).catch(
          () => {
            // Swallowed — see comment above.
          },
        );
      }
      // The push wrote ehrError / ehrPushedAt; re-read so the response
      // reflects the post-push state instead of the pre-push snapshot
      // we have in `result.row`.
      const row = await findNoteById(noteId, orgId);
      if (!row) throw new Error("Note vanished between UPDATE and SELECT");
      res.json(serializeNote(row));
      return;
    }

    res.json(serializeNote(result.row));
  } catch (err) {
    req.log.error({ err, noteId }, "Failed to approve note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /notes/:id/analyze-gaps — second AI pass that flags what the note
// is missing or ambiguous. Read-only (no DB writes); the result is
// surfaced inline in the UI for the provider to address before signing.
// Re-runnable cheaply since the note body is the only input.
// ---------------------------------------------------------------------------
router.post("/notes/:id/analyze-gaps", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const noteId = req.params.id;
  const db = getDb();

  const [note] = await db
    .select({
      id: notesTable.id,
      body: notesTable.body,
      status: notesTable.status,
      encounterId: notesTable.encounterId,
    })
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  // Withdrawn notes have nothing to analyze; refuse instead of returning
  // empty so the UI surfaces a clear error.
  if (note.status === "entered-in-error") {
    res.status(409).json({ error: "note_entered_in_error" });
    return;
  }

  // Encounter context biases the analyzer (a new-patient visit gets
  // different gap expectations than a follow-up). Nullable: when a
  // note has no linked encounter (rare for retroactive documentation),
  // fall back to neutral context.
  let encounterContext: {
    visitType: import("@workspace/db").VisitType;
    customLabel: string | null;
    isTelehealth: boolean;
  } = {
    visitType: "follow_up",
    customLabel: null,
    isTelehealth: false,
  };
  if (note.encounterId) {
    const [enc] = await db
      .select({
        visitType: encountersTable.visitType,
        customLabel: encountersTable.customLabel,
        isTelehealth: encountersTable.isTelehealth,
      })
      .from(encountersTable)
      .where(
        and(
          eq(encountersTable.id, note.encounterId),
          eq(encountersTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (enc) encounterContext = enc;
  }

  const { result, source } = await analyzeNoteGaps({
    noteId: note.id,
    noteBody: note.body,
    encounter: encounterContext,
  });
  res.json({ ...result, source });
});

// ---------------------------------------------------------------------------
// POST /notes/:id/generate-summary — AI generates a 6th-grade
// reading-level patient handout from the note. Read-only (no DB writes
// in v1); the frontend renders it and the provider can copy or hand off
// to a future PDF / portal export.
// ---------------------------------------------------------------------------
router.post("/notes/:id/generate-summary", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const noteId = req.params.id;
  const db = getDb();

  const [note] = await db
    .select({
      id: notesTable.id,
      body: notesTable.body,
      status: notesTable.status,
      patientId: notesTable.patientId,
      encounterId: notesTable.encounterId,
    })
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  if (note.status === "entered-in-error") {
    res.status(409).json({ error: "note_entered_in_error" });
    return;
  }

  // Patient first name + DOB go into the prompt so the AI can address
  // the patient by name and (later) check for pediatric / geriatric
  // language. Tenant-scoped lookup; cross-org returns 404 like the
  // patient-detail page.
  const [patient] = await db
    .select({
      firstName: patientsTable.firstName,
      dateOfBirth: patientsTable.dateOfBirth,
    })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, note.patientId),
        eq(patientsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  let encounterContext: {
    visitType: import("@workspace/db").VisitType;
    customLabel: string | null;
    isTelehealth: boolean;
  } = {
    visitType: "follow_up",
    customLabel: null,
    isTelehealth: false,
  };
  if (note.encounterId) {
    const [enc] = await db
      .select({
        visitType: encountersTable.visitType,
        customLabel: encountersTable.customLabel,
        isTelehealth: encountersTable.isTelehealth,
      })
      .from(encountersTable)
      .where(
        and(
          eq(encountersTable.id, note.encounterId),
          eq(encountersTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (enc) encounterContext = enc;
  }

  // Patient-facing output language. Defaults to English when absent
  // or unknown. Validated against the explicit allowlist so unknown
  // codes default to English rather than being silently fed to the
  // prompt (which would produce confusing "I don't know that
  // language" output).
  const langRaw =
    typeof req.query["lang"] === "string"
      ? req.query["lang"].trim().toLowerCase()
      : "";
  const language: SummaryLanguage = (
    SUMMARY_LANGUAGES as readonly string[]
  ).includes(langRaw)
    ? (langRaw as SummaryLanguage)
    : "en";

  const { result, source } = await generatePatientSummary({
    noteId: note.id,
    noteBody: note.body,
    patient,
    encounter: encounterContext,
    language,
  });
  res.json({ ...result, source, language });
});

// ---------------------------------------------------------------------------
// POST /notes/:id/refine — conversational rewrite. Provider sends a
// natural-language instruction; AI returns a refined body that the route
// persists in-place. Only works on DRAFT notes — approved/exported/
// entered-in-error are locked, and the signed-hash invariant on
// approved notes means the body cannot change once signed without going
// through the FHIR replaces chain (a separate flow).
// ---------------------------------------------------------------------------
const RefineNoteBody = z.object({
  instruction: z.string().min(1).max(2000),
});

router.post("/notes/:id/refine", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = RefineNoteBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);
  const noteId = req.params.id;
  const db = getDb();

  const [note] = await db
    .select({
      id: notesTable.id,
      body: notesTable.body,
      status: notesTable.status,
      encounterId: notesTable.encounterId,
    })
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  // Lock invariant — once a note leaves draft, body is immutable.
  // The 409 carries the actual locked status so the UI can route the
  // provider to 'amend' (FHIR replaces-chain create) instead.
  if (note.status !== "draft") {
    res.status(409).json({ error: "note_locked", status: note.status });
    return;
  }

  // Encounter context biases the refiner the same way it biases the gap
  // analyzer + summary generator — visit type affects tone, expected
  // sections, telehealth modifier expectations.
  let encounterContext: {
    visitType: import("@workspace/db").VisitType;
    customLabel: string | null;
    isTelehealth: boolean;
  } = {
    visitType: "follow_up",
    customLabel: null,
    isTelehealth: false,
  };
  if (note.encounterId) {
    const [enc] = await db
      .select({
        visitType: encountersTable.visitType,
        customLabel: encountersTable.customLabel,
        isTelehealth: encountersTable.isTelehealth,
      })
      .from(encountersTable)
      .where(
        and(
          eq(encountersTable.id, note.encounterId),
          eq(encountersTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (enc) encounterContext = enc;
  }

  const { result, source } = await refineNote({
    noteId: note.id,
    body: note.body,
    instruction: parsed.data.instruction,
    encounter: encounterContext,
  });

  // Persist verbatim. The route is the only writer of body content on
  // draft notes outside of PATCH; both go through the same lock check
  // above. updatedAt bumps so autosave-listening clients invalidate.
  try {
    const [updated] = await db
      .update(notesTable)
      .set({ body: result.newBody, updatedAt: new Date() })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .returning({
        id: notesTable.id,
        body: notesTable.body,
        updatedAt: notesTable.updatedAt,
      });
    if (!updated) {
      res.status(404).json({ error: "note_not_found" });
      return;
    }
    res.json({
      note: updated,
      changeSummary: result.changeSummary,
      source,
    });
  } catch (err) {
    req.log.error({ err, noteId }, "Failed to persist refined note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /notes/:id/extract-vitals — AI extracts structured vitals (BP, HR,
// temp, SpO2, weight, etc.) from the note body. Read-only — the panel
// renders the result inline and provider can fact-check against the
// note via the verbatim source excerpt on each field. v2 will persist
// + push along with the note to the EHR.
// ---------------------------------------------------------------------------
router.post("/notes/:id/extract-vitals", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const noteId = req.params.id;
  const db = getDb();

  const [note] = await db
    .select({
      id: notesTable.id,
      body: notesTable.body,
      status: notesTable.status,
    })
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  if (note.status === "entered-in-error") {
    res.status(409).json({ error: "note_entered_in_error" });
    return;
  }

  const { result, source } = await extractVitals({
    noteId: note.id,
    noteBody: note.body,
  });

  // Persist the extraction so the longitudinal-trends endpoint can
  // pull last-visit values without re-running the AI. Conditions:
  //   - source === 'ai'   — stubs return nothing meaningful; persisting
  //                         would pollute trend queries with empty rows
  //   - status === 'draft' — approved/exported notes are body-locked,
  //                         so the extracted body content is also
  //                         immutable; refusing the write here keeps
  //                         the signed-hash invariant honest.
  if (source === "ai" && note.status === "draft") {
    await db
      .update(notesTable)
      .set({ extractedVitals: result, updatedAt: new Date() })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .catch((err) => {
        req.log.warn(
          { err, noteId },
          "Failed to persist extracted vitals — extraction still returned",
        );
      });
  }

  res.json({ ...result, source });
});

router.post("/notes/:id/send-to-ehr", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const noteId = req.params.id;
  const db = getDb();

  const rows = await db
    .select()
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  const note = rows[0];
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  if (note.status === "entered-in-error") {
    res.status(409).json({ error: "note_entered_in_error" });
    return;
  }
  // Only approved (or already-exported, for retry) notes go to the EHR.
  // Pushing a draft would let an unsigned body land in the chart — the
  // exact thing the approval step exists to prevent.
  if (note.status === "draft") {
    res.status(409).json({ error: "note_not_approved" });
    return;
  }
  // Tamper check: the stored hash must still match the body. If it
  // doesn't, refuse to push — a mismatch means the approved body has
  // been altered without going through replaces-chain, and the EHR
  // would receive content the provider never signed.
  if (note.signedNoteHash && note.signedNoteHash !== sha256Hex(note.body)) {
    req.log.error(
      { noteId },
      "send-to-ehr refused: signed hash does not match current body",
    );
    res.status(409).json({ error: "signed_hash_mismatch" });
    return;
  }

  try {
    const outcome = await pushApprovedNote(
      note,
      orgId,
      req.user?.id ?? "",
      req.log,
    );
    res.status(200).json({
      provider: outcome.provider,
      ehrDocumentRef: outcome.ehrDocumentRef,
      pushedAt: outcome.pushedAt,
      mock: outcome.mock,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EhrPushError) {
      res.status(err.status).json({ error: "ehr_push_failed", message });
      return;
    }
    res.status(500).json({ error: "ehr_push_failed", message });
  }
});

export default router;
