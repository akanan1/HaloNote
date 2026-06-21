import { randomUUID } from "node:crypto";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { notesTable } from "./notes";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Where the note that drove this coding pass came from. Coder must
// work for both Halo-Note-Scribe-authored notes and pre-existing notes
// pulled from Athena for practices that onboard Coder without Scribe.
//
//   halonote_scribe — the note was authored in HaloNote (notes table)
//                     and finalized via the /notes/:id/approve route.
//                     The hook in that route fires the coding pass.
//   athena_existing — the note was pulled from Athena via the EHR
//                     adapter; provider never used Scribe for this
//                     visit. Coding still runs against the finalized
//                     body but the noteId may be null (Phase 4: we'll
//                     materialize a local note row when ingesting).
export type CodingNoteSource = "halonote_scribe" | "athena_existing";

// Lifecycle of one coding run against an encounter's finalized note.
// One row per Coder pass; re-running creates a new session (older
// rows stay for audit so the provider can see "what the AI thought
// last Thursday" if a code is disputed).
//
//   queued       — session created; orchestrator about to run
//                  extraction. Brief (sub-second) under normal load.
//   extracting   — AI extraction in progress. The provider sees a
//                  spinner in the Coder Review pane.
//   ready        — extraction complete; suggestions persisted with
//                  this sessionId. Awaiting clinician review.
//   approved     — clinician approved (one-by-one or bulk). The
//                  approved_billing_codes rows now reflect the
//                  approved set. Writeback may still be pending.
//   writing      — writeback to the EHR is in flight.
//   complete     — writeback succeeded; the encounter is "coded by
//                  Halo Note Coder, awaiting biller review". Terminal
//                  for the happy path.
//   failed       — extraction or writeback failed. failureReason has
//                  the message; the provider can hit re-generate.
export type CodingSessionStatus =
  | "queued"
  | "extracting"
  | "ready"
  | "approved"
  | "writing"
  | "complete"
  | "failed";

export const encounterCodingSessionsTable = pgTable(
  "encounter_coding_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `cds_${randomUUID()}`),
    // Tenant scope — must match the encounter's org.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),
    // The note that drove this coding pass. Nullable for the Athena-
    // existing path until that ingestion phase materializes local
    // note rows; the auto-fire path from /notes/:id/approve always
    // populates it.
    noteId: text("note_id").references(() => notesTable.id, {
      onDelete: "set null",
    }),
    noteSource: text("note_source").$type<CodingNoteSource>().notNull(),
    // SHA-256 hex of the note body at the moment coding ran. Lets the
    // UI flag "the note has been amended since this coding pass — the
    // suggestions may be stale" without re-hashing on every read.
    // Computed once at extraction time. nullable for the case where
    // the noteId is null (Athena raw note text not persisted yet).
    sourceNoteHash: text("source_note_hash"),

    status: text("status")
      .$type<CodingSessionStatus>()
      .notNull()
      .default("queued"),
    // Set on transitions to failed; cleared on retry. Free-form text;
    // the UI surfaces it verbatim so the provider knows what to fix.
    failureReason: text("failure_reason"),

    // Sectionized note as parsed by note-section-parser. Stored on the
    // session so the Coder Review pane can highlight which section a
    // supporting excerpt came from without re-parsing. Shape:
    //   { assessment?: string, plan?: string, hpi?: string, ros?: string,
    //     physicalExam?: string, procedures?: string, orders?: string,
    //     mdm?: string, time?: string, other?: string }
    parsedSections: jsonb("parsed_sections"),

    // Lifecycle timestamps. extractionStartedAt and extractionCompletedAt
    // bracket the AI call; approvedAt is set on the bulk-approve
    // transition; writebackStartedAt/CompletedAt bracket the EHR push.
    extractionStartedAt: timestamp("extraction_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    extractionCompletedAt: timestamp("extraction_completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    approvedAt: timestamp("approved_at", {
      mode: "date",
      withTimezone: true,
    }),
    approvedByUserId: text("approved_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    writebackStartedAt: timestamp("writeback_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    writebackCompletedAt: timestamp("writeback_completed_at", {
      mode: "date",
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Hot path: "the latest Coder session for this encounter" — the
    // Coder Review pane loads exactly this.
    index("encounter_coding_sessions_encounter_idx").on(
      t.encounterId,
      t.createdAt,
    ),
    // Org-scoped queue for the biller dashboard: "encounters coded by
    // Coder, status=complete, no biller approval yet".
    index("encounter_coding_sessions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
  ],
);

export type EncounterCodingSession =
  typeof encounterCodingSessionsTable.$inferSelect;
export type NewEncounterCodingSession =
  typeof encounterCodingSessionsTable.$inferInsert;
