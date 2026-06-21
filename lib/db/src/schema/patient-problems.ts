import { randomUUID } from "node:crypto";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { encounterCodingSessionsTable } from "./encounter-coding-sessions";
import { encountersTable } from "./encounters";
import { organizationsTable } from "./organizations";
import { patientsTable } from "./patients";
import { usersTable } from "./users";

// Local cache of the patient's problem list. Source of truth lives in
// the EHR (Athena's Condition resource for FHIR-connected practices);
// this table mirrors it so the Coder can reason about deltas without a
// round trip on every coding pass and so the in-app UI has something
// to render when the EHR is unreachable.
//
// Lifecycle:
//   1. Provider connects Athena → /patients/:id/problems/sync pulls
//      Condition resources, upserts here keyed on (patient, code) with
//      ehrSource='athena' and the FHIR ref.
//   2. Coder runs → reconciler diffs note ICDs vs this cache, emits
//      problem_list_suggestions for the provider to review.
//   3. Provider accepts a suggestion → mutation lands here (status
//      change / new row), and (Phase 3) writes back to Athena.
//
// Manual entries (ehrSource='manual') exist for paper-chart practices
// and pre-Athena-connection imports; they don't auto-sync.

export type ProblemStatus =
  | "active"
  | "stable"
  | "worsening"
  | "improving"
  | "resolved";

export type ProblemEhrSource = "athena" | "epic" | "cerner" | "manual";

export const patientProblemsTable = pgTable(
  "patient_problems",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `prb_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => patientsTable.id, { onDelete: "cascade" }),

    // ICD-10 code is the canonical identifier. Same patient + same code
    // → same problem, regardless of how many times it's mentioned in
    // future notes. Enforced by the unique index below.
    code: text("code").notNull(),
    description: text("description").notNull(),

    status: text("status").$type<ProblemStatus>().notNull().default("active"),

    // When the problem first appeared in the chart. ISO date string;
    // mirrors Athena's `onsetDateTime` field. Nullable because not
    // every condition has a documented onset.
    onsetDate: text("onset_date"),

    ehrSource: text("ehr_source").$type<ProblemEhrSource>().notNull(),
    // FHIR resource reference for round-tripping ("Condition/abc123").
    // Null for manual entries until they're pushed back to the EHR.
    ehrResourceRef: text("ehr_resource_ref"),
    // Timestamp of the last sync from the EHR. Stale-ness check uses
    // this; null = never synced (manual entry).
    syncedAt: timestamp("synced_at", { mode: "date", withTimezone: true }),

    // Verbatim Condition.code coding array from the last sync. Kept so
    // the Coder can see SNOMED / Athena-internal codes that pair with
    // the ICD-10 — useful if a future writeback needs to preserve the
    // upstream coding system.
    rawCoding: jsonb("raw_coding"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One row per (patient, code). Upserts on sync; reconciler joins on
    // this for "do we already have this diagnosis on the chart?".
    uniqueIndex("patient_problems_patient_code_uniq").on(t.patientId, t.code),
    index("patient_problems_org_status_idx").on(
      t.organizationId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export type PatientProblem = typeof patientProblemsTable.$inferSelect;
export type NewPatientProblem = typeof patientProblemsTable.$inferInsert;

// ---------------------------------------------------------------------------
// Reconciler output. One row per delta the reconciler proposes against
// the patient's current problem list. Linked to a coding session so the
// Coder Review UI loads suggestions + problem-list deltas as one batch.
// ---------------------------------------------------------------------------

// The action the reconciler is proposing.
//
//   add               — New diagnosis from the note; no matching row in
//                       patient_problems. Provider accept → INSERT into
//                       patient_problems with status='active'.
//   update_status     — Existing problem; the note documents a change
//                       (active → worsening, stable → improving, etc.).
//                       newStatus carries the proposed value.
//   resolve           — Existing problem; the note documents resolution.
//                       Provider accept → status='resolved' + onset
//                       gets a paired resolved-at via updatedAt.
//   merge_duplicate   — Reconciler thinks two existing rows are the
//                       same condition coded differently (e.g. E11.9
//                       and the legacy 250.00 variant from an import).
//                       targetProblemId is the one to keep;
//                       mergeFromProblemId is the duplicate to retire.
//   flag_uncertain    — Note hints at a status change but documentation
//                       is ambiguous. No automatic mutation; this exists
//                       so the provider sees the flag instead of the
//                       reconciler guessing.
export type ProblemSuggestionAction =
  | "add"
  | "update_status"
  | "resolve"
  | "merge_duplicate"
  | "flag_uncertain";

export type ProblemSuggestionStatus =
  | "suggested"
  | "accepted"
  | "rejected"
  // "applied" = accepted AND the local mutation landed (and EHR
  // writeback, when wired in Phase 3, completed). Until then,
  // 'accepted' is the terminal state.
  | "applied";

export const problemListSuggestionsTable = pgTable(
  "problem_list_suggestions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `pls_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    // Coder session that produced this suggestion. Nullable for the
    // rare manual-reconcile path (provider asks "look again now") where
    // we may not want to write a fresh session row.
    codingSessionId: text("coding_session_id").references(
      () => encounterCodingSessionsTable.id,
      { onDelete: "set null" },
    ),
    // Which patient + encounter this proposal is about.
    patientId: text("patient_id")
      .notNull()
      .references(() => patientsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),

    action: text("action").$type<ProblemSuggestionAction>().notNull(),

    // Target problem when the action operates on an existing row
    // (update_status / resolve / merge_duplicate). Null for 'add'
    // (the row doesn't exist yet) and 'flag_uncertain' (nothing to
    // operate on, just surface the gap).
    targetProblemId: text("target_problem_id").references(
      () => patientProblemsTable.id,
      { onDelete: "set null" },
    ),
    // The duplicate to retire when action = merge_duplicate. Always
    // null otherwise.
    mergeFromProblemId: text("merge_from_problem_id").references(
      () => patientProblemsTable.id,
      { onDelete: "set null" },
    ),

    // Proposed values used by 'add' (proposedCode + proposedDescription)
    // and 'update_status' / 'resolve' (proposedStatus). Null when not
    // applicable.
    proposedCode: text("proposed_code"),
    proposedDescription: text("proposed_description"),
    proposedStatus: text("proposed_status").$type<ProblemStatus>(),

    // AI rationale + supporting note excerpts — same shape the coding
    // suggester emits, so the UI reuses the existing excerpt renderer.
    rationale: text("rationale").notNull(),
    supportingExcerpts: jsonb("supporting_excerpts").notNull().default("[]"),
    confidence: text("confidence").notNull(),

    status: text("status")
      .$type<ProblemSuggestionStatus>()
      .notNull()
      .default("suggested"),
    // Free-text from the reviewer — "rejected, this dx is from her
    // mother's chart" / "accepted with status edited".
    statusNote: text("status_note"),

    // True if the local mutation has landed (patient_problems row
    // inserted/updated/retired). For Phase 2 this flips on accept;
    // Phase 3's EHR writeback will introduce a separate "ehr_written"
    // marker rather than overload this.
    appliedLocally: boolean("applied_locally").notNull().default(false),

    reviewedByUserId: text("reviewed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", {
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
    // Hot path: "the problem-list deltas for this Coder session".
    index("problem_list_suggestions_session_idx").on(t.codingSessionId),
    // Patient-scoped query for "everything ever proposed against this
    // patient's problem list" (audit-style read).
    index("problem_list_suggestions_patient_idx").on(
      t.patientId,
      t.createdAt,
    ),
    // Org queue for "all unreviewed problem-list deltas" if a future
    // dashboard wants one.
    index("problem_list_suggestions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
  ],
);

export type ProblemListSuggestion =
  typeof problemListSuggestionsTable.$inferSelect;
export type NewProblemListSuggestion =
  typeof problemListSuggestionsTable.$inferInsert;
