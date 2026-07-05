// Link classification against live Parsoid 2.8.0 markup (matrix in REVIEW.md, Domain D).

import { normTitle } from './api';

export type LinkKind =
  | { kind: 'article'; title: string }
  | { kind: 'redlink' }
  | { kind: 'fragment'; frag: string }
  | { kind: 'external'; href: string }
  | { kind: 'wikipedia-page'; href: string }
  | { kind: 'none' };

const NAMESPACES = new Set(
  [
    'file', 'image', 'media', 'category', 'help', 'wikipedia', 'talk', 'special',
    'portal', 'template', 'draft', 'module', 'user', 'timedtext', 'book', 'wp',
    'project', 'mos',
  ],
);

function isNamespaced(title: string): boolean {
  const idx = title.indexOf(':');
  if (idx <= 0) return false;
  const prefix = title.slice(0, idx).toLowerCase().trim();
  return NAMESPACES.has(prefix) || prefix.endsWith(' talk');
}

export function classifyLink(
  a: HTMLAnchorElement,
  ctx: { lang: string; title: string },
): LinkKind {
  const raw = a.getAttribute('href') ?? '';
  if (!raw) return { kind: 'none' };
  const rel = a.getAttribute('rel') ?? '';

  if (raw.startsWith('#')) return { kind: 'fragment', frag: raw.slice(1) };

  if (rel.includes('mw:ExtLink') || rel.includes('mw:WikiLink/Interwiki') || rel.includes('mw:MediaLink')) {
    return { kind: 'external', href: a.href };
  }

  if (rel.includes('mw:WikiLink')) {
    if (a.classList.contains('new') || raw.includes('redlink=1')) return { kind: 'redlink' };

    // Parsoid form: ./Title, ./Title#fragment, ./Title?query
    const path = raw.replace(/^\.\//, '');
    const hashIdx = path.indexOf('#');
    const frag = hashIdx >= 0 ? path.slice(hashIdx + 1) : '';
    let titlePart = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
    titlePart = titlePart.split('?')[0];
    let title: string;
    try {
      title = normTitle(decodeURIComponent(titlePart));
    } catch {
      title = normTitle(titlePart);
    }
    if (!title) return frag ? { kind: 'fragment', frag } : { kind: 'none' };

    if (frag && title.toLowerCase() === normTitle(ctx.title).toLowerCase()) {
      return { kind: 'fragment', frag };
    }
    if (isNamespaced(title)) {
      return {
        kind: 'wikipedia-page',
        href: `https://${ctx.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      };
    }
    return { kind: 'article', title };
  }

  if (/^(https?:)?\/\//.test(raw)) return { kind: 'external', href: a.href };
  return { kind: 'none' };
}
