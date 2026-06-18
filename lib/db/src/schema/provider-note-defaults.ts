import { randomUUID } from "node:crypto";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Per-provider "encounter defaults" — assumptions the AI bakes into
// every generated note unless the transcript explicitly contradicts
// them. Examples a provider might add:
//
//   label: "ROS default"
//   rule:  "If the review of systems is not explicitly addressed,
//          document a 14-point ROS as negative except as noted in
//          the HPI."
//
//   label: "Vital signs"
//   rule:  "Always include a Vitals block in Objective with BP, HR,
//          RR, T, SpO2. Use placeholders ('—') when values are not
//          spoken during the visit."
//
//   label: "Default exam — adult well visit"
//   rule:  "When the visit type is 'well visit' or 'annual', include
//          a normal head-to-toe physical exam template with each
//          section marked WNL unless contradicted."
//
// Distinct from `note_templates` (which dictate section *structure*),
// `provider_phrase_mappings` (which substitute spoken phrases), and
// `users.writingStyleProfile` (which describes the provider's voice).
// Defaults add *content assumptions* — they say "fill in X unless you
// hear otherwise". They feed Claude in the recording pipeline as a
// per-provider cached prompt block alongside the other personalization
// layers.
//
// No category column in v1: a free-form list keeps the UI legible and
// gives Claude the full instruction without us imposing a taxonomy
// that won't survive specialty differences.
export const providerNoteDefaultsTable = pgTable(
  "provider_note_defaults",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `ndef_${randomUUID()}`),
    // Tenant scope; same rationale as note_templates.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Short label shown in the Settings UI ("ROS default", "Standard
    // vitals", "Default A&P framework"). Not fed verbatim to Claude
    // — only the `rule` is — but kept short for the list view.
    label: text("label").notNull(),
    // The full instruction handed to Claude as part of the provider
    // context block. Phrased imperatively from the provider's POV
    // ("Always document..."). Multi-line allowed; the API layer
    // caps length to keep the prompt manageable.
    rule: text("rule").notNull(),
    // Manual ordering inside the user's list. Text-typed to match
    // the convention in provider_phrase_mappings.
    sortOrder: text("sort_order").notNull().default("0"),
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
  },
  (t) => [
    index("provider_note_defaults_user_order_idx").on(t.userId, t.sortOrder),
  ],
);

export type ProviderNoteDefault =
  typeof providerNoteDefaultsTable.$inferSelect;
export type NewProviderNoteDefault =
  typeof providerNoteDefaultsTable.$inferInsert;
