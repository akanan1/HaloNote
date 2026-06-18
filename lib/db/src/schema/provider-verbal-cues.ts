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

// Per-provider verbal end-cues — phrases the streaming transcription
// bridge watches for during a visit and uses to auto-stop the
// recorder. Matched case-insensitively as a substring against each
// `is_final` Deepgram event. Example: "take care now" hits "alright
// then, take care now and follow up in two weeks."
//
// Empty list → bridge falls back to a hardcoded default list (see
// streaming-transcript.ts). The provider can curate by adding rows
// here or, when they want a clean slate, delete all rows and let the
// defaults take over again.
export const providerVerbalCuesTable = pgTable(
  "provider_verbal_cues",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `vcue_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The phrase as the provider wrote it. Display copy preserves
    // their casing; matching lower-cases both sides before comparison.
    phrase: text("phrase").notNull(),
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
    // Hot path: "all cues for this user". Small list (typically 4-10
    // rows), composite index covers the WHERE without a sort step.
    index("provider_verbal_cues_user_idx").on(t.userId, t.organizationId),
    // Same provider can't add the same phrase twice (case-insensitive).
    uniqueIndex("provider_verbal_cues_user_phrase_uniq").on(
      t.userId,
      sql`lower(${t.phrase})`,
    ),
  ],
);

export type ProviderVerbalCue = typeof providerVerbalCuesTable.$inferSelect;
export type NewProviderVerbalCue =
  typeof providerVerbalCuesTable.$inferInsert;
