CREATE TABLE "appointment_claims" (
	"organization_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "appointment_claims_organization_id_appointment_id_pk" PRIMARY KEY("organization_id","appointment_id")
);
--> statement-breakpoint
ALTER TABLE "appointment_claims" ADD CONSTRAINT "appointment_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_claims" ADD CONSTRAINT "appointment_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_claims" ADD CONSTRAINT "appointment_claims_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_claims_user_idx" ON "appointment_claims" USING btree ("organization_id","user_id");