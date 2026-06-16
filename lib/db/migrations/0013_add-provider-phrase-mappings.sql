CREATE TABLE "provider_phrase_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"spoken" text NOT NULL,
	"documented" text NOT NULL,
	"sort_order" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_phrase_mappings" ADD CONSTRAINT "provider_phrase_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_phrase_mappings_user_order_idx" ON "provider_phrase_mappings" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_phrase_mappings_user_spoken_uniq" ON "provider_phrase_mappings" USING btree ("user_id",lower("spoken"));