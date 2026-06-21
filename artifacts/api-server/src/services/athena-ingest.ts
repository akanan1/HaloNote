// Athena-existing-note ingestion. For practices onboarding Coder
// WITHOUT Scribe: the provider has already documented the visit in
// Athena; we pull that finalized note and run Coder against it.
//
// Flow:
//   1. Caller supplies (encounterId, athenaDocumentReferenceId). The
//      encounter must exist locally — we don't auto-create encounters
//      from Athena here; that's a separate scheduler-sync surface.
//   2. Pull the DocumentReference via athena-note-pull (mock-mode
//      returns a stub note in dev).
//   3. Insert a local `notes` row with the pulled text, marked
//      approved + signed (the note IS finalized in Athena; locally
//      it's just a read-only mirror for coding traceability).
//   4. Generate coding with noteSource='athena_existing'. Same
//      orchestration as Scribe-driven coding, different source label
//      so the Coder Review UI can show the "from Athena" badge and
//      the audit log distinguishes the two paths.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
} from "@workspace/db";
import type { Logger } from "pino";
import { pullAthenaNote } from "../lib/athena-note-pull";
import { recordCoderAuditEvent } from "../lib/audit-events";
import { generateCoding, type GenerateCodingResult } from "./coding";

export type IngestAthenaNoteResult =
  | {
      kind: "ok";
      noteId: string;
      noteSource: "athena" | "mock";
      coding: GenerateCodingResult;
    }
  | { kind: "encounter_not_found" }
  | { kind: "patient_not_found" }
  | { kind: "athena_doc_not_found" }
  | { kind: "athena_doc_no_text" };

export interface IngestAthenaNoteArgs {
  orgId: string;
  encounterId: string;
  // Athena's DocumentReference resource id (no "DocumentReference/" prefix).
  athenaDocumentReferenceId: string;
  // The provider initiating the ingest — recorded as the local note's
  // authorId so the audit chain has a human attached even though the
  // clinical content came from Athena.
  initiatingUserId: string;
  log: Logger;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function ingestAthenaNote(
  args: IngestAthenaNoteArgs,
): Promise<IngestAthenaNoteResult> {
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
    .select()
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, encounter.patientId),
        eq(patientsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!patient) return { kind: "patient_not_found" };

  // Pull from Athena (or mock).
  const pulled = await pullAthenaNote({
    documentReferenceId: args.athenaDocumentReferenceId,
  });
  if ("kind" in pulled) {
    if (pulled.kind === "not_found") return { kind: "athena_doc_not_found" };
    if (pulled.kind === "no_text") return { kind: "athena_doc_no_text" };
  }
  // TS narrowing: pulled is now AthenaNotePullResult.
  if (!("body" in pulled)) {
    // Defensive — shouldn't reach.
    return { kind: "athena_doc_not_found" };
  }

  // Materialize the local note. Skipping the createNote() service so
  // we can set status=approved + signedNoteHash atomically (the
  // standard createNote flow always inserts as draft). The note
  // already represents a finalized chart entry — there's nothing to
  // review/approve locally.
  const now = new Date();
  const body = pulled.body;
  const [noteRow] = await db
    .insert(notesTable)
    .values({
      organizationId: args.orgId,
      patientId: patient.id,
      encounterId: args.encounterId,
      body,
      authorId: args.initiatingUserId,
      status: "approved",
      approvedAt: now,
      approvedByUserId: args.initiatingUserId,
      signedNoteHash: sha256Hex(body),
      // Mark the EHR provenance so the UI can show "Ingested from
      // Athena, DocRef <id>". Mirroring the existing ehr* columns
      // means notes from this path show up in the same "exported"
      // / "linked to EHR" surfaces as Scribe-pushed notes.
      ehrProvider: pulled.source === "athena" ? "athenahealth" : "mock",
      ehrDocumentRef: `DocumentReference/${args.athenaDocumentReferenceId}`,
      ehrPushedAt: pulled.finalizedAt ? new Date(pulled.finalizedAt) : now,
    })
    .returning({ id: notesTable.id });

  if (!noteRow) {
    args.log.error(
      { encounterId: args.encounterId },
      "ingest-athena-note: local note insert returned no row",
    );
    throw new Error("ingest-athena-note: failed to materialize local note");
  }

  // Auto-link the local encounter to its Athena parent if the pulled
  // DocumentReference cites one and we haven't linked yet. Saves the
  // provider a manual PATCH and unblocks the chart-API writeback,
  // which needs the parent Encounter ref to route diagnoses/charges.
  if (pulled.encounterEhrRef && !encounter.ehrEncounterRef) {
    await db
      .update(encountersTable)
      .set({
        ehrEncounterRef: pulled.encounterEhrRef.startsWith("Encounter/")
          ? pulled.encounterEhrRef
          : `Encounter/${pulled.encounterEhrRef}`,
        updatedAt: now,
      })
      .where(eq(encountersTable.id, args.encounterId));
  }

  args.log.info(
    {
      encounterId: args.encounterId,
      noteId: noteRow.id,
      athenaDocRef: args.athenaDocumentReferenceId,
      pullSource: pulled.source,
      autoLinkedEncounter: Boolean(
        pulled.encounterEhrRef && !encounter.ehrEncounterRef,
      ),
    },
    "ingested athena note → kicking coding",
  );

  // Kick the Coder. Different noteSource so the audit log + the UI
  // badge can distinguish.
  const coding = await generateCoding({
    orgId: args.orgId,
    encounterId: args.encounterId,
    noteId: noteRow.id,
    noteSource: "athena_existing",
  });

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.initiatingUserId,
    action: "coder.ingest.athena_note.completed",
    resourceType: "encounter",
    resourceId: args.encounterId,
    metadata: {
      noteId: noteRow.id,
      athenaDocumentReferenceId: args.athenaDocumentReferenceId,
      pullSource: pulled.source,
      autoLinkedEncounter: Boolean(
        pulled.encounterEhrRef && !encounter.ehrEncounterRef,
      ),
      codingResultKind: coding.kind,
    },
  });

  return {
    kind: "ok",
    noteId: noteRow.id,
    noteSource: pulled.source,
    coding,
  };
}
