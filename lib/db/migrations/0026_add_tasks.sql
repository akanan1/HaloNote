CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" text,
	"source_note_id" text,
	"category" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"assigned_user_id" text,
	"created_by_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"rationale" text,
	"supporting_excerpts" jsonb DEFAULT '[]' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" text,
	"cancellation_reason" text,
	"is_closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_note_id_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_status_idx" ON "tasks" USING btree ("assigned_user_id","is_closed","due_at");--> statement-breakpoint
CREATE INDEX "tasks_patient_idx" ON "tasks" USING btree ("patient_id","is_closed");--> statement-breakpoint
CREATE INDEX "tasks_org_open_idx" ON "tasks" USING btree ("organization_id","is_closed","priority","due_at");