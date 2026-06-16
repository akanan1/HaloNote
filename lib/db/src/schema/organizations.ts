import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// A clinic / practice / hospital system. Every PHI-bearing row in the
// database is scoped to exactly one organization. Cross-org reads are
// rejected at the route layer (see `requireOrgMember`). New signups
// either create an org (becoming its owner) or accept an invite to an
// existing one.
//
// `slug` is a short, URL-safe identifier used in tenant-aware URLs and
// invite links. It is NOT a secret — uniqueness is for routing, not
// authorization. Authorization always goes through `organization_members`.
export const organizationsTable = pgTable(
  "organizations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `org_${randomUUID()}`),
    name: text("name").notNull(),
    slug: text("slug").notNull(),

    // Free-form clinical specialty label ("primary care", "endocrinology",
    // "cardiology"). Used to bias the default note template and the AI
    // billing prompt; not a hard taxonomy because clinics drift across
    // specialties and we don't want to fight that.
    specialty: text("specialty"),

    // Optional clinic identifiers. NPI is public registry data so plaintext
    // is fine. Tax ID (EIN) is sensitive; flagged here for later envelope
    // encryption when payouts wiring lands.
    npi: text("npi"),
    taxId: text("tax_id"),

    // Free-form postal address. Split into fields rather than a single
    // blob so we can later format per locale and pre-fill EHR records.
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft-delete marker. Org rows are never physically removed so the
    // audit trail stays intact; routes filter `deletedAt IS NULL`.
    deletedAt: timestamp("deleted_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (t) => [uniqueIndex("organizations_slug_uniq").on(t.slug)],
);

export type Organization = typeof organizationsTable.$inferSelect;
export type NewOrganization = typeof organizationsTable.$inferInsert;
