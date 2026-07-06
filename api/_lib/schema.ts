// Drizzle schema for the trivia layer. Four tables; Clerk is the source of
// truth for users, so rows are keyed by clerk_user_id (no users table).

import { sql } from 'drizzle-orm';
import {
  boolean,
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

// One scored daily-race attempt per user per LOCAL date. race_date is the
// player's local YYYY-MM-DD day key (client-supplied, Wordle-style) — not a
// server timestamp — so the unique index enforces the game rule "first result
// of a date sticks" across devices. `won` is recorded because the client
// records misses too and streaks count wins only.
export const raceResults = pgTable(
  'race_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: text('clerk_user_id').notNull(),
    raceDate: text('race_date').notNull(), // player's LOCAL day key, YYYY-MM-DD
    startTitle: text('start_title').notNull(),
    targetTitle: text('target_title').notNull(),
    cards: integer('cards').notNull(),
    elapsedMs: integer('elapsed_ms').notNull(),
    won: boolean('won').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('race_user_date_idx').on(t.clerkUserId, t.raceDate),
    index('race_user_idx').on(t.clerkUserId),
  ],
);

// A saved trail is the linear card path (same {lang, title} nodes the URL hash
// encodes). Signed-in users keep a library of named trails plus one auto trail
// that resumes their last session; the partial unique index is what pins "one
// auto trail per user" (a bare boolean predicate, like extractions' lock).
export const trails = pgTable(
  'trails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: text('clerk_user_id').notNull(),
    title: text('title').notNull(),
    nodes: jsonb('nodes').$type<{ lang: string; title: string }[]>().notNull(),
    isAuto: boolean('is_auto').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trails_user_auto_idx').on(t.clerkUserId).where(sql`${t.isAuto}`),
    index('trails_user_idx').on(t.clerkUserId),
  ],
);
