import { randomUUID } from "node:crypto";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Per-user dictation templates. Each provider can tune the skeleton +
// voice-cue they use day-to-day; an admin doesn't gate this. Created
// lazily — on a user's first GET /templates, the server seeds the
// hardcoded default set (SOAP, H&P, Progress, Consult, Discharge) so
// no one starts with an empty list.
export const noteTemplatesTable = pgTable(
  "note_templates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `tpl_${randomUUID()}`),
    // Tenant scope. Templates remain user-owned (each provider tunes
    // their own list), but carry organization_id so a provider who
    // belongs to two orgs gets distinct template lists per org and so
    // cross-tenant reads can't surface them.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Display name shown in the dropdown ("SOAP", "Discharge", "Knee
    // injection follow-up", …). Required, max length enforced at the
    // API layer.
    name: text("name").notNull(),
    // Lowercased phrase that triggers this template when heard at the
    // start of dictation. Nullable so a template can be activated by
    // explicit selection only. Compared verbatim (after trimming +
    // lowercasing) — no regex, no wildcards.
    voiceCue: text("voice_cue"),
    // Skeleton inserted into the textarea when the template is
    // selected. May be empty for "blank/freeform" templates.
    body: text("body").notNull().default(""),
    // Manual ordering inside the user's list. Lower values render
    // first. Ties broken by createdAt ascending so reorders are
    // stable when two rows share the same sort_order.
    sortOrder: integer("sort_order").notNull().default(0),
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
    // Most queries are "all templates for this user, ordered" — a
    // composite index covers both the WHERE and the ORDER BY without
    // a sort step.
    index("note_templates_user_order_idx").on(t.userId, t.sortOrder),
    // Voice cues must be unique per user so the cue detector doesn't
    // have to break ties. Case-insensitive match enforced at the API
    // layer (we store lowercased values); the DB unique index is just
    // belt-and-suspenders against races.
    uniqueIndex("note_templates_user_cue_uniq").on(t.userId, t.voiceCue),
  ],
);

export type NoteTemplate = typeof noteTemplatesTable.$inferSelect;
export type NewNoteTemplate = typeof noteTemplatesTable.$inferInsert;
