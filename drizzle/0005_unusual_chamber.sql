ALTER TABLE "article_questions" ADD COLUMN "rank" smallint;--> statement-breakpoint
ALTER TABLE "article_questions" ADD COLUMN "origin" text DEFAULT 'extract' NOT NULL;--> statement-breakpoint
ALTER TABLE "article_questions" ADD COLUMN "selection_hash" text;--> statement-breakpoint
ALTER TABLE "article_questions" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "article_questions" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "aq_adhoc_selection_idx" ON "article_questions" USING btree ("article_id","selection_hash") WHERE "article_questions"."origin" = 'adhoc';--> statement-breakpoint
CREATE INDEX "aq_created_by_idx" ON "article_questions" USING btree ("created_by","created_at") WHERE "article_questions"."origin" = 'adhoc';