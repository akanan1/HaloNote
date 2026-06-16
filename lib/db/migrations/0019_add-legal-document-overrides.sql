CREATE TABLE "legal_document_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"document_type" text NOT NULL,
	"version" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_document_overrides" ADD CONSTRAINT "legal_document_overrides_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_document_overrides_type_version_uniq" ON "legal_document_overrides" USING btree ("document_type","version");