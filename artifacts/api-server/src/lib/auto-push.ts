import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, notesTable, usersTable } from "@workspace/db";
import { EhrPushError, pushNoteToEhr } from "./ehr-push";
import { findPatient } from "./patients";
import { generateOrdersForEncounter } from "../services/order-generation";
import { trackAuditWrite } from "../middlewares/audit";

// Generate-or-reuse the per-note Idempotency-Key. The COALESCE makes
// concurrent push attempts converge on whichever key landed first, so
// a retry that races a still-in-flight first attempt produces the same
// key on the wire. Returns the key that's now persisted on the row.
async function ensureIdempotencyKey(
  noteId: string,
  orgId: string,
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const fresh = `idem_${randomUUID()}`;
  const [row] = await getDb()
    .update(notesTable)
    .set({
      ehrIdempotencyKey: sql`COALESCE(${notesTable.ehrIdempotencyKey}, ${fresh})`,
    })
    .where(
      and(eq(notesTable.id, noteId), eq(notesTable.organizationId, orgId)),
    )
    .returning({ key: notesTable.ehrIdempotencyKey });
  if (!row?.key) {
    throw new Error("failed to persist EHR idempotency key");
  }
  return row.key;
}

export interface NotePushResult {
  provider: string;
  ehrDocumentRef: string;
  pushedAt: Date;
  mock: boolean;
}

export interface AutoPushLogger {
  error: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
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

  // Lock in the idempotency key BEFORE the network call so a process
  // crash mid-call doesn't lose it. Both manual retries and the
  // transport-level 429/503 retry inside FhirClient will reuse it.
  const idempotencyKey = await ensureIdempotencyKey(
    noteRow.id,
    orgId,
    noteRow.ehrIdempotencyKey,
  );

  try {
    const outcome = await pushNoteToEhr({
      note: { id: noteRow.id, body: noteRow.body },
      patient,
      ...(predecessorEhrRef ? { replacesEhrRef: predecessorEhrRef } : {}),
      userId,
      idempotencyKey,
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

  let pushed = false;
  let pushError: string | null = null;
  try {
    await pushApprovedNote(
      inserted,
      params.organizationId,
      params.userId,
      params.log,
    );
    pushed = true;
  } catch (err) {
    // The note row stays around as approved-but-not-exported. The
    // browser can navigate the provider to it and surface the
    // ehrError + a manual retry button.
    pushError = err instanceof Error ? err.message : String(err);
  }

  // Mobile hands-off chain: once the note is locked in (whether or not
  // the EHR push itself succeeded — the order pipeline is independent
  // and may still want to run so the doctor sees the suggestions on
  // their next desktop visit), kick off order generation in the
  // background. Fire-and-forget so the recording-finalize response
  // ships immediately; the chain is tracked via the audit-write
  // counter so the integration harness drains it before TRUNCATE.
  if (params.encounterId) {
    triggerOrderGenerationInBackground({
      encounterId: params.encounterId,
      orgId: params.organizationId,
      userId: params.userId,
      log: params.log,
    });
  }

  return {
    noteId: inserted.id,
    pushed,
    ehrError: pushError,
  };
}

// Fire-and-forget wrapper around generateOrdersForEncounter. We look
// up the user's autoApproveNonMedOrders flag inside the background
// promise so the foreground caller doesn't have to wait on a roundtrip
// just to decide whether to enqueue work. The trackAuditWrite hook
// keeps the integration-test TRUNCATE waiter aware of this in-flight
// chain (same race-fix pattern as recordCoderAuditEvent).
function triggerOrderGenerationInBackground(args: {
  encounterId: string;
  orgId: string;
  userId: string;
  log: AutoPushLogger;
}): void {
  // EVERYTHING goes inside one try/catch. The integration harness can
  // TRUNCATE the users table mid-flight (between this fire-and-forget
  // returning and the IIFE actually running), and a Drizzle error from
  // the user lookup would otherwise propagate as an unhandled rejection
  // and crash the test worker. trackAuditWrite's .finally() drains the
  // pending counter regardless of outcome.
  const promise = (async () => {
    try {
      const db = getDb();
      const [user] = await db
        .select({
          autoApproveNonMedOrders: usersTable.autoApproveNonMedOrders,
        })
        .from(usersTable)
        .where(eq(usersTable.id, args.userId))
        .limit(1);
      if (!user?.autoApproveNonMedOrders) {
        // Provider isn't in mobile hands-off mode. Order suggestions
        // stay a manual step (they hit the desktop "Generate orders"
        // button when they're back at the computer).
        return;
      }
      const result = await generateOrdersForEncounter({
        encounterId: args.encounterId,
        orgId: args.orgId,
        autoApproveNonMedFor: { userId: args.userId, enabled: true },
      });
      if (result.kind === "ok" && result.autoApproved) {
        args.log.info(
          {
            encounterId: args.encounterId,
            eligible: result.autoApproved.eligibleCount,
            pushed: result.autoApproved.pushedCount,
            failed: result.autoApproved.failedCount,
            medsHeld: result.autoApproved.medicationsHeldCount,
          },
          "mobile auto-fire: orders generated + non-meds pushed",
        );
      } else if (result.kind !== "ok") {
        args.log.warn(
          { encounterId: args.encounterId, kind: result.kind },
          "mobile auto-fire: order generation skipped",
        );
      }
    } catch (err) {
      args.log.error(
        { err, encounterId: args.encounterId },
        "mobile auto-fire: order generation threw",
      );
    }
  })();
  trackAuditWrite(promise);
}
