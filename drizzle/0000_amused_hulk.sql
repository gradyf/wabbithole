CREATE TABLE "article_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" integer NOT NULL,
	"type" text DEFAULT 'mc' NOT NULL,
	"prompt" text NOT NULL,
	"choices" jsonb NOT NULL,
	"answer_index" integer NOT NULL,
	"explanation" text NOT NULL,
	"image_url" text,
	"image_source_url" text,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"lang" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times_answered" integer DEFAULT 0 NOT NULL,
	"times_correct" integer DEFAULT 0 NOT NULL,
	"last_answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"clerk_user_id" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_questions" ADD CONSTRAINT "article_questions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_items" ADD CONSTRAINT "bank_items_question_id_article_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."article_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aq_article_version_idx" ON "article_questions" USING btree ("article_id","prompt_version");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_lang_title_idx" ON "articles" USING btree ("lang","title");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_user_question_idx" ON "bank_items" USING btree ("clerk_user_id","question_id");--> statement-breakpoint
CREATE INDEX "bank_user_idx" ON "bank_items" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_pending_lock" ON "extractions" USING btree ("article_id","prompt_version") WHERE "extractions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "extractions_user_time_idx" ON "extractions" USING btree ("clerk_user_id","created_at");