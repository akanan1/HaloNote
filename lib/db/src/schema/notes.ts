import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const notesTable = pgTable("notes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => `note_${randomUUID()}`),
  patientId: text("patient_id").notNull(),
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

  // EHR push tracking. Populated after a successful POST to the EHR.
  ehrProvider: text("ehr_provider"),
  ehrDocumentRef: text("ehr_document_ref"),
  ehrPushedAt: timestamp("ehr_pushed_at", { mode: "date", withTimezone: true }),
  ehrError: text("ehr_error"),
});

export type Note = typeof notesTable.$inferSelect;
export type NewNote = typeof notesTable.$inferInsert;
