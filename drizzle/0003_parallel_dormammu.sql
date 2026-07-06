CREATE TABLE "quiz_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"question_count" integer NOT NULL,
	"correct_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "quiz_sessions_user_time_idx" ON "quiz_sessions" USING btree ("clerk_user_id","played_at");