// Drizzle schema for the trivia layer. Four tables; Clerk is the source of
// truth for users, so rows are keyed by clerk_user_id (no users table).

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const articles = pgTable(
  'articles',
  {
    id: serial('id').primaryKey(),
    lang: text('lang').notNull(),
    title: text('title').notNull(), // canonical title (underscore form)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('articles_lang_title_idx').on(t.lang, t.title)],
);

// Global question cache: the first extraction of an article pays the LLM
// call; every later user gets these rows for free.
export const articleQuestions = pgTable(
  'article_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: integer('article_id')
      .notNull()
      .references(() => articles.id),
    type: text('type').notNull().default('mc'),
    prompt: text('prompt').notNull(),
    choices: jsonb('choices').$type<string[]>().notNull(),
    answerIndex: integer('answer_index').notNull(),
    explanation: text('explanation').notNull(),
    imageUrl: text('image_url'),
    imageSourceUrl: text('image_source_url'),
    promptVersion: integer('prompt_version').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('aq_article_version_idx').on(t.articleId, t.promptVersion)],
);

// One row per extraction attempt: the partial unique index is the concurrency
// lock (one pending extraction per article+prompt version), and the rows are
// the audit trail behind the per-user daily cap.
export const extractions = pgTable(
  'extractions',
  {
    id: serial('id').primaryKey(),
    articleId: integer('article_id')
      .notNull()
      .references(() => articles.id),
    clerkUserId: text('clerk_user_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    status: text('status').notNull().default('pending'), // pending | done | failed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('extractions_pending_lock')
      .on(t.articleId, t.promptVersion)
      .where(sql`${t.status} = 'pending'`),
    index('extractions_user_time_idx').on(t.clerkUserId, t.createdAt),
  ],
);

export const bankItems = pgTable(
  'bank_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: text('clerk_user_id').notNull(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => articleQuestions.id),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    timesAnswered: integer('times_answered').notNull().default(0),
    timesCorrect: integer('times_correct').notNull().default(0),
    lastAnsweredAt: timestamp('last_answered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('bank_user_question_idx').on(t.clerkUserId, t.questionId),
    index('bank_user_idx').on(t.clerkUserId),
  ],
);
