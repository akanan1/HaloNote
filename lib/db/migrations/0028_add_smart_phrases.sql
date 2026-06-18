CREATE TABLE "smart_phrases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"shortcut" text NOT NULL,
	"body" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "smart_phrases" ADD CONSTRAINT "smart_phrases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_phrases" ADD CONSTRAINT "smart_phrases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smart_phrases_user_idx" ON "smart_phrases" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_phrases_user_shortcut_uniq" ON "smart_phrases" USING btree ("user_id",lower("shortcut"));