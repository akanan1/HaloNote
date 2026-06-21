CREATE TABLE "patient_problems" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"onset_date" text,
	"ehr_source" text NOT NULL,
	"ehr_resource_ref" text,
	"synced_at" timestamp with time zone,
	"raw_coding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_list_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"coding_session_id" text,
	"patient_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"action" text NOT NULL,
	"target_problem_id" text,
	"merge_from_problem_id" text,
	"proposed_code" text,
	"proposed_description" text,
	"proposed_status" text,
	"rationale" text NOT NULL,
	"supporting_excerpts" jsonb DEFAULT '[]' NOT NULL,
	"confidence" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"status_note" text,
	"applied_locally" boolean DEFAULT false NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_problems" ADD CONSTRAINT "patient_problems_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_problems" ADD CONSTRAINT "patient_problems_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_coding_session_id_encounter_coding_sessions_id_fk" FOREIGN KEY ("coding_session_id") REFERENCES "public"."encounter_coding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_target_problem_id_patient_problems_id_fk" FOREIGN KEY ("target_problem_id") REFERENCES "public"."patient_problems"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_merge_from_problem_id_patient_problems_id_fk" FOREIGN KEY ("merge_from_problem_id") REFERENCES "public"."patient_problems"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_list_suggestions" ADD CONSTRAINT "problem_list_suggestions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_problems_patient_code_uniq" ON "patient_problems" USING btree ("patient_id","code");--> statement-breakpoint
CREATE INDEX "patient_problems_org_status_idx" ON "patient_problems" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "problem_list_suggestions_session_idx" ON "problem_list_suggestions" USING btree ("coding_session_id");--> statement-breakpoint
CREATE INDEX "problem_list_suggestions_patient_idx" ON "problem_list_suggestions" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "problem_list_suggestions_org_status_idx" ON "problem_list_suggestions" USING btree ("organization_id","status","created_at");