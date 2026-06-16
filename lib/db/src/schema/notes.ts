import { randomUUID } from "node:crypto";
import { type AnyPgColumn, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export type NoteStatus = "active" | "entered-in-error";

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

  // Clinical state. "entered-in-error" is the FHIR convention for a
  // soft-deleted note — the row stays for audit + replaces-chain
  // traceability, but the UI treats it as withdrawn.
  status: text("status").$type<NoteStatus>().notNull().default("active"),

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
});

export type Note = typeof notesTable.$inferSelect;
export type NewNote = typeof notesTable.$inferInsert;
