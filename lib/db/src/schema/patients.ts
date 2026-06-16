import { date, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const patientsTable = pgTable(
  "patients",
  {
    id: text("id").primaryKey(),
    // Multi-tenant scope. Every patient belongs to exactly one organization;
    // routes filter on this column on every read and reject writes that
    // would create a cross-org row. See `requireOrgMember` in the API
    // server middlewares.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    // Postgres `date` with string mode returns the ISO date verbatim
    // ("1985-04-12"), matching the OpenAPI Patient.dateOfBirth contract.
    dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
    // No longer globally unique — same MRN can legitimately exist in two
    // different clinics. Uniqueness is now scoped to (organization_id, mrn);
    // see the unique index below.
    mrn: text("mrn").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("patients_org_mrn_uniq").on(t.organizationId, t.mrn)],
);

export type Patient = typeof patientsTable.$inferSelect;
export type NewPatient = typeof patientsTable.$inferInsert;
