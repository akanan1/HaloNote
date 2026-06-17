CREATE TABLE "provider_verbal_cues" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"phrase" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_jobs" ADD COLUMN "live_transcript" text;--> statement-breakpoint
ALTER TABLE "provider_verbal_cues" ADD CONSTRAINT "provider_verbal_cues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_verbal_cues" ADD CONSTRAINT "provider_verbal_cues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_verbal_cues_user_idx" ON "provider_verbal_cues" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_verbal_cues_user_phrase_uniq" ON "provider_verbal_cues" USING btree ("user_id",lower("phrase"));