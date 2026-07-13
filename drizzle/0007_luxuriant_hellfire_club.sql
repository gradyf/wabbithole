CREATE TABLE "question_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_question_id_article_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."article_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_reports_user_question_idx" ON "question_reports" USING btree ("clerk_user_id","question_id");--> statement-breakpoint
CREATE INDEX "question_reports_question_idx" ON "question_reports" USING btree ("question_id");