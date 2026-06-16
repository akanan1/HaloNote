import { randomUUID } from "node:crypto";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Taxonomy from the spec. Stored as text so adding new types doesn't
// require an enum migration; narrowed in TS so the API layer can
// pattern-match exhaustively (the medication safety rule below
// depends on it).
export type OrderType =
  | "lab"
  | "imaging"
  | "referral"
  | "medication"
  | "procedure"
  | "followup"
  | "instruction"
  | "dme"
  | "therapy"
  | "nursing";

export type OrderPriority = "routine" | "urgent" | "stat";

// Lifecycle of an AI-emitted order suggestion.
//
//   ai_suggested  — produced by the AI. Initial state.
//   needs_review  — provider snoozed; appears in their queue.
//   approved      — provider signed off; a row in approved_orders was
//                   created at this transition.
//   rejected      — provider explicitly declined. statusNote captures why.
//   exported      — the approved order was successfully sent downstream
//                   (EHR, prescription pad, lab system). Mirrored from
//                   the approved_orders row for fast queue queries.
export type OrderSuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "approved"
  | "rejected"
  | "exported";

// Lifecycle of an approved order (the row that actually represents what
// will be acted on).
//
//   approved      — provider signed; default state on insert.
//   export_ready  — provider (or system) declares the order ready to
//                   be submitted to the EHR / pharmacy / lab. For
//                   medications this transition REFUSES if is_complete
//                   is false (route layer enforces).
//   exported      — successfully submitted downstream. Terminal.
//   cancelled     — provider withdrew the order before submission.
//                   Terminal.
export type ApprovedOrderStatus =
  | "approved"
  | "export_ready"
  | "exported"
  | "cancelled";

// One row per AI-suggested order. The AI batch that produces these
// runs against the encounter's approved/latest note. Re-running
// creates a new batch (older rows stay for audit).
export const orderSuggestionsTable = pgTable(
  "order_suggestions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `osg_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),

    orderType: text("order_type").$type<OrderType>().notNull(),
    // Display name: "Metformin 500mg PO BID", "CBC", "Cardiology consult".
    // For medications this is the human-friendly summary; the structured
    // fields below are the authoritative source for prescription generation.
    name: text("name").notNull(),

    // Free-text clinical reason ("Diabetes management", "Rule out infection").
    indication: text("indication"),
    // Optional ICD-10 link. Surfaced from the billing module if the
    // suggester is given that context, otherwise null.
    indicationDiagnosisCode: text("indication_diagnosis_code"),

    priority: text("priority").$type<OrderPriority>().notNull().default("routine"),

    // Free-text patient-facing instructions ("Take with food", "Fasting
    // labs", "Walk-in for blood draw").
    instructions: text("instructions"),

    // Generic frequency / duration applicable to non-med orders too
    // (e.g. labs "weekly x 4 weeks", PT "2x/week for 6 weeks").
    frequency: text("frequency"),
    duration: text("duration"),

    // ----------- Medication-specific structured fields ----------------
    // Broken out as columns (not JSON) so:
    //   1. SQL can enforce constraints (is_complete check below).
    //   2. Prescription-generation code can read typed columns.
    //   3. Pharmacy-side integration can query without JSON parsing.
    // All nullable; required-ness is enforced for order_type='medication'
    // by the route layer's completeness check.
    medicationName: text("medication_name"),
    medicationDose: text("medication_dose"),
    medicationRoute: text("medication_route"),
    medicationFrequency: text("medication_frequency"),
    medicationDuration: text("medication_duration"),
    medicationQuantity: integer("medication_quantity"),
    medicationRefills: integer("medication_refills"),
    // ------------------------------------------------------------------

    // is_complete is set by the API layer at insert/update time based on
    // per-order-type rules (medication needs all of name/dose/route/
    // frequency/duration; labs/imaging just need a name). Stored so
    // the dashboard queue can filter "show me incomplete med orders".
    isComplete: boolean("is_complete").notNull().default(false),

    // Safety flags raised by the AI or the completeness check:
    //   [{ kind: "missing_field"|"dosing_ambiguous"|"interaction"|...,
    //      message: string,
    //      severity: "info"|"warn"|"block" }]
    // 'block' severity prevents the order from transitioning to
    // export_ready until cleared (route enforces).
    safetyWarnings: jsonb("safety_warnings").notNull().default("[]"),

    // The AI's explanation. Required even on stub suggestions.
    rationale: text("rationale").notNull(),

    // Verbatim excerpts from the source note backing this suggestion.
    supportingExcerpts: jsonb("supporting_excerpts").notNull().default("[]"),

    status: text("status")
      .$type<OrderSuggestionStatus>()
      .notNull()
      .default("ai_suggested"),
    statusNote: text("status_note"),

    createdByAi: boolean("created_by_ai").notNull().default(true),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Encounter detail view — orders for one visit, grouped by type.
    index("order_suggestions_encounter_idx").on(
      t.encounterId,
      t.orderType,
      t.createdAt,
    ),
    // Org queue — "all incomplete med orders across the clinic".
    index("order_suggestions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.orderType,
    ),
  ],
);

export type OrderSuggestion = typeof orderSuggestionsTable.$inferSelect;
export type NewOrderSuggestion = typeof orderSuggestionsTable.$inferInsert;

// The provider-approved order row. Separate table so AI-suggestion churn
// (regenerates, rejects) stays out of the audit trail.
export const approvedOrdersTable = pgTable(
  "approved_orders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `ord_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),

    // Nullable: a provider can add an order manually without an AI
    // suggestion (the route still creates a row here; suggestionId
    // just stays null). ON DELETE SET NULL preserves the order row
    // if the suggestion is ever purged.
    sourceSuggestionId: text("source_suggestion_id").references(
      () => orderSuggestionsTable.id,
      { onDelete: "set null" },
    ),

    orderType: text("order_type").$type<OrderType>().notNull(),
    name: text("name").notNull(),
    indication: text("indication"),
    indicationDiagnosisCode: text("indication_diagnosis_code"),
    priority: text("priority").$type<OrderPriority>().notNull().default("routine"),
    instructions: text("instructions"),
    frequency: text("frequency"),
    duration: text("duration"),

    medicationName: text("medication_name"),
    medicationDose: text("medication_dose"),
    medicationRoute: text("medication_route"),
    medicationFrequency: text("medication_frequency"),
    medicationDuration: text("medication_duration"),
    medicationQuantity: integer("medication_quantity"),
    medicationRefills: integer("medication_refills"),

    isComplete: boolean("is_complete").notNull().default(false),
    safetyWarnings: jsonb("safety_warnings").notNull().default("[]"),

    status: text("status")
      .$type<ApprovedOrderStatus>()
      .notNull()
      .default("approved"),
    statusNote: text("status_note"),

    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    approvedByUserId: text("approved_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),

    exportReadyAt: timestamp("export_ready_at", {
      mode: "date",
      withTimezone: true,
    }),
    exportedAt: timestamp("exported_at", {
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
    index("approved_orders_encounter_idx").on(t.encounterId),
    index("approved_orders_org_status_idx").on(
      t.organizationId,
      t.status,
      t.orderType,
    ),
  ],
);

export type ApprovedOrder = typeof approvedOrdersTable.$inferSelect;
export type NewApprovedOrder = typeof approvedOrdersTable.$inferInsert;
