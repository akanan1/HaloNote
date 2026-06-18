import { randomUUID } from "node:crypto";
import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Role within a single organization. Distinct from `users.role` (which
// is a global super-admin marker scoped to the HaloNote control plane,
// e.g. "founder" / "admin" of the platform itself).
//
//   owner    — created the org or was transferred ownership; can manage
//              billing, integrations, members, and delete the org.
//   admin    — same as owner minus billing + delete.
//   provider — clinician: can record encounters, generate/edit/approve
//              notes, approve orders, view billing suggestions.
//   billing  — billing specialist: reviews and approves billing codes;
//              read-only on clinical content unless `clinicalReadGranted`
//              is set on the membership row.
//   ma       — medical assistant: can prep encounters and start
//              recordings on behalf of a provider; cannot approve notes.
//   viewer   — auditor / read-only access; no edits, no exports.
//
// Stored as plain text Postgres-side so future roles don't require an
// enum migration; narrowed in TS for exhaustive pattern matching at the
// API layer.
export type OrgRole = "owner" | "admin" | "provider" | "billing" | "ma" | "viewer";

export const organizationMembersTable = pgTable(
  "organization_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `om_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").$type<OrgRole>().notNull().default("provider"),

    // Optional escape hatch for billing-role users who, in some clinics,
    // do need full clinical-record access (e.g. small practices where
    // the biller is also a nurse). Defaults to false so the principle
    // of least privilege holds.
    clinicalReadGranted: boolean("clinical_read_granted")
      .notNull()
      .default(false),

    // Soft-disable. We keep historical members on file (for audit trails
    // and authorship attribution on old notes) but `isActive = false`
    // means the user cannot act inside the org. Distinct from removing
    // the row entirely.
    isActive: boolean("is_active").notNull().default(true),

    invitedAt: timestamp("invited_at", { mode: "date", withTimezone: true }),
    joinedAt: timestamp("joined_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A user has at most one membership row per org. Re-invites update
    // the existing row in place.
    uniqueIndex("organization_members_org_user_uniq").on(
      t.organizationId,
      t.userId,
    ),
  ],
);

export type OrganizationMember = typeof organizationMembersTable.$inferSelect;
export type NewOrganizationMember =
  typeof organizationMembersTable.$inferInsert;
