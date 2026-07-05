// Server-side Wikipedia access for extraction. All Wikimedia endpoints the
// functions touch live in this one module (same discipline as src/api.ts on
// the client): when the canonical API URLs change (announced for H2 2026),
// this file is the whole blast radius.

import { HttpError } from './http';

const USER_AGENT = 'WabbitHole/0.2 (https://wabbithole.io; gradyforrester3@gmail.com) extraction';

// Enough for ~4k tokens of input; the lead + early sections carry most of
// what good trivia needs.
const MAX_TEXT_CHARS = 12_000;

export interface ArticleSource {
  canonicalTitle: string; // underscore form
  displayTitle: string;
  description?: string;
  leadImage?: { url: string; sourcePage: string };
  text: string;
}

async function wikiFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, 'api-user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new HttpError(404, 'article_not_found');
  if (!res.ok) throw new HttpError(502, 'wikipedia_error', `Wikipedia responded ${res.status}`);
  return res;
}

export async function fetchArticleSource(lang: string, title: string): Promise<ArticleSource> {
  // Summary endpoint: canonical title (follows redirects), short description,
  // lead image with a file page we can attribute to.
  const summaryRes = await wikiFetch(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
  );
  const summary = (await summaryRes.json()) as {
    type?: string;
    titles?: { canonical?: string; normalized?: string };
    description?: string;
    extract?: string;
    originalimage?: { source?: string };
    content_urls?: { desktop?: { page?: string } };
  };
  if (summary.type === 'disambiguation') throw new HttpError(422, 'disambiguation_page');
  const canonicalTitle = summary.titles?.canonical;
  if (!canonicalTitle) throw new HttpError(404, 'article_not_found');
  const displayTitle = summary.titles?.normalized ?? canonicalTitle.replace(/_/g, ' ');

  // TextExtracts: whole-article plain text, no HTML parsing needed server-side.
  const extractRes = await wikiFetch(
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(canonicalTitle)}`,
  );
  const extractData = (await extractRes.json()) as {
    query?: { pages?: Array<{ missing?: boolean; extract?: string }> };
  };
  const page = extractData.query?.pages?.[0];
  if (!page || page.missing || !page.extract) throw new HttpError(404, 'article_not_found');

  let text = page.extract;
  if (text.length > MAX_TEXT_CHARS) {
    // Cut at the last paragraph boundary before the cap so the model never
    // sees a mid-sentence cliff.
    const slice = text.slice(0, MAX_TEXT_CHARS);
    const lastBreak = slice.lastIndexOf('\n');
    text = lastBreak > MAX_TEXT_CHARS / 2 ? slice.slice(0, lastBreak) : slice;
  }

  const imageUrl = summary.originalimage?.source;
  return {
    canonicalTitle,
    displayTitle,
    description: summary.description,
    leadImage: imageUrl ? { url: imageUrl, sourcePage: filePageFor(imageUrl) } : undefined,
    text,
  };
}

// upload.wikimedia.org/.../Some_file.jpg -> its file description page, where
// the image's own license and author live.
function filePageFor(imageUrl: string): string {
  const fileName = decodeURIComponent(imageUrl.split('/').pop() ?? '');
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`;
}

export function validLang(lang: unknown): lang is string {
  return typeof lang === 'string' && /^[a-z][a-z0-9-]{1,11}$/.test(lang);
}
