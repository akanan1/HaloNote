CREATE TABLE "approved_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"source_suggestion_id" text,
	"order_type" text NOT NULL,
	"name" text NOT NULL,
	"indication" text,
	"indication_diagnosis_code" text,
	"priority" text DEFAULT 'routine' NOT NULL,
	"instructions" text,
	"frequency" text,
	"duration" text,
	"medication_name" text,
	"medication_dose" text,
	"medication_route" text,
	"medication_frequency" text,
	"medication_duration" text,
	"medication_quantity" integer,
	"medication_refills" integer,
	"is_complete" boolean DEFAULT false NOT NULL,
	"safety_warnings" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"status_note" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"export_ready_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"order_type" text NOT NULL,
	"name" text NOT NULL,
	"indication" text,
	"indication_diagnosis_code" text,
	"priority" text DEFAULT 'routine' NOT NULL,
	"instructions" text,
	"frequency" text,
	"duration" text,
	"medication_name" text,
	"medication_dose" text,
	"medication_route" text,
	"medication_frequency" text,
	"medication_duration" text,
	"medication_quantity" integer,
	"medication_refills" integer,
	"is_complete" boolean DEFAULT false NOT NULL,
	"safety_warnings" jsonb DEFAULT '[]' NOT NULL,
	"rationale" text NOT NULL,
	"supporting_excerpts" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'ai_suggested' NOT NULL,
	"status_note" text,
	"created_by_ai" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approved_orders" ADD CONSTRAINT "approved_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_orders" ADD CONSTRAINT "approved_orders_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_orders" ADD CONSTRAINT "approved_orders_source_suggestion_id_order_suggestions_id_fk" FOREIGN KEY ("source_suggestion_id") REFERENCES "public"."order_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_orders" ADD CONSTRAINT "approved_orders_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_suggestions" ADD CONSTRAINT "order_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_suggestions" ADD CONSTRAINT "order_suggestions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approved_orders_encounter_idx" ON "approved_orders" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "approved_orders_org_status_idx" ON "approved_orders" USING btree ("organization_id","status","order_type");--> statement-breakpoint
CREATE INDEX "order_suggestions_encounter_idx" ON "order_suggestions" USING btree ("encounter_id","order_type","created_at");--> statement-breakpoint
CREATE INDEX "order_suggestions_org_status_idx" ON "order_suggestions" USING btree ("organization_id","status","order_type");