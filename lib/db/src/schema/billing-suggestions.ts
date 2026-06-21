import { randomUUID } from "node:crypto";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Code system this suggestion belongs to.
//
//   icd10    — diagnosis (ICD-10-CM, US clinical modification)
//   cpt      — procedure / E&M code (CPT, AMA)
//   em       — special-case E&M level surfacer; technically a CPT code
//              (99202-99205, 99212-99215, etc) but kept as its own
//              system because the surfacing UX is different (single
//              "what level?" radio vs a free list) and the AI
//              suggester emits exactly one of these per encounter.
//   modifier — CPT modifier (e.g. "25" significant, separately
//              identifiable E&M; "95" telehealth)
export type CodeSystem = "icd10" | "cpt" | "em" | "modifier";

// Confidence band on a suggestion. Three levels intentionally — five
// would be more granular than the underlying signal supports and
// would make the UX harder to act on.
export type SuggestionConfidence = "low" | "medium" | "high";

// Lifecycle of a single billing suggestion.
//
//   ai_suggested      — produced by the AI suggester. Initial state.
//   needs_review      — provider has looked at it but deferred (e.g.
//                       waiting on labs or a referral). Acts as a
//                       per-suggestion "snooze" so the dashboard's
//                       queue stays clean.
//   provider_approved — provider signed off; a row in
//                       approved_billing_codes was created at this
//                       transition.
//   biller_approved   — billing specialist has done the final review
//                       on the approved_billing_codes row. The
//                       suggestion's status mirrors that for fast
//                       queue queries — the approved_billing_codes
//                       row remains the source of truth for what
//                       leaves the system.
//   rejected          — provider explicitly rejected this code. Kept
//                       on file so the AI doesn't re-suggest it on
//                       a regenerate, and so audit can see what was
//                       deliberately not coded.
//   exported          — the linked approved code was pushed to the
//                       practice management / clearinghouse.
export type SuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "provider_approved"
  | "biller_approved"
  | "rejected"
  | "exported";

// One row per AI-suggested code on an encounter. The AI batch that
// produces these runs against the encounter's transcript + approved
// note; re-running creates a new batch (older rows stay for audit,
// but the UI hides them once a fresh batch lands).
export const billingSuggestionsTable = pgTable(
  "billing_suggestions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `bsg_${randomUUID()}`),
    // Tenant scope — must match the encounter's org. Cascade on org
    // delete; encounter delete cascades through this row too.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),

    codeSystem: text("code_system").$type<CodeSystem>().notNull(),
    // The code itself ("E11.9", "99213", "25"). Stored verbatim so
    // version diffs in the underlying taxonomy don't lose information.
    code: text("code").notNull(),
    // Human-readable description ("Type 2 diabetes mellitus without
    // complications"). Surfaced as-is in the billing UI; not used as
    // an authority for the code's meaning (the code is).
    description: text("description").notNull(),

    // The AI's explanation: "why this code". Free-form, surfaced
    // verbatim. Required even on stub suggestions so the provider
    // always sees a reason — "stub" rationale is honest about its
    // source.
    rationale: text("rationale").notNull(),

    // Array of excerpts from the source note / transcript that
    // back this suggestion. Each entry: { text, locationHint?:
    // "HPI" | "Assessment" | "Plan" | "ROS" | ... }. JSON because
    // the per-row count is small (1-3 typically) and the shape is
    // exclusively read by the billing UI — no SQL filtering on it.
    supportingExcerpts: jsonb("supporting_excerpts").notNull().default("[]"),

    // Array of doc gaps the AI noticed that, if addressed, would
    // strengthen the code (e.g. "no time documented for time-based
    // E&M", "diabetes severity not specified"). Shape:
    //   [{ field: string, message: string, severity: "info"|"warn"|"block" }]
    // "block" gaps prevent the provider from approving the code
    // until addressed (enforced at the route layer).
    documentationGaps: jsonb("documentation_gaps").notNull().default("[]"),

    confidence: text("confidence").$type<SuggestionConfidence>().notNull(),

    // Coder workflow fields (nullable for backward compatibility with
    // pre-Coder rows). Populated when the suggestion is produced by the
    // coding-orchestrator (which wraps this suggester with section
    // awareness, HCC flagging, and per-encounter session tracking).
    // Legacy suggestions from the standalone /billing/suggest route
    // leave these null and behave exactly as before.
    //
    // codingSessionId — FK to encounter_coding_sessions. One session row
    // per generation run; lets the UI show "the Coder's latest pass"
    // as a coherent batch and gives the bulk-approve action something
    // to scope on.
    codingSessionId: text("coding_session_id"),
    // sourceSection — which note section the AI cited for this code.
    // One of: "assessment" | "plan" | "hpi" | "ros" | "physical_exam"
    // | "procedures" | "orders" | "mdm" | "time" | "other". Free-form
    // text (not an enum) so future section additions don't require a
    // migration. The orchestrator's prompt biases ICDs to assessment
    // and CPT/E&M to procedures+mdm+time but does not enforce.
    sourceSection: text("source_section"),
    // destinationField — which Athena (or other EHR) discrete field
    // this code is destined for once approved. Examples:
    //   "athena.encounter_diagnosis"
    //   "athena.encounter_procedure"
    //   "athena.problem_list"
    //   "athena.em_level"
    //   "athena.modifier"
    // Surfaced in the Coder Review UI so the clinician sees exactly
    // where the writeback will land. Stored as text (not enum) so the
    // adapter layer can evolve targets without schema churn.
    destinationField: text("destination_field"),
    // Provider may edit a suggestion's code/description before approving
    // (e.g. AI suggested E11.9 but provider knows it should be E11.65).
    // The original code/description above stays intact for audit; these
    // overrides are what gets written to approved_billing_codes. Both
    // null = no edit, use code/description as-is.
    editedCode: text("edited_code"),
    editedDescription: text("edited_description"),
    // HCC / RAF capture. hccCategory is the HCC mapping when the AI
    // believes this ICD-10 maps to an HCC bucket (e.g. "HCC 18 — Diabetes
    // with Chronic Complications"). rafRelevant is the simpler boolean
    // surface used by the dashboard's "risk-adjustment opportunity" badge.
    // Both null/false for non-diagnosis codes.
    hccCategory: text("hcc_category"),
    rafRelevant: boolean("raf_relevant").notNull().default(false),

    status: text("status")
      .$type<SuggestionStatus>()
      .notNull()
      .default("ai_suggested"),

    // Distinguishes AI-produced suggestions from manually-entered
    // ones (a billing specialist adding a code the AI missed). Always
    // true today; reserved for the manual-add flow that ships with
    // the biller dashboard.
    createdByAi: boolean("created_by_ai").notNull().default(true),

    // Free-text note from whoever set the current status. Used for
    // rejections ("not documented", "wrong dx") and biller annotations.
    // Not surfaced to the AI on regenerate to avoid drift.
    statusNote: text("status_note"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Hot path: "all suggestions for this encounter, by code system,
    // newest batch first". Covers the billing tab's main query.
    index("billing_suggestions_encounter_idx").on(
      t.encounterId,
      t.codeSystem,
      t.createdAt,
    ),
    // Org-scoped queries for the billing dashboard ("everything needing
    // review across this clinic").
    index("billing_suggestions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    // Coder Review query: "the suggestions belonging to this session"
    // ordered for the review pane.
    index("billing_suggestions_session_idx").on(
      t.codingSessionId,
      t.codeSystem,
    ),
  ],
);

export type BillingSuggestion = typeof billingSuggestionsTable.$inferSelect;
export type NewBillingSuggestion = typeof billingSuggestionsTable.$inferInsert;

// Approved codes — what the encounter is actually being billed for.
// Decoupled from billing_suggestions so:
//   1. AI-suggestion noise stays separate from the final audit trail.
//   2. A code can be approved without an AI suggestion behind it
//      (manual adds by a biller).
//   3. Re-running the AI suggester doesn't risk mutating the approved
//      set.
//
// On provider approval of a suggestion: a row lands here with
// sourceSuggestionId pointing back to the suggestion.
// On biller approval: billerApprovedAt + billerApprovedByUserId fill in.
// On export to the clearinghouse / practice management system:
// exportedAt fills in.
export const approvedBillingCodesTable = pgTable(
  "approved_billing_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `bcd_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id")
      .notNull()
      .references(() => encountersTable.id, { onDelete: "cascade" }),

    codeSystem: text("code_system").$type<CodeSystem>().notNull(),
    // The code/description that gets billed. When a provider edited a
    // suggestion before approving, this is the EDITED value, not the
    // AI's original — the suggestion row keeps the original for audit.
    code: text("code").notNull(),
    description: text("description").notNull(),

    // True when the approved code differs from the AI's original
    // suggestion (i.e. provider edited before approval). Drives the
    // "edited from AI suggestion" badge in the biller view so the
    // biller knows to scrutinize the override.
    wasEditedBeforeApproval: boolean("was_edited_before_approval")
      .notNull()
      .default(false),

    // Nullable: a biller can add a code manually without a suggestion.
    // ON DELETE SET NULL because we want to preserve the approved code
    // even if the suggestion is purged.
    sourceSuggestionId: text("source_suggestion_id").references(
      () => billingSuggestionsTable.id,
      { onDelete: "set null" },
    ),

    // Provider sign-off — required for the row to exist. Captured at
    // insertion time. Nullable on the column for backfill/migration
    // safety only; the route layer enforces non-null on insert.
    approvedAt: timestamp("approved_at", {
      mode: "date",
      withTimezone: true,
    }),
    approvedByUserId: text("approved_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),

    // Optional second sign-off by a billing specialist. Tracks the
    // "biller has reviewed the provider's codes" step before export.
    billerApprovedAt: timestamp("biller_approved_at", {
      mode: "date",
      withTimezone: true,
    }),
    billerApprovedByUserId: text("biller_approved_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),

    // Set when the code is pushed to the practice management system /
    // clearinghouse. Once non-null, the row is terminal — edits go
    // through a separate amendment flow.
    exportedAt: timestamp("exported_at", {
      mode: "date",
      withTimezone: true,
    }),
    // EHR-side reference returned after a successful push (FHIR Claim
    // or charge-row identifier). Same shape as notes.ehrDocumentRef.
    ehrDocumentRef: text("ehr_document_ref"),
    // Most recent push error. Surfaced in the billing UI for retry.
    ehrError: text("ehr_error"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("approved_billing_codes_encounter_idx").on(t.encounterId),
    index("approved_billing_codes_org_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);

export type ApprovedBillingCode =
  typeof approvedBillingCodesTable.$inferSelect;
export type NewApprovedBillingCode =
  typeof approvedBillingCodesTable.$inferInsert;
