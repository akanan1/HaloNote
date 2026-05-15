CREATE TABLE "recording_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"patient_id" text,
	"note_id" text,
	"status" text DEFAULT 'capturing' NOT NULL,
	"transcript" text,
	"structured_body" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recording_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_job_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD CONSTRAINT "recording_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD CONSTRAINT "recording_jobs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD CONSTRAINT "recording_jobs_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_recording_job_id_recording_jobs_id_fk" FOREIGN KEY ("recording_job_id") REFERENCES "public"."recording_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_jobs_user_status_idx" ON "recording_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "recording_jobs_patient_idx" ON "recording_jobs" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "recording_segments_job_ordinal_idx" ON "recording_segments" USING btree ("recording_job_id","ordinal");