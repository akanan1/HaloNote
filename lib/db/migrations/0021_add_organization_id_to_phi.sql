-- Multi-tenant retrofit: every PHI-bearing table gains an organization_id.
-- This migration is backfill-safe: it works on a fresh DB (no rows) and on
-- a DB with existing data (legacy rows are attached to a default org).
--
-- Strategy (per column):
--   1. ADD COLUMN as nullable
--   2. UPDATE existing rows from a join through the user → membership
--   3. ALTER COLUMN ... SET NOT NULL (skipped for audit_log: see below)
--   4. ADD CONSTRAINT FK
--
-- audit_log.organization_id stays nullable because system-originated
-- events (seed, cron, platform admin) have no tenant.
--
-- The default org is created with a fixed id so a re-run of this
-- migration against a snapshot DB is deterministic, and so test
-- harnesses can reference it by name.

-- ----------------------------------------------------------------------
-- 1. Seed a default organization for legacy data.
-- ----------------------------------------------------------------------
INSERT INTO "organizations" (
    "id", "name", "slug", "created_at"
) VALUES (
    'org_default', 'Default Organization', 'default', now()
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 2. Make every existing user a member of the default org.
--    Role assignment is conservative:
--      - users.is_founder = true        → org owner
--      - users.role = 'admin'           → org admin
--      - everyone else                  → org admin
--    (We give legacy members the higher org role rather than demoting
--    them — the operator can manually downgrade individuals afterward.
--    If there is no founder, the oldest user is promoted to owner so
--    the default org always has an owner.)
-- ----------------------------------------------------------------------
-- gen_random_uuid() is in core Postgres since 13. The 'om_' prefix
-- matches the id pattern $defaultFn applies at the TS layer; downstream
-- code that pattern-matches on the prefix keeps working.
INSERT INTO "organization_members" (
    "id", "organization_id", "user_id", "role", "is_active", "joined_at", "created_at", "updated_at"
)
SELECT
    'om_' || gen_random_uuid()::text,
    'org_default',
    u."id",
    CASE
        WHEN u."is_founder" = true THEN 'owner'
        ELSE 'admin'
    END,
    true,
    now(),
    now(),
    now()
FROM "users" u
WHERE NOT EXISTS (
    SELECT 1 FROM "organization_members" m
    WHERE m."organization_id" = 'org_default' AND m."user_id" = u."id"
);
--> statement-breakpoint

-- Ensure the default org has at least one owner. If no founder existed,
-- promote the oldest member to owner.
UPDATE "organization_members"
SET "role" = 'owner', "updated_at" = now()
WHERE "id" = (
    SELECT "id" FROM "organization_members"
    WHERE "organization_id" = 'org_default'
    ORDER BY "created_at" ASC
    LIMIT 1
)
AND NOT EXISTS (
    SELECT 1 FROM "organization_members"
    WHERE "organization_id" = 'org_default' AND "role" = 'owner'
);
--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 3. patients — drop global mrn unique first; add org_id; backfill; FK; new composite unique.
-- ----------------------------------------------------------------------
ALTER TABLE "patients" DROP CONSTRAINT IF EXISTS "patients_mrn_unique";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "patients" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_org_mrn_uniq" ON "patients" USING btree ("organization_id","mrn");--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 4. notes — backfill from the patient's organization (which we just set).
-- ----------------------------------------------------------------------
ALTER TABLE "notes" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "notes" n SET "organization_id" = p."organization_id"
    FROM "patients" p
    WHERE n."patient_id" = p."id" AND n."organization_id" IS NULL;--> statement-breakpoint
-- Notes with no patient (shouldn't exist in practice — patient_id is NOT NULL —
-- but guard anyway): assign to default org.
UPDATE "notes" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 5. recording_jobs — backfill from author (recording_jobs.user_id).
-- ----------------------------------------------------------------------
ALTER TABLE "recording_jobs" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "recording_jobs" r SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "recording_jobs" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD CONSTRAINT "recording_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 6. ehr_connections — backfill all to default org (single-tenant legacy).
-- ----------------------------------------------------------------------
ALTER TABLE "ehr_connections" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "ehr_connections" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "ehr_connections" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ehr_connections" ADD CONSTRAINT "ehr_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 7. note_templates / provider_phrase_mappings / provider_note_defaults —
--    backfill all to default org (legacy data is single-tenant).
-- ----------------------------------------------------------------------
ALTER TABLE "note_templates" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "note_templates" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "note_templates" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "note_templates" ADD CONSTRAINT "note_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "provider_phrase_mappings" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "provider_phrase_mappings" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_phrase_mappings" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_phrase_mappings" ADD CONSTRAINT "provider_phrase_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "provider_note_defaults" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "provider_note_defaults" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_note_defaults" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_note_defaults" ADD CONSTRAINT "provider_note_defaults_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 8. audit_log — nullable; backfill from user's default org membership
--    where one exists. Indexed by (organization_id, at) for tenant
--    rollups.
-- ----------------------------------------------------------------------
ALTER TABLE "audit_log" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "audit_log" a SET "organization_id" = 'org_default'
    WHERE a."user_id" IS NOT NULL AND a."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_at_idx" ON "audit_log" USING btree ("organization_id","at");--> statement-breakpoint

-- ----------------------------------------------------------------------
-- 9. sessions — add active_organization_id; backfill to default org for
--    every active session whose user has a default-org membership.
-- ----------------------------------------------------------------------
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
UPDATE "sessions" s SET "active_organization_id" = 'org_default'
    WHERE s."active_organization_id" IS NULL
      AND EXISTS (
          SELECT 1 FROM "organization_members" m
          WHERE m."user_id" = s."user_id"
            AND m."organization_id" = 'org_default'
            AND m."is_active" = true
      );--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
