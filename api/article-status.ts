// GET /api/article-status?lang=en&title=Okapi
// Signed-in card decoration: does this article already have questions in the
// shared cache, and how many are in the caller's bank? Pure DB lookup — no
// Wikipedia round trip, so callers must pass the canonical title.

import { and, eq, inArray } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, requireMethod } from './_lib/http.js';
import { PROMPT_VERSION } from './_lib/prompt.js';
import { articleQuestions, articles, bankItems } from './_lib/schema.js';
import { validLang } from './_lib/wikipedia.js';

export default handle(async (request) => {
  requireMethod(request, 'GET');
  const userId = await requireUser(request);

  const url = new URL(request.url);
  const lang = url.searchParams.get('lang');
  const title = url.searchParams.get('title')?.trim().replace(/ /g, '_');
  if (!validLang(lang) || !title) throw new HttpError(400, 'bad_request');

  const [article] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.lang, lang), eq(articles.title, title)));
  if (!article) return json({ hasQuestions: false, inBank: 0 });

  // Only the curated, visible pool decorates the card, so hasQuestions matches
  // exactly what a tier is served: extract-origin, not hidden. (Ad-hoc rows live
  // in the pool but never in the panel; hidden rows are moderated out.)
  const questions = await db
    .select({ id: articleQuestions.id })
    .from(articleQuestions)
    .where(
      and(
        eq(articleQuestions.articleId, article.id),
        eq(articleQuestions.promptVersion, PROMPT_VERSION),
        eq(articleQuestions.origin, 'extract'),
        eq(articleQuestions.hidden, false),
      ),
    );
  if (questions.length === 0) return json({ hasQuestions: false, inBank: 0 });

  const mine = await db
    .select({ id: bankItems.id })
    .from(bankItems)
    .where(
      and(
        eq(bankItems.clerkUserId, userId),
        inArray(
          bankItems.questionId,
          questions.map((q) => q.id),
        ),
      ),
    );
  return json({ hasQuestions: true, inBank: mine.length });
});
