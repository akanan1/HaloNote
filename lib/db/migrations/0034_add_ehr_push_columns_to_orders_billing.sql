ALTER TABLE "approved_billing_codes" ADD COLUMN "ehr_document_ref" text;--> statement-breakpoint
ALTER TABLE "approved_billing_codes" ADD COLUMN "ehr_error" text;--> statement-breakpoint
ALTER TABLE "approved_orders" ADD COLUMN "ehr_document_ref" text;--> statement-breakpoint
ALTER TABLE "approved_orders" ADD COLUMN "ehr_error" text;