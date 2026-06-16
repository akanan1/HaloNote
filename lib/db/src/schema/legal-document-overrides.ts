import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Append-only DB store for legal-document versions uploaded by the
// founder at runtime. Lets the team publish a new BAA / Terms /
// Privacy without a code deploy — useful when counsel returns
// finalized text. The fs-on-disk versions in `@workspace/legal` stay
// as the seed; the resolver in api-server's routes/legal.ts prefers
// the newest DB row per type when one exists.
//
// Append-only because every historical acceptance row references a
// (type, version) — losing the body would invalidate the hash story.
// A new version is just another row; the resolver picks the highest
// `created_at` per type as "current".
export const legalDocumentOverridesTable = pgTable(
  "legal_document_overrides",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `ldoc_${randomUUID()}`),
    documentType: text("document_type").notNull(),
    version: text("version").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("legal_document_overrides_type_version_uniq").on(
      t.documentType,
      t.version,
    ),
  ],
);

export type LegalDocumentOverride =
  typeof legalDocumentOverridesTable.$inferSelect;
