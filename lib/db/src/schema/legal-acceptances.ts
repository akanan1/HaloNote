import { randomUUID } from "node:crypto";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Audit-grade record of every legal agreement acceptance.
//
// Design intent: append-only. Rows are written when a user clicks
// "accept" and are NEVER updated. Withdrawing consent is modeled as
// a separate row with documentType "<type>-withdrawn" (not
// implemented in v1; flagged for future). This shape gives the
// compliance auditor a chronological tape they can replay.
//
// The `contentHash` column is what makes this defensible. Each row
// pins the SHA-256 of the markdown text the user actually saw at
// acceptance time. The same hash is computed on read against the
// in-repo text (`@workspace/legal`). If they ever disagree, the
// record is no longer trustworthy and the discrepancy surfaces
// loudly via the verify script — far better than silent drift.
//
// Network attribution (`ipAddress`, `userAgent`) is recorded for the
// same reason: an auditor wants to see WHERE the click came from,
// not just THAT it happened. We accept that these may be spoofable
// — they're audit evidence, not a security control.
export const legalAcceptancesTable = pgTable(
  "legal_acceptances",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `lact_${randomUUID()}`),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Document family: "baa" | "terms" | "privacy". Stored as text so
    // we can add new families without a schema migration; the @workspace/legal
    // type union remains the source of truth.
    documentType: text("document_type").notNull(),
    // Version of the document the user accepted (e.g. "1.0"). Matches
    // a file `<type>-v<version>.md` in @workspace/legal/documents.
    version: text("version").notNull(),
    // SHA-256 (hex) of the markdown bytes at acceptance time. Used to
    // detect drift between this record and the in-repo source.
    contentHash: text("content_hash").notNull(),
    // Network attribution. Nullable because not every code path that
    // could conceivably write here has access to the request (e.g.
    // future CLI back-fills). The acceptance route always sets them.
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    acceptedAt: timestamp("accepted_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Hot path on the acceptance check: "what's the latest acceptance
    // for this user × document_type?" — covered by a composite index
    // on (user_id, document_type, accepted_at).
    index("legal_acceptances_user_type_time_idx").on(
      t.userId,
      t.documentType,
      t.acceptedAt,
    ),
  ],
);

export type LegalAcceptance = typeof legalAcceptancesTable.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptancesTable.$inferInsert;
