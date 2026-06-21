// Generation lifecycle of the Coder workflow:
//   1. Parse the finalized note into sections.
//   2. Call the AI coding suggester with section context.
//   3. Persist a coding session row + linked billing_suggestions.
//   4. Fire-and-forget the problem-list reconciler.
//   5. Provide the read-side helpers (getLatestSession / getSessionById).
//
// Auto-trigger entry point: kickCodingForApprovedNote — fire-and-forget
// from POST /notes/:id/approve. Failures never roll back the note
// approval; the provider can re-run from the UI.

import { and, desc, eq } from "drizzle-orm";
import {
  billingSuggestionsTable,
  encounterCodingSessionsTable,
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  type BillingSuggestion,
  type EncounterCodingSession,
} from "@workspace/db";
import type { Logger } from "pino";
import { recordCoderAuditEvent } from "../lib/audit-events";
import {
  destinationFieldFor,
  normalizeSectionKey,
  suggestCoding,
  type CodingSuggestedCode,
  type CodingSuggesterInput,
} from "../lib/coding-suggester";
import { parseNoteSections } from "../lib/note-section-parser";
import { loadSessionSuggestions, sha256Hex } from "./coding-internals";
import { reconcileForCodingSession } from "./problem-list";

export type GenerateCodingResult =
  | {
      kind: "ok";
      session: EncounterCodingSession;
      suggestions: BillingSuggestion[];
    }
  | { kind: "encounter_not_found" }
  | { kind: "patient_not_found" }
  | { kind: "no_note" };

export type GetSessionResult =
  | {
      kind: "ok";
      session: EncounterCodingSession;
      suggestions: BillingSuggestion[];
    }
  | { kind: "not_found" };

export interface GenerateCodingArgs {
  orgId: string;
  encounterId: string;
  // The note that drove this coding run. If null the orchestrator will
  // look up the latest note for the encounter (used by manual re-run
  // when the caller has no specific note in hand).
  noteId: string | null;
  // Where the note came from. The /notes/:id/approve hook always passes
  // "halonote_scribe"; the Athena-ingest path passes "athena_existing".
  noteSource: "halonote_scribe" | "athena_existing";
}

export interface KickArgs {
  orgId: string;
  encounterId: string;
  noteId: string;
  log: Logger;
}

interface PersistSuggestionsArgs {
  sessionId: string;
  orgId: string;
  encounterId: string;
  codes: CodingSuggestedCode[];
}

async function persistSuggestions(
  args: PersistSuggestionsArgs,
): Promise<BillingSuggestion[]> {
  if (args.codes.length === 0) return [];
  const db = getDb();
  const rows = await db
    .insert(billingSuggestionsTable)
    .values(
      args.codes.map((c) => ({
        organizationId: args.orgId,
        encounterId: args.encounterId,
        codingSessionId: args.sessionId,
        codeSystem: c.codeSystem,
        code: c.code,
        description: c.description,
        rationale: c.rationale,
        supportingExcerpts: c.supportingExcerpts,
        documentationGaps: c.documentationGaps,
        confidence: c.confidence,
        sourceSection: normalizeSectionKey(c.sourceSection),
        destinationField: destinationFieldFor(c.codeSystem),
        hccCategory:
          c.codeSystem === "icd10" ? (c.hccCategory ?? null) : null,
        rafRelevant:
          c.codeSystem === "icd10" ? (c.rafRelevant ?? false) : false,
        createdByAi: true,
      })),
    )
    .returning();
  return rows;
}

export async function generateCoding(
  args: GenerateCodingArgs,
): Promise<GenerateCodingResult> {
  const db = getDb();

  const [encounter] = await db
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, args.encounterId),
        eq(encountersTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!encounter) return { kind: "encounter_not_found" };

  const [patient] = await db
    .select({ id: patientsTable.id, dateOfBirth: patientsTable.dateOfBirth })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, encounter.patientId),
        eq(patientsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!patient) return { kind: "patient_not_found" };

  // Resolve which note's body to code from. Caller-provided noteId
  // wins; otherwise pick the latest note on the encounter.
  let noteRow: { id: string; body: string } | null = null;
  if (args.noteId) {
    const [row] = await db
      .select({ id: notesTable.id, body: notesTable.body })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.id, args.noteId),
          eq(notesTable.organizationId, args.orgId),
        ),
      )
      .limit(1);
    if (row) noteRow = row;
  } else {
    const [row] = await db
      .select({ id: notesTable.id, body: notesTable.body })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.encounterId, args.encounterId),
          eq(notesTable.organizationId, args.orgId),
        ),
      )
      .orderBy(desc(notesTable.updatedAt))
      .limit(1);
    if (row) noteRow = row;
  }
  if (!noteRow) return { kind: "no_note" };

  // Create session in 'queued' so the UI can show a spinner immediately
  // if the caller polls. Then transition to 'extracting' around the
  // AI call so a stalled request is distinguishable from a queued one.
  const [session] = await db
    .insert(encounterCodingSessionsTable)
    .values({
      organizationId: args.orgId,
      encounterId: args.encounterId,
      noteId: noteRow.id,
      noteSource: args.noteSource,
      sourceNoteHash: sha256Hex(noteRow.body),
      status: "queued",
    })
    .returning();
  if (!session)
    throw new Error("coding-orchestrator: session insert returned no row");

  const sections = parseNoteSections(noteRow.body);

  await db
    .update(encounterCodingSessionsTable)
    .set({
      status: "extracting",
      extractionStartedAt: new Date(),
      parsedSections: sections,
      updatedAt: new Date(),
    })
    .where(eq(encounterCodingSessionsTable.id, session.id));

  let codes: CodingSuggestedCode[];
  try {
    const suggesterInput: CodingSuggesterInput = {
      encounter: {
        id: encounter.id,
        visitType: encounter.visitType,
        customLabel: encounter.customLabel,
        isTelehealth: encounter.isTelehealth,
        scheduledAt: encounter.scheduledAt,
      },
      patient,
      sections,
    };
    const { result } = await suggestCoding(suggesterInput);
    codes = result.codes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(encounterCodingSessionsTable)
      .set({
        status: "failed",
        failureReason: message,
        extractionCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(encounterCodingSessionsTable.id, session.id));
    recordCoderAuditEvent({
      organizationId: args.orgId,
      userId: null,
      action: "coder.generate.failed",
      resourceType: "coding_session",
      resourceId: session.id,
      metadata: {
        encounterId: args.encounterId,
        failureReason: message.slice(0, 300),
      },
    });
    throw err;
  }

  const suggestions = await persistSuggestions({
    sessionId: session.id,
    orgId: args.orgId,
    encounterId: args.encounterId,
    codes,
  });

  const [updated] = await db
    .update(encounterCodingSessionsTable)
    .set({
      status: "ready",
      extractionCompletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(encounterCodingSessionsTable.id, session.id))
    .returning();

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: null,
    action: "coder.generate.completed",
    resourceType: "coding_session",
    resourceId: session.id,
    metadata: {
      encounterId: args.encounterId,
      noteId: noteRow.id,
      noteSource: args.noteSource,
      suggestionCount: suggestions.length,
      hccCodeCount: suggestions.filter((s) => s.hccCategory).length,
      rafCodeCount: suggestions.filter((s) => s.rafRelevant).length,
    },
  });

  // Fire-and-forget the problem-list reconciliation so the Coder
  // Review pane loads with both code and problem-list suggestions on
  // its first poll. Failures are swallowed — coding completion is
  // the source-of-truth event; the provider can re-trigger reconcile
  // manually if it failed.
  void reconcileForCodingSession(session.id, args.orgId).catch(() => {
    /* swallowed; reconcile logs its own failures */
  });

  return {
    kind: "ok",
    session: updated ?? session,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLatestSession(
  encounterId: string,
  orgId: string,
): Promise<GetSessionResult> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(encounterCodingSessionsTable)
    .where(
      and(
        eq(encounterCodingSessionsTable.encounterId, encounterId),
        eq(encounterCodingSessionsTable.organizationId, orgId),
      ),
    )
    .orderBy(desc(encounterCodingSessionsTable.createdAt))
    .limit(1);
  if (!session) return { kind: "not_found" };
  const suggestions = await loadSessionSuggestions(session.id, orgId);
  return { kind: "ok", session, suggestions };
}

export async function getSessionById(
  sessionId: string,
  orgId: string,
): Promise<GetSessionResult> {
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
  if (!session) return { kind: "not_found" };
  const suggestions = await loadSessionSuggestions(session.id, orgId);
  return { kind: "ok", session, suggestions };
}

// ---------------------------------------------------------------------------
// Auto-trigger hook — fire-and-forget entry point for /notes/:id/approve.
// Catches its own errors so it never rolls back the note approval; logs
// a warn line so the provider can retry from the UI.
// ---------------------------------------------------------------------------

export async function kickCodingForApprovedNote(
  args: KickArgs,
): Promise<void> {
  try {
    const result = await generateCoding({
      orgId: args.orgId,
      encounterId: args.encounterId,
      noteId: args.noteId,
      noteSource: "halonote_scribe",
    });
    if (result.kind !== "ok") {
      args.log.warn(
        {
          encounterId: args.encounterId,
          noteId: args.noteId,
          reason: result.kind,
        },
        "coding auto-trigger: skipped",
      );
    }
  } catch (err) {
    args.log.warn(
      { err, encounterId: args.encounterId, noteId: args.noteId },
      "coding auto-trigger: extraction failed (provider can retry from UI)",
    );
  }
}
