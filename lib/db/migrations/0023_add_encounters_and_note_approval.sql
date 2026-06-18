-- Phase 1a: encounters table + note approval state machine.
--
-- Strategy:
--   1. CREATE encounters
--   2. ADD nullable columns to notes + recording_jobs
--   3. Backfill: for every existing note, create a synthetic encounter
--      (visit_type='custom', label='Legacy note backfill') and link the
--      note to it. Also stamp approval metadata on legacy notes:
--      status='active' → 'approved', approved_at=createdAt,
--      approved_by_user_id=authorId, signed_note_hash=sha256(body).
--   4. ADD FK constraints. Validation passes because the backfill
--      already populated valid encounter ids.
--
-- pgcrypto provides the sha256 digest used for signed_note_hash. It is
-- enabled by default in modern Supabase but the CREATE EXTENSION is
-- idempotent and harmless on instances that already have it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- 1. encounters table.
CREATE TABLE "encounters" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"provider_id" text,
	"visit_type" text NOT NULL,
	"custom_label" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"is_telehealth" boolean DEFAULT false NOT NULL,
	"location" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 2. notes + recording_jobs nullable column additions. The default
--    flip on `status` (active → draft) applies only to new rows;
--    existing rows keep their stored value until the backfill below.
ALTER TABLE "notes" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "encounter_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "approved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "signed_note_hash" text;--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD COLUMN "encounter_id" text;--> statement-breakpoint

-- 3a. Create a synthetic encounter per legacy note. The encounter
--     inherits the note's organization + patient; provider falls
--     back to the note's authorId; timestamps mirror the note's
--     createdAt so the encounter appears at the right point on the
--     schedule view. `status='completed'` because the note already
--     exists — the encounter is closed by definition.
--
--     We insert into a temp table first to capture the (note_id,
--     encounter_id) mapping, then UPDATE notes in one pass.
CREATE TEMP TABLE _legacy_note_encounter_map AS
SELECT
    n."id" AS note_id,
    'enc_' || gen_random_uuid()::text AS encounter_id
FROM "notes" n
WHERE n."encounter_id" IS NULL;
--> statement-breakpoint

INSERT INTO "encounters" (
    "id", "organization_id", "patient_id", "provider_id", "visit_type",
    "custom_label", "status", "is_telehealth", "location",
    "scheduled_at", "started_at", "completed_at", "created_at", "updated_at"
)
SELECT
    m.encounter_id,
    n."organization_id",
    n."patient_id",
    n."author_id",
    'custom',
    'Legacy note backfill',
    'completed',
    false,
    NULL,
    n."created_at",
    n."created_at",
    n."created_at",
    n."created_at",
    n."created_at"
FROM _legacy_note_encounter_map m
JOIN "notes" n ON n."id" = m.note_id;
--> statement-breakpoint

-- 3b. Point each legacy note at its synthetic encounter.
UPDATE "notes" n
SET "encounter_id" = m.encounter_id
FROM _legacy_note_encounter_map m
WHERE n."id" = m.note_id;
--> statement-breakpoint

DROP TABLE _legacy_note_encounter_map;
--> statement-breakpoint

-- 3c. Approval-metadata backfill. Existing notes were treated as
--     final/signed by the previous code path, so we map:
--       status='active'           → status='approved'
--       status='entered-in-error' → unchanged
--     approved_at = createdAt (best available proxy)
--     approved_by_user_id = author_id (the only signer we know about)
--     signed_note_hash = sha256(body), hex
UPDATE "notes"
SET
    "status" = 'approved',
    "approved_at" = "created_at",
    "approved_by_user_id" = "author_id",
    "signed_note_hash" = encode(digest("body", 'sha256'), 'hex')
WHERE "status" = 'active';
--> statement-breakpoint

-- 3d. Any note already pushed to EHR is in the 'exported' terminal
--     state — keeps the status accurate to reality. ehrPushedAt was
--     the source of truth before; this just propagates it into the
--     new state column. Runs after the 'active' → 'approved' map so
--     pushed notes end up at 'exported' not 'approved'.
UPDATE "notes"
SET "status" = 'exported'
WHERE "ehr_pushed_at" IS NOT NULL AND "status" = 'approved';
--> statement-breakpoint

-- 4. FK constraints. Validation passes because every encounter_id we
--    just wrote points at a row we just inserted.
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD CONSTRAINT "recording_jobs_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;
