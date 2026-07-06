CREATE TABLE "race_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"race_date" text NOT NULL,
	"start_title" text NOT NULL,
	"target_title" text NOT NULL,
	"cards" integer NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"won" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "race_user_date_idx" ON "race_results" USING btree ("clerk_user_id","race_date");--> statement-breakpoint
CREATE INDEX "race_user_idx" ON "race_results" USING btree ("clerk_user_id");