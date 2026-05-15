import { randomUUID } from "node:crypto";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { recordingJobsTable } from "./recording-jobs";

// One row per audio blob the browser uploaded for a given recording
// job. Storage layer owns the actual bytes; this table only carries
// the pointer + metadata the worker needs (mime, duration, ordering).
//
// Cascade-delete from the parent job: discarding a recording removes
// the segments with it. The storage adapter is responsible for
// deleting the underlying bytes (the cascade only clears the DB row).
export const recordingSegmentsTable = pgTable(
  "recording_segments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `seg_${randomUUID()}`),
    recordingJobId: text("recording_job_id")
      .notNull()
      .references(() => recordingJobsTable.id, { onDelete: "cascade" }),
    // Position in the sequence — segments are concatenated in this
    // order at transcription time, so it has to be stable.
    ordinal: integer("ordinal").notNull(),
    // Storage adapter's opaque path/key. For the local-filesystem
    // adapter it's a relative path under the configured root; for
    // Supabase Storage it's bucket-relative.
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // Best-effort duration reported by the browser. Used only for UI
    // display + a sanity-check total against the actual decoded audio
    // later — the transcription service is the source of truth on
    // duration for downstream pricing/billing.
    durationMs: integer("duration_ms").notNull(),
    uploadedAt: timestamp("uploaded_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Hot path: "give me all the segments for this job, in order."
    index("recording_segments_job_ordinal_idx").on(
      t.recordingJobId,
      t.ordinal,
    ),
  ],
);

export type RecordingSegment = typeof recordingSegmentsTable.$inferSelect;
export type NewRecordingSegment = typeof recordingSegmentsTable.$inferInsert;
