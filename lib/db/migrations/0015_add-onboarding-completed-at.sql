ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: every pre-existing account predates the onboarding flow,
-- so set their completion timestamp to created_at. New accounts get
-- a null and are routed to /onboarding on first sign-in.
UPDATE "users" SET "onboarding_completed_at" = "created_at" WHERE "onboarding_completed_at" IS NULL;