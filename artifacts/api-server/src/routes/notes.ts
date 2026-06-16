import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { CreateNoteBody, UpdateNoteBody } from "@workspace/api-zod";
import {
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  usersTable,
} from "@workspace/db";
import { EhrPushError, pushNoteToEhr } from "../lib/ehr-push";
import { findPatient } from "../lib/patients";
import { getActiveOrgId } from "../lib/active-org";
import { analyzeNoteGaps } from "../lib/note-gap-analyzer";

// Statuses that lock the note body from further direct edits. Once a
// note is approved/exported/withdrawn, the only way to change the body
// is to create a successor via the FHIR replaces chain. PATCH on a
// locked note returns 409 with a stable code so the frontend can
// route the provider to "amend" instead.
const LOCKED_STATUSES = new Set<typeof notesTable.$inferSelect.status>([
  "approved",
  "exported",
  "entered-in-error",
]);

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const router: IRouter = Router();

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

// Drizzle's $inferSelect-derived row type expanded with the embedded author.
// We construct this shape explicitly in every handler so the wire response
// matches the OpenAPI `Note` schema (which has `author: NoteAuthor | null`).
const noteSelect = {
  id: notesTable.id,
  patientId: notesTable.patientId,
  encounterId: notesTable.encounterId,
  body: notesTable.body,
  createdAt: notesTable.createdAt,
  updatedAt: notesTable.updatedAt,
  authorId: notesTable.authorId,
  status: notesTable.status,
  approvedAt: notesTable.approvedAt,
  approvedByUserId: notesTable.approvedByUserId,
  signedNoteHash: notesTable.signedNoteHash,
  replacesNoteId: notesTable.replacesNoteId,
  ehrProvider: notesTable.ehrProvider,
  ehrDocumentRef: notesTable.ehrDocumentRef,
  ehrPushedAt: notesTable.ehrPushedAt,
  ehrError: notesTable.ehrError,
  authorDisplayName: usersTable.displayName,
} as const;

type NoteRow = {
  id: string;
  patientId: string;
  encounterId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  authorId: string | null;
  status: typeof notesTable.$inferSelect.status;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  signedNoteHash: string | null;
  replacesNoteId: string | null;
  ehrProvider: string | null;
  ehrDocumentRef: string | null;
  ehrPushedAt: Date | null;
  ehrError: string | null;
  authorDisplayName: string | null;
};

function serializeNote(row: NoteRow) {
  return {
    id: row.id,
    patientId: row.patientId,
    encounterId: row.encounterId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author:
      row.authorId && row.authorDisplayName
        ? { id: row.authorId, displayName: row.authorDisplayName }
        : null,
    status: row.status,
    approvedAt: row.approvedAt,
    approvedByUserId: row.approvedByUserId,
    // signedNoteHash is intentionally exposed: the frontend can show
    // a tamper-evident indicator and a downstream auditor can verify
    // a note matches the body they see by recomputing sha256.
    signedNoteHash: row.signedNoteHash,
    replacesNoteId: row.replacesNoteId,
    ehrProvider: row.ehrProvider,
    ehrDocumentRef: row.ehrDocumentRef,
    ehrPushedAt: row.ehrPushedAt,
    ehrError: row.ehrError,
  };
}

router.get("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const rows = await getDb()
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(
      and(
        eq(notesTable.id, req.params.id),
        eq(notesTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  res.json(serializeNote(row));
});

router.get("/notes", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const patientId =
    typeof req.query["patientId"] === "string"
      ? req.query["patientId"].trim() || undefined
      : undefined;
  const before = parseIsoDate(req.query["before"]);
  const limit = clampLimit(req.query["limit"]);

  // Tenant scope is always-on. Additional filters narrow within the org.
  const conditions = [eq(notesTable.organizationId, orgId)];
  if (patientId) conditions.push(eq(notesTable.patientId, patientId));
  if (before) conditions.push(lt(notesTable.createdAt, before));

  // Fetch limit+1 to know if there's another page without a separate
  // count query.
  const db = getDb();
  const rows = await db
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(notesTable.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail ? tail.createdAt.toISOString() : null;

  res.json({ data: page.map(serializeNote), nextCursor });
});

router.post("/notes", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const parsed = CreateNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  const author = req.user;
  if (!author) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  // Verify the patient belongs to the active org. A 404 (not 403) is
  // deliberate: revealing "exists but in another org" is itself a
  // cross-tenant leak.
  const [patient] = await getDb()
    .select({ id: patientsTable.id, organizationId: patientsTable.organizationId })
    .from(patientsTable)
    .where(eq(patientsTable.id, parsed.data.patientId))
    .limit(1);
  if (!patient || patient.organizationId !== orgId) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  // If replacing, verify the predecessor exists, isn't itself entered-
  // in-error, and belongs to the same org. Replacing a withdrawn note
  // would create a confusing chain; replacing across orgs would break
  // tenant isolation.
  if (parsed.data.replacesNoteId) {
    const [predecessor] = await getDb()
      .select({
        id: notesTable.id,
        status: notesTable.status,
        patientId: notesTable.patientId,
        organizationId: notesTable.organizationId,
      })
      .from(notesTable)
      .where(eq(notesTable.id, parsed.data.replacesNoteId))
      .limit(1);
    if (!predecessor || predecessor.organizationId !== orgId) {
      res.status(404).json({ error: "predecessor_not_found" });
      return;
    }
    if (predecessor.status === "entered-in-error") {
      res
        .status(409)
        .json({ error: "predecessor_entered_in_error" });
      return;
    }
    if (predecessor.patientId !== parsed.data.patientId) {
      res.status(400).json({ error: "predecessor_patient_mismatch" });
      return;
    }
  }

  // Optional encounter linkage now carried by the OpenAPI-generated
  // CreateNoteBody. Verify the encounter belongs to the same tenant and
  // patient — same 404-not-403 semantics as the patient check above.
  const encounterId = parsed.data.encounterId ?? null;
  if (encounterId) {
    const [enc] = await getDb()
      .select({
        id: encountersTable.id,
        organizationId: encountersTable.organizationId,
        patientId: encountersTable.patientId,
      })
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId))
      .limit(1);
    if (!enc || enc.organizationId !== orgId) {
      res.status(404).json({ error: "encounter_not_found" });
      return;
    }
    if (enc.patientId !== parsed.data.patientId) {
      res.status(400).json({ error: "encounter_patient_mismatch" });
      return;
    }
  }

  try {
    const inserted = await getDb()
      .insert(notesTable)
      .values({
        organizationId: orgId,
        patientId: parsed.data.patientId,
        body: parsed.data.body,
        authorId: author.id,
        ...(encounterId ? { encounterId } : {}),
        ...(parsed.data.replacesNoteId
          ? { replacesNoteId: parsed.data.replacesNoteId }
          : {}),
      })
      .returning();
    const note = inserted[0];
    if (!note) {
      throw new Error("Insert returned no row");
    }
    res.status(201).json(
      serializeNote({
        ...note,
        authorDisplayName: author.displayName,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to insert note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  const noteId = req.params.id;
  const db = getDb();

  // Pre-fetch to enforce the state machine: only `draft` notes accept
  // body edits. Approved/exported/withdrawn notes need a replaces-chain
  // amendment instead. Doing this in a separate SELECT (vs WHERE on the
  // UPDATE) lets us return a precise 409 with the locked status the
  // frontend can act on.
  const [existing] = await db
    .select({
      id: notesTable.id,
      status: notesTable.status,
      organizationId: notesTable.organizationId,
    })
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  if (LOCKED_STATUSES.has(existing.status)) {
    res.status(409).json({
      error: "note_locked",
      status: existing.status,
    });
    return;
  }

  try {
    await db
      .update(notesTable)
      .set({
        body: parsed.data.body,
        updatedAt: new Date(),
      })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      );

    // Re-read with the author join so the response includes author.
    const rows = await db
      .select(noteSelect)
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error("Note vanished between UPDATE and SELECT");
    }
    res.json(serializeNote(row));
  } catch (err) {
    req.log.error({ err, noteId }, "Failed to update note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/notes/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const noteId = req.params.id;
  // Soft delete — set status to entered-in-error. The row stays in the
  // database for audit traceability + amendment-chain integrity. Returns
  // 404 only when the row genuinely doesn't exist (in this org); re-
  // deleting an already-entered-in-error note is idempotent. Tenant-
  // scoping in the WHERE keeps cross-org deletes from succeeding.
  const result = await getDb()
    .update(notesTable)
    .set({ status: "entered-in-error", updatedAt: new Date() })
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .returning({ id: notesTable.id });
  if (result.length === 0) {
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
  const db = getDb();

  const [existing] = await db
    .select()
    .from(notesTable)
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  if (existing.status === "entered-in-error") {
    res.status(409).json({ error: "note_entered_in_error" });
    return;
  }
  if (existing.status === "exported") {
    res.status(409).json({ error: "note_already_exported" });
    return;
  }

  const hash = sha256Hex(existing.body);

  if (existing.status === "approved") {
    // Idempotent: re-approving the same body by the same approver is a
    // no-op (200). If the hash differs from what's stored, that means
    // the body was somehow mutated without going through the PATCH
    // lock — return 409 so callers notice rather than silently re-sign.
    if (existing.signedNoteHash && existing.signedNoteHash !== hash) {
      res.status(409).json({
        error: "signed_hash_mismatch",
        message: "Stored hash does not match current body; possible tampering.",
      });
      return;
    }
    const rows = await db
      .select(noteSelect)
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("Note vanished between SELECT and re-SELECT");
    res.json(serializeNote(row));
    return;
  }

  try {
    await db
      .update(notesTable)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedByUserId: approver.id,
        signedNoteHash: hash,
        updatedAt: new Date(),
      })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      );

    const rows = await db
      .select(noteSelect)
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("Note vanished between UPDATE and SELECT");
    res.json(serializeNote(row));
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

  const patient = await findPatient(note.patientId, orgId);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  // Look up the predecessor's EHR doc ref so we can stamp a relatesTo on
  // the new push. Only meaningful when the predecessor has been pushed
  // upstream; an amendment of a never-pushed note has nothing to point at.
  let predecessorEhrRef: string | undefined;
  if (note.replacesNoteId) {
    const [predecessor] = await db
      .select({ ehrDocumentRef: notesTable.ehrDocumentRef })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.id, note.replacesNoteId),
          eq(notesTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (predecessor?.ehrDocumentRef) {
      predecessorEhrRef = predecessor.ehrDocumentRef;
    }
  }

  try {
    const outcome = await pushNoteToEhr({
      note: { id: note.id, body: note.body },
      patient,
      ...(predecessorEhrRef ? { replacesEhrRef: predecessorEhrRef } : {}),
      ...(req.user?.id ? { userId: req.user.id } : {}),
    });

    await db
      .update(notesTable)
      .set({
        ehrProvider: outcome.provider,
        ehrDocumentRef: outcome.ehrDocumentRef,
        ehrPushedAt: outcome.pushedAt,
        ehrError: null,
        // Terminal state for the happy path. A retry of send-to-ehr on
        // an already-exported note is allowed (idempotent on the wire),
        // and this UPDATE is a no-op on the status column in that case.
        status: "exported",
      })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      );

    res.status(200).json({
      provider: outcome.provider,
      ehrDocumentRef: outcome.ehrDocumentRef,
      pushedAt: outcome.pushedAt,
      mock: outcome.mock,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, noteId }, "EHR push failed");

    await db
      .update(notesTable)
      .set({ ehrError: message })
      .where(
        and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
      )
      .catch(() => {
        // best-effort error capture; ignore secondary failure
      });

    if (err instanceof EhrPushError) {
      res.status(err.status).json({ error: "ehr_push_failed", message });
      return;
    }
    res.status(500).json({ error: "ehr_push_failed", message });
  }
});

function parseIsoDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function clampLimit(value: unknown): number {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(raw), MAX_PAGE_LIMIT);
}

export default router;
