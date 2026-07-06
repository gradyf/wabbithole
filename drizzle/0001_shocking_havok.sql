CREATE TABLE "trails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"title" text NOT NULL,
	"nodes" jsonb NOT NULL,
	"is_auto" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trails_user_auto_idx" ON "trails" USING btree ("clerk_user_id") WHERE "trails"."is_auto";--> statement-breakpoint
CREATE INDEX "trails_user_idx" ON "trails" USING btree ("clerk_user_id");