// Server-side Wikipedia access for extraction. All Wikimedia endpoints the
// functions touch live in this one module (same discipline as src/api.ts on
// the client): when the canonical API URLs change (announced for H2 2026),
// this file is the whole blast radius.

import { HttpError } from './http.js';

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
  return filePageForName(fileName);
}

function filePageForName(fileName: string): string {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`;
}

export function validLang(lang: unknown): lang is string {
  return typeof lang === 'string' && /^[a-z][a-z0-9-]{1,11}$/.test(lang);
}

// A client-detected flag image, validated server-side before it can seed the
// communal pool. imageUrl is the exact string echoed to the model and stored;
// sourceUrl is the file-description page for attribution, DERIVED here (never
// trusted from the client).
export interface ValidatedFlag {
  imageUrl: string;
  sourceUrl: string;
}

// Validate a client flag hint on cache-miss. All three gates must pass or the
// hint is ignored (returns null; extraction proceeds flagless, no error):
//   1. https host is exactly upload.wikimedia.org (no arbitrary image host),
//   2. the base filename matches /Flag[_ ]of/i,
//   3. a prop=images membership check confirms the file is actually on the page
//      (a real-looking URL that belongs to another page is rejected).
// Any thrown error (malformed URL, network failure) resolves to null silently —
// a forged or broken hint never blocks or errors the extraction.
export async function validateFlagHint(
  lang: string,
  canonicalTitle: string,
  hint: unknown,
): Promise<ValidatedFlag | null> {
  try {
    if (typeof hint !== 'object' || hint === null) return null;
    const imageUrl = (hint as { imageUrl?: unknown }).imageUrl;
    if (typeof imageUrl !== 'string') return null;
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:' || url.host !== 'upload.wikimedia.org') return null;
    const fileName = baseFileName(url);
    if (!/Flag[_ ]of/i.test(fileName)) return null;
    if (!(await pageHasImage(lang, canonicalTitle, fileName))) return null;
    return { imageUrl, sourceUrl: filePageForName(fileName) };
  } catch {
    return null;
  }
}

// The base File name behind an upload URL. Thumbnails nest it one segment above
// the rendered size (/thumb/a/ab/Base.svg/250px-Base.svg.png -> Base.svg);
// direct URLs put it last (/commons/a/ab/Base.svg -> Base.svg).
function baseFileName(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.indexOf('thumb') !== -1 && parts.length >= 2) {
    return decodeURIComponent(parts[parts.length - 2]);
  }
  return decodeURIComponent(parts[parts.length - 1] ?? '');
}

// action-API prop=images membership check: is this file listed on the page?
// prop=images returns titles like "File:Flag of France.svg" (spaces); upload
// URLs use underscores, so compare on a normalized bare filename.
async function pageHasImage(lang: string, canonicalTitle: string, fileName: string): Promise<boolean> {
  const res = await wikiFetch(
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=images&imlimit=max&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(canonicalTitle)}`,
  );
  const data = (await res.json()) as {
    query?: { pages?: Array<{ images?: Array<{ title?: string }> }> };
  };
  const images = data.query?.pages?.[0]?.images ?? [];
  const target = normalizeFileName(fileName);
  return images.some((img) => normalizeFileName((img.title ?? '').replace(/^File:/i, '')) === target);
}

function normalizeFileName(name: string): string {
  return name.replace(/_/g, ' ').trim().toLowerCase();
}
