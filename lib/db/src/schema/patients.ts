import { date, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const patientsTable = pgTable("patients", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  // Postgres `date` with string mode returns the ISO date verbatim
  // ("1985-04-12"), matching the OpenAPI Patient.dateOfBirth contract.
  dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
  mrn: text("mrn").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Patient = typeof patientsTable.$inferSelect;
export type NewPatient = typeof patientsTable.$inferInsert;
