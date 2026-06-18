CREATE TABLE "approved_billing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"code_system" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"source_suggestion_id" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"biller_approved_at" timestamp with time zone,
	"biller_approved_by_user_id" text,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"code_system" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"rationale" text NOT NULL,
	"supporting_excerpts" jsonb DEFAULT '[]' NOT NULL,
	"documentation_gaps" jsonb DEFAULT '[]' NOT NULL,
	"confidence" text NOT NULL,
	"status" text DEFAULT 'ai_suggested' NOT NULL,
	"created_by_ai" boolean DEFAULT true NOT NULL,
	"status_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD CONSTRAINT "approved_billing_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD CONSTRAINT "approved_billing_codes_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD CONSTRAINT "approved_billing_codes_source_suggestion_id_billing_suggestions_id_fk" FOREIGN KEY ("source_suggestion_id") REFERENCES "public"."billing_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD CONSTRAINT "approved_billing_codes_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD CONSTRAINT "approved_billing_codes_biller_approved_by_user_id_users_id_fk" FOREIGN KEY ("biller_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD CONSTRAINT "billing_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_suggestions" ADD CONSTRAINT "billing_suggestions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approved_billing_codes_encounter_idx" ON "approved_billing_codes" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "approved_billing_codes_org_idx" ON "approved_billing_codes" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_suggestions_encounter_idx" ON "billing_suggestions" USING btree ("encounter_id","code_system","created_at");--> statement-breakpoint
CREATE INDEX "billing_suggestions_org_status_idx" ON "billing_suggestions" USING btree ("organization_id","status","created_at");