CREATE TABLE "encounter_coding_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"note_id" text,
	"note_source" text NOT NULL,
	"source_note_hash" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"parsed_sections" jsonb,
	"extraction_started_at" timestamp with time zone,
	"extraction_completed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"writeback_started_at" timestamp with time zone,
	"writeback_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD COLUMN "was_edited_before_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "coding_session_id" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "source_section" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "destination_field" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "edited_code" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "edited_description" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "hcc_category" text;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD COLUMN "raf_relevant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_coding_sessions" ADD CONSTRAINT "encounter_coding_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_coding_sessions" ADD CONSTRAINT "encounter_coding_sessions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_coding_sessions" ADD CONSTRAINT "encounter_coding_sessions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_coding_sessions" ADD CONSTRAINT "encounter_coding_sessions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encounter_coding_sessions_encounter_idx" ON "encounter_coding_sessions" USING btree ("encounter_id","created_at");--> statement-breakpoint
CREATE INDEX "encounter_coding_sessions_org_status_idx" ON "encounter_coding_sessions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "billing_suggestions_session_idx" ON "billing_suggestions" USING btree ("coding_session_id","code_system");