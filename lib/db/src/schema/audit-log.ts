import { randomUUID } from "node:crypto";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export const auditLogTable = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `log_${randomUUID()}`),
    // Tenant scope. Nullable for the same reason userId is: control-plane
    // and system-originated events (seed, cron, platform admin) belong
    // to no tenant. Populated for every authenticated request via the
    // audit middleware reading session.activeOrganizationId.
    organizationId: text("organization_id").references(
      () => organizationsTable.id,
      { onDelete: "set null" },
    ),
    // userId is set when the request was authenticated; null entries are
    // reserved for system-originated events (seed, cron, etc.).
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // Stable verb describing what the user did. Examples:
    //   list_patients, view_note, create_note, update_note,
    //   send_note_to_ehr, login, logout
    action: text("action").notNull(),
    // Subject of the action. Free-form, but use snake_case singular nouns
    // (note, patient, session).
    resourceType: text("resource_type").notNull(),
    // Optional specific row identifier. Null for list endpoints.
    resourceId: text("resource_id"),
    // Free-form JSON for ad-hoc context (HTTP status, query filters, etc.).
    metadata: jsonb("metadata"),
    at: timestamp("at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("audit_log_user_at_idx").on(t.userId, t.at),
    orgIdx: index("audit_log_org_at_idx").on(t.organizationId, t.at),
    resourceIdx: index("audit_log_resource_idx").on(
      t.resourceType,
      t.resourceId,
    ),
  }),
);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;
export type NewAuditLogEntry = typeof auditLogTable.$inferInsert;
