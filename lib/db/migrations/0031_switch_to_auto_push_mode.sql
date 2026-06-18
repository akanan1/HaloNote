-- Replace the boolean auto_push_to_ehr with the 3-way enum
-- auto_push_mode. Backfill so a true → "after_approve" and false → "off",
-- preserving any opt-ins that landed via Phase 21.
ALTER TABLE "users" ADD COLUMN "auto_push_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "auto_push_mode" = CASE WHEN "auto_push_to_ehr" THEN 'after_approve' ELSE 'off' END;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auto_push_to_ehr";
