import { randomUUID } from "node:crypto";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Per-provider editor-time text expansions ("dot phrases"). The provider
// types `.htn` in the note body and it expands to a stored block of
// boilerplate ("Hypertension, well-controlled on lisinopril 20 mg
// daily…"). Pure UI feature — never touches the recording or AI
// pipeline; the expansion is applied client-side by the note editor.
//
// Distinct from:
//   - note_templates: full-note skeletons inserted from a dropdown
//   - provider_phrase_mappings: spoken→documented overrides applied to
//     the transcript during AI structuring
//
// Shortcut matching is case-insensitive; we store the lowercased form
// so the LOWER() unique index has a covering value to use. The leading
// dot is NOT part of the stored shortcut — UI strips it.
export const smartPhrasesTable = pgTable(
  "smart_phrases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `smt_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The trigger token typed after the dot. Lowercased + trimmed
    // before insert; LOWER() unique index enforces no duplicates per
    // user. No leading dot, no whitespace.
    shortcut: text("shortcut").notNull(),
    // Expansion text dropped into the note. Free-form — can be a single
    // line or a multi-line block. The editor preserves the body
    // verbatim, including newlines.
    body: text("body").notNull(),
    // Optional one-line hint shown under the shortcut in the
    // autocomplete dropdown ("Hypertension assessment + plan"). Helps
    // the provider remember which shortcut does what.
    description: text("description"),
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
    // Bumped each time the expansion fires in the editor. Lets the
    // autocomplete sort by "most used" within prefix-match buckets, so
    // the provider's daily-driver phrases bubble to the top after a
    // few visits. Soft signal — purely UI ranking, no business logic.
    usageCount: integer("usage_count").notNull().default(0),
  },
  (t) => [
    // Hot path: "all phrases for this user, ranked by usage". Listing
    // returns the whole set (typically a few dozen rows), so we sort
    // in app code rather than indexing usageCount.
    index("smart_phrases_user_idx").on(t.userId, t.organizationId),
    // Case-insensitive uniqueness — `.HTN` and `.htn` are the same
    // shortcut. The API trims+lowercases before insert; this index is
    // the race-safe authority.
    uniqueIndex("smart_phrases_user_shortcut_uniq").on(
      t.userId,
      sql`lower(${t.shortcut})`,
    ),
  ],
);

export type SmartPhrase = typeof smartPhrasesTable.$inferSelect;
export type NewSmartPhrase = typeof smartPhrasesTable.$inferInsert;
