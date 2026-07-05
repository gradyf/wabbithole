// Sanitize + transform Parsoid HTML into card-ready content (REVIEW.md Domain B).
// Pipeline: DOMPurify (defense-in-depth) -> detached transform -> adopt.
// Output classes follow the Wabbit Hole design system (.wh-prose scope;
// article.css styles both wh-* classes and raw Wikipedia classes).

import DOMPurify from 'dompurify';

export interface TocEntry {
  id: string;
  text: string;
  children: Array<{ id: string; text: string }>;
}

export interface ProcessedArticle {
  body: HTMLElement; // div.wh-prose, detached
  subtitle?: string;
  toc: TocEntry[];
}

const STRIP_SELECTORS = [
  '.navbox', '.navbox-styles', '.vertical-navbox',
  '.sidebar', // topic navigation sidebars (unstyled without TemplateStyles; hidden on mobile Wikipedia)
  '.toc', '.toclimit', // in-article TOC templates; the app synthesizes its own Contents
  '.hatnote', '[role="note"]',
  '.side-box', '.sistersitebox',
  '.ambox', '.mbox-small', // maintenance banners
  '.mw-empty-elt',
  'link', 'meta',
].join(',');

export function processArticle(raw: string): ProcessedArticle {
  const clean = DOMPurify.sanitize(raw, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    // The design system owns all styling; TemplateStyles would re-import
    // Wikipedia's look (also a trademark concern), so <style> is stripped.
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'noscript', 'input', 'select', 'textarea', 'style', 'audio', 'video', 'source', 'track'],
    ADD_TAGS: ['section', 'figure', 'figcaption'],
    ADD_ATTR: ['typeof', 'about', 'resource', 'rel', 'role', 'data-file-width', 'data-file-height'],
    // Parsoid values like rel="mw:WikiLink" look like unknown-scheme URIs to
    // DOMPurify's value validator and get stripped without this.
    ADD_URI_SAFE_ATTR: ['rel', 'typeof', 'about', 'resource'],
  }) as unknown as HTMLElement; // returns the <html> element for WHOLE_DOCUMENT

  const srcBody = clean.querySelector('body') ?? clean;
  const out = document.createElement('div');
  out.className = 'wh-prose';

  // Harvest the short description as the card subtitle, then drop it.
  const shortdesc = srcBody.querySelector('.shortdescription');
  const subtitle = shortdesc?.textContent?.trim() || undefined;
  shortdesc?.remove();

  for (const el of srcBody.querySelectorAll(STRIP_SELECTORS)) el.remove();

  // data-mw is 14-22% of payload bytes and unused at runtime.
  for (const el of srcBody.querySelectorAll('[data-mw]')) {
    el.removeAttribute('data-mw');
    el.removeAttribute('data-mw-i18n');
    el.removeAttribute('about');
  }

  // Link treatments: one class per behavior (colors live in ds/css/article.css).
  for (const a of srcBody.querySelectorAll('a')) {
    const rel = a.getAttribute('rel') ?? '';
    const href = a.getAttribute('href') ?? '';
    if (a.classList.contains('new') || href.includes('redlink=1')) {
      a.setAttribute('data-link', 'dead');
    } else if (
      rel.includes('mw:ExtLink') ||
      rel.includes('mw:WikiLink/Interwiki') ||
      rel.includes('mw:MediaLink')
    ) {
      a.setAttribute('data-link', 'ext');
    }
  }

  // Footnote markers and the reference list pick up design-system hooks.
  for (const sup of srcBody.querySelectorAll('sup.mw-ref')) sup.classList.add('wh-ref');
  for (const refs of srcBody.querySelectorAll('.mw-references-wrap')) refs.classList.add('wh-refs');

  for (const img of srcBody.querySelectorAll('img')) {
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }

  // Thumbnails float right at reading widths (figure.wh-thumb).
  for (const fig of srcBody.querySelectorAll('figure[typeof*="mw:File/Thumb"]')) {
    fig.classList.add('wh-thumb');
  }

  // Horizontal-overflow strategy: wide tables scroll inside their own box.
  for (const table of srcBody.querySelectorAll('table')) {
    if (table.classList.contains('infobox') || table.closest('.infobox') || table.closest('.wh-tablewrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'wh-tablewrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }

  // Perf: let the browser skip layout/paint of off-screen sections.
  for (const section of srcBody.querySelectorAll('section[data-mw-section-id]')) {
    (section as HTMLElement).style.contentVisibility = 'auto';
    (section as HTMLElement).style.containIntrinsicSize = 'auto 500px';
  }

  // Contents data: the article's own section headings (h2, with h3 children).
  const toc: TocEntry[] = [];
  for (const h of srcBody.querySelectorAll('section[data-mw-section-id] > h2[id], section[data-mw-section-id] > h3[id]')) {
    const text = h.textContent?.trim() ?? '';
    if (!text) continue;
    if (h.tagName === 'H2') {
      toc.push({ id: h.id, text, children: [] });
    } else if (toc.length > 0) {
      toc[toc.length - 1].children.push({ id: h.id, text });
    }
  }

  while (srcBody.firstChild) out.appendChild(srcBody.firstChild);
  return { body: out, subtitle, toc };
}
