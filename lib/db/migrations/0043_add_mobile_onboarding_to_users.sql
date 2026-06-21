ALTER TABLE "users" ADD COLUMN "auto_approve_non_med_orders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mobile_onboarded_at" timestamp with time zone;