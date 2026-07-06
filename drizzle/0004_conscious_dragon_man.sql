CREATE TABLE "generation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"article_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generation_log_time_idx" ON "generation_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "generation_log_user_time_idx" ON "generation_log" USING btree ("clerk_user_id","created_at");