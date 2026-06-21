import { randomUUID } from "node:crypto";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { patientsTable } from "./patients";
import { usersTable } from "./users";

// The clinical-visit envelope a note + recording + (later) billing +
// orders all belong to. Created when a provider starts capturing for a
// patient, finalized when the note is approved. Status drives the
// provider dashboard's "what needs my attention" queues.
//
//   scheduled    — appointment exists, no work done yet
//   in_progress  — recording started OR provider is actively documenting
//   completed    — note approved, work done (still editable as an
//                  amendment via the existing FHIR replaces chain on notes)
//   cancelled    — visit didn't happen; no PHI carried over
//
// Stored as plain text Postgres-side so new statuses don't require an
// enum migration; narrowed in TS for exhaustive pattern matching.
export type EncounterStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

// Visit-type taxonomy from the spec. Used by the AI to pick the right
// note template + billing prompt, and by the billing module to bias
// E/M code suggestions (new vs established, time-based eligibility).
//
// "custom" is the escape hatch for visit types the taxonomy hasn't
// caught up to — the provider supplies a free-text `customLabel`.
// Stored as text so adding new entries is a config-only change.
export type VisitType =
  | "new_patient"
  | "established_patient"
  | "follow_up"
  | "annual_physical"
  | "hospital_follow_up"
  | "procedure"
  | "telehealth"
  | "nursing_facility"
  | "custom";

export const encountersTable = pgTable("encounters", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => `enc_${randomUUID()}`),
  // Tenant scope; must match the patient's organization. Routes enforce
  // this via getActiveOrgId + cross-org lookups → 404.
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  patientId: text("patient_id")
    .notNull()
    .references(() => patientsTable.id, { onDelete: "cascade" }),
  // The provider responsible for the encounter. Nullable so a medical
  // assistant can pre-create an encounter for the schedule without
  // immediately knowing which provider will see the patient (covered
  // visits, drop-ins). Set to the recording provider's id when audio
  // capture starts.
  providerId: text("provider_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),

  visitType: text("visit_type").$type<VisitType>().notNull(),
  // Free-text label used only when visitType = "custom". Otherwise null.
  // Surfaced verbatim in the AI prompt so the model knows what to bias
  // the note template toward.
  customLabel: text("custom_label"),

  status: text("status")
    .$type<EncounterStatus>()
    .notNull()
    .default("scheduled"),

  // Telehealth flag separate from visitType so a follow-up done over
  // telehealth still gets its visit-type semantics for billing while
  // also picking up the telehealth modifier (CPT 95) downstream.
  isTelehealth: boolean("is_telehealth").notNull().default(false),

  // Free-text site of service ("Main clinic", "Room 3", "Patient home").
  // Not parsed — surfaced verbatim on the encounter view + in audit
  // metadata.
  location: text("location"),

  // Scheduled timing. Both nullable: a walk-in encounter has no
  // scheduled time, only a startedAt; a no-show has a scheduledAt but
  // no startedAt/completedAt before being marked cancelled.
  scheduledAt: timestamp("scheduled_at", {
    mode: "date",
    withTimezone: true,
  }),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
  completedAt: timestamp("completed_at", {
    mode: "date",
    withTimezone: true,
  }),

  // EHR-side Encounter identifier — the upstream chart's encounter id
  // that this local row mirrors. Stored as a FHIR-style reference
  // ("Encounter/12345") to mirror notes.ehrDocumentRef and
  // approved_orders.ehrDocumentRef shape, so downstream consumers
  // (push adapters, audit log labels) see the same convention across
  // resources. Nullable: encounters created locally (provider
  // initiates a walk-in, no Athena round-trip) won't have one until a
  // scheduler-sync or explicit link writes it. Athena-imported and
  // dev-sandbox-pulled encounters set this at create time. The chart
  // writeback (POST /v1/.../chart/encounter/{id}/{...}) reads this to
  // route diagnoses + charges to the correct parent encounter.
  ehrEncounterRef: text("ehr_encounter_ref"),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Encounter = typeof encountersTable.$inferSelect;
export type NewEncounter = typeof encountersTable.$inferInsert;
