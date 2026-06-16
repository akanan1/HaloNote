import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export const sessionsTable = pgTable("sessions", {
  // Random 32 hex chars (16 bytes). Generated server-side; the value lands
  // straight into the cookie.
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // Which organization this session is currently acting on behalf of.
  // Users can belong to multiple orgs; switching orgs writes a new value
  // here rather than re-issuing a session. Nullable because (a) the
  // backfill cannot set it for legacy sessions and (b) a fresh signup's
  // session exists briefly before the user is added to any org. Routes
  // that touch PHI gate on this being non-null via requireOrgMember.
  activeOrganizationId: text("active_organization_id").references(
    () => organizationsTable.id,
    { onDelete: "set null" },
  ),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
    .notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Session = typeof sessionsTable.$inferSelect;
export type NewSession = typeof sessionsTable.$inferInsert;
