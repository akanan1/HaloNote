import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, notesTable } from "@workspace/db";
import { EhrPushError, pushNoteToEhr } from "./ehr-push";
import { findPatient } from "./patients";

export interface NotePushResult {
  provider: string;
  ehrDocumentRef: string;
  pushedAt: Date;
  mock: boolean;
}

export interface AutoPushLogger {
  error: (obj: object, msg: string) => void;
}

/**
 * Push an already-approved note to the EHR and persist the outcome.
 * Used by:
 *  - manual /notes/:id/send-to-ehr (after the route's own preconditions)
 *  - /notes/:id/approve when the approver has autoPushMode=after_approve
 *  - the recording pipeline's after_transcription path
 *
 * Caller must have already verified the note is in a pushable state
 * (approved or exported, hash matches if signed). Throws EhrPushError
 * on push failure with the underlying status preserved; the row's
 * `ehrError` column captures the message either way so the UI can
 * surface it without an extra query.
 */
export async function pushApprovedNote(
  noteRow: typeof notesTable.$inferSelect,
  orgId: string,
  userId: string,
  log: AutoPushLogger,
): Promise<NotePushResult> {
  const db = getDb();
  const patient = await findPatient(noteRow.patientId, orgId);
  if (!patient) {
    throw new EhrPushError("patient_not_found", 500);
  }

  let predecessorEhrRef: string | undefined;
  if (noteRow.replacesNoteId) {
    const [predecessor] = await db
      .select({ ehrDocumentRef: notesTable.ehrDocumentRef })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.id, noteRow.replacesNoteId),
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
      note: { id: noteRow.id, body: noteRow.body },
      patient,
      ...(predecessorEhrRef ? { replacesEhrRef: predecessorEhrRef } : {}),
      userId,
    });

    await db
      .update(notesTable)
      .set({
        ehrProvider: outcome.provider,
        ehrDocumentRef: outcome.ehrDocumentRef,
        ehrPushedAt: outcome.pushedAt,
        ehrError: null,
        status: "exported",
      })
      .where(
        and(
          eq(notesTable.id, noteRow.id),
          eq(notesTable.organizationId, orgId),
        ),
      );

    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, noteId: noteRow.id }, "EHR push failed");
    await db
      .update(notesTable)
      .set({ ehrError: message })
      .where(
        and(
          eq(notesTable.id, noteRow.id),
          eq(notesTable.organizationId, orgId),
        ),
      )
      .catch(() => {});
    throw err;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Server-side materialization for autoPushMode=after_transcription.
 * The recording pipeline produces a structured note body but does NOT
 * create a `notes` row (the browser usually does that via autosave).
 * In this mode we skip the round-trip: create the row, stamp it
 * approved with the right signed hash, then push.
 *
 * Returns the newly-created notes row id on success. Push failures do
 * NOT roll back the note row — the note stays in `approved` status
 * with `ehrError` set, so the provider can manually retry the send.
 */
export async function finalizeAndPushTranscribedNote(params: {
  organizationId: string;
  userId: string;
  patientId: string;
  encounterId: string | null;
  structuredBody: string;
  log: AutoPushLogger;
}): Promise<{ noteId: string; pushed: boolean; ehrError: string | null }> {
  const db = getDb();
  const hash = sha256Hex(params.structuredBody);
  const now = new Date();

  const [inserted] = await db
    .insert(notesTable)
    .values({
      organizationId: params.organizationId,
      patientId: params.patientId,
      ...(params.encounterId ? { encounterId: params.encounterId } : {}),
      authorId: params.userId,
      body: params.structuredBody,
      status: "approved",
      approvedAt: now,
      approvedByUserId: params.userId,
      signedNoteHash: hash,
      autoPushedWithoutReview: true,
    })
    .returning();
  if (!inserted) {
    throw new Error("note insert returned no row");
  }

  try {
    await pushApprovedNote(
      inserted,
      params.organizationId,
      params.userId,
      params.log,
    );
    return { noteId: inserted.id, pushed: true, ehrError: null };
  } catch (err) {
    // The note row stays around as approved-but-not-exported. The
    // browser can navigate the provider to it and surface the
    // ehrError + a manual retry button.
    const message = err instanceof Error ? err.message : String(err);
    return { noteId: inserted.id, pushed: false, ehrError: message };
  }
}
