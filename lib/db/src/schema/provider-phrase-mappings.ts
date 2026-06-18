import { randomUUID } from "node:crypto";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Per-provider "when I say X, document Y" overrides. The provider's
// spoken phrasing during a visit gets translated to their preferred
// documentation term in the AI-generated note. Examples:
//   spoken: "tummy ache"      → documented: "abdominal pain"
//   spoken: "high blood pressure" → documented: "hypertension"
//   spoken: "rule out"        → documented: "r/o"
//
// Distinct from the auto-generated `writingStyleProfile` on `users`:
// that profile is *learned* from the provider's writing patterns; these
// rows are *explicit* preferences the provider configures themselves.
//
// Matching is case-insensitive (enforced at the API layer + a
// LOWER(spoken) unique index here so two rows can't claim the same
// trigger). No regex / wildcards in v1 — keeps the prompt cacheable
// and the UX legible. The recording pipeline serializes these rows
// into a prompt block alongside templates and style profile.
export const providerPhraseMappingsTable = pgTable(
  "provider_phrase_mappings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `pmap_${randomUUID()}`),
    // Tenant scope; same rationale as note_templates.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The colloquial / spoken phrase as it would appear in the
    // transcript. Stored as-typed for display; matching is done
    // case-insensitively.
    spoken: text("spoken").notNull(),
    // The preferred documentation term to substitute. Free text so
    // the provider can use abbreviations ("HTN"), full clinical terms
    // ("hypertension"), or even short phrases.
    documented: text("documented").notNull(),
    // Manual ordering inside the user's list so the Settings UI can
    // be reordered. Lower values render first; tie-broken by
    // createdAt ascending.
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
    // Hot path: "all mappings for this user, ordered" — covered by
    // composite index on (user_id, sort_order) without a sort step.
    index("provider_phrase_mappings_user_order_idx").on(t.userId, t.sortOrder),
    // Provider can't have two rows for the same spoken phrase. The
    // LOWER() expression matches the case-insensitive comparison the
    // API layer performs before insert/update.
    uniqueIndex("provider_phrase_mappings_user_spoken_uniq").on(
      t.userId,
      sql`lower(${t.spoken})`,
    ),
  ],
);

export type ProviderPhraseMapping =
  typeof providerPhraseMappingsTable.$inferSelect;
export type NewProviderPhraseMapping =
  typeof providerPhraseMappingsTable.$inferInsert;
