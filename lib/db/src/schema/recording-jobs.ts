import { randomUUID } from "node:crypto";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";
import { patientsTable } from "./patients";
import { notesTable } from "./notes";

// Lifecycle of an ambient-scribe capture. Each provider tap of the mic
// → set of audio segments → eventual transcribed-and-structured note
// produces one row here. The terminal states (`done`, `failed`,
// `cancelled`) freeze the row; the rest are step-wise progress through
// the AI pipeline added in a later slice.
export type RecordingStatus =
  | "capturing"
  | "queued"
  | "transcribing"
  | "structuring"
  | "done"
  | "failed"
  | "cancelled";

export const recordingJobsTable = pgTable(
  "recording_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `rec_${randomUUID()}`),
    // Tenant scope; must match the user's active org and the patient's org.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The patient the recording is for. Nullable for now to make
    // unattached test captures possible — typical product flow always
    // sets it (provider taps an appointment → opens NewNote → records).
    patientId: text("patient_id").references(() => patientsTable.id, {
      onDelete: "set null",
    }),
    // The note draft this recording feeds. Nullable: the job exists
    // before any note row does, and gets linked when the worker
    // produces a structured body and we materialize a draft note.
    noteId: text("note_id").references(() => notesTable.id, {
      onDelete: "set null",
    }),
    // The encounter this recording documents. Nullable for backward
    // compatibility with legacy capture flows (recordings created
    // before Phase 1) and for capture-first workflows where the
    // encounter is selected after recording starts. The recording
    // pipeline sets this when the encounter is known so the generated
    // note can inherit it.
    encounterId: text("encounter_id").references(() => encountersTable.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<RecordingStatus>()
      .notNull()
      .default("capturing"),
    // Raw transcript from the ASR step. Populated when status passes
    // through "transcribing" → "structuring".
    transcript: text("transcript"),
    // Accumulated `is_final` transcript captured from the streaming
    // bridge during the visit. Distinct from `transcript` (above),
    // which comes from the prerecorded batch transcribe after the
    // segments upload. Useful for audit: if an auto-stop fires on a
    // verbal cue, this column has the exact text that triggered it.
    // Nullable — only populated when the streaming pipeline was used.
    liveTranscript: text("live_transcript"),
    // Structured clinical-note body produced by the LLM step. This is
    // what eventually lands in the NewNote textarea.
    structuredBody: text("structured_body"),
    // Surfaced verbatim to the UI on failure. Don't put secrets here.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (t) => [
    // Polling-friendly: "what's still in flight for this user".
    index("recording_jobs_user_status_idx").on(t.userId, t.status),
    // Looking up by patient (history of recordings for a chart) is
    // less hot but cheap to support.
    index("recording_jobs_patient_idx").on(t.patientId),
  ],
);

export type RecordingJob = typeof recordingJobsTable.$inferSelect;
export type NewRecordingJob = typeof recordingJobsTable.$inferInsert;
