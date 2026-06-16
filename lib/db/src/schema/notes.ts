import { randomUUID } from "node:crypto";
import {
  type AnyPgColumn,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Review + approval lifecycle. Distinct from the recording-job state
// (which tracks the AI pipeline producing the body). Once the body
// exists, the note enters this lifecycle:
//
//   draft           — provider-editable; can be regenerated, rewritten,
//                     replaced. AI suggestions land here. Default.
//   approved        — provider signed off; body is locked. approved_at,
//                     approved_by_user_id, and signed_note_hash are set.
//                     Edits after this point go through the FHIR
//                     replaces-chain (a new note that supersedes this).
//   exported        — pushed to EHR successfully (ehr_pushed_at also set,
//                     kept in sync). Terminal for the happy path.
//   entered-in-error — FHIR's withdrawal status. Row stays for audit +
//                     supersession traceability but the UI treats it as
//                     withdrawn. Terminal.
//
// "active" is kept in the union for one release so existing rows that
// haven't been migrated read cleanly; migration 0023 backfills active
// → approved. After that, "active" is unused — kept in TS for
// historical chain reads only.
export type NoteStatus =
  | "draft"
  | "approved"
  | "exported"
  | "entered-in-error"
  | "active";

export const notesTable = pgTable("notes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => `note_${randomUUID()}`),
  // Tenant scope; matches the patient's organization. Enforced at the
  // route layer on every create/read/update.
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull(),
  // Encounter the note documents. Nullable because (a) retroactive
  // documentation (a note added later for a visit that wasn't captured)
  // is supported, and (b) the migration backfill creates one encounter
  // per legacy note but newly-recorded notes attach to an encounter
  // produced by the recording pipeline. New notes from the AI flow
  // SHOULD always have one — the route validates non-null when the
  // request originates from a recording.
  encounterId: text("encounter_id").references(() => encountersTable.id, {
    onDelete: "set null",
  }),
  body: text("body").notNull(),
  // Nullable because notes predating auth wiring have no author.
  authorId: text("author_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  // mode: "date" returns a JS Date which JSON.stringify renders as ISO 8601,
  // matching the OpenAPI `format: date-time` contract on the wire.
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  // Set on every PATCH; equal to createdAt for new rows.
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),

  // Review/approval lifecycle. See NoteStatus above.
  status: text("status").$type<NoteStatus>().notNull().default("draft"),

  // ----------- Provider sign / approval --------------------------
  // Set when the note transitions draft → approved. After that, all
  // three are immutable until the note is withdrawn.
  approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
  approvedByUserId: text("approved_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  // SHA-256 of the body at the moment of approval, hex-encoded.
  // Tamper-evident lock: any later mutation to body without going
  // through the FHIR replaces chain would mismatch this hash and the
  // route layer refuses the write. Computed server-side, not from the
  // wire.
  signedNoteHash: text("signed_note_hash"),
  // ---------------------------------------------------------------

  // Self-FK for FHIR's amendment model: a new note can `replace` an
  // older one. The original is preserved untouched; the new note is
  // its supersession. ON DELETE SET NULL because hard-deleting a
  // replaced note would orphan the chain — but we don't hard-delete
  // notes anyway, so this only fires if an admin SQLs a row out.
  replacesNoteId: text("replaces_note_id").references(
    (): AnyPgColumn => notesTable.id,
    { onDelete: "set null" },
  ),

  // EHR push tracking. Populated after a successful POST to the EHR.
  ehrProvider: text("ehr_provider"),
  ehrDocumentRef: text("ehr_document_ref"),
  ehrPushedAt: timestamp("ehr_pushed_at", { mode: "date", withTimezone: true }),
  ehrError: text("ehr_error"),

  // Persisted vitals from the AI extractor (Phase 17). Written by
  // POST /notes/:id/extract-vitals when source='ai' AND status='draft'
  // — stub extractions don't write because they return nothing
  // meaningful, and approved/exported notes are locked anyway.
  // Shape mirrors VitalsResult from lib/vital-extractor.ts:
  //   { bp?, heartRate?, respiratoryRate?, temperatureF?, spo2Percent?,
  //     weightLbs?, heightIn?, bmi?, pain?, other[] }
  // Stored as JSONB so the shape can evolve without migrations and
  // the longitudinal-trends query can index into it with the ->>
  // operator (e.g. extracted_vitals -> 'bp' -> 'systolic').
  extractedVitals: jsonb("extracted_vitals"),
});

export type Note = typeof notesTable.$inferSelect;
export type NewNote = typeof notesTable.$inferInsert;
